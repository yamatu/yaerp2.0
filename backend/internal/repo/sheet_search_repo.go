package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/lib/pq"
	"yaerp/internal/model"
)

// GetSearchSheets reads structure and protection/lifecycle rules, not the large
// Univer cell/style snapshot. Content is searched in PostgreSQL separately.
func (r *SheetRepo) GetSearchSheets(workbookID int64) ([]model.Sheet, error) {
	result, err := r.db.Query(`SELECT id, workbook_id, name, sort_order, columns,
		COALESCE(config, '{}'::jsonb) - 'univerSheetData' - 'univerStyles', created_at, updated_at
		FROM sheets WHERE workbook_id = $1 ORDER BY sort_order, id`, workbookID)
	if err != nil {
		return nil, fmt.Errorf("list search sheets: %w", err)
	}
	defer result.Close()
	sheets := make([]model.Sheet, 0)
	for result.Next() {
		var sheet model.Sheet
		if err := result.Scan(&sheet.ID, &sheet.WorkbookID, &sheet.Name, &sheet.SortOrder,
			&sheet.Columns, &sheet.Config, &sheet.CreatedAt, &sheet.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan search sheet: %w", err)
		}
		sheets = append(sheets, sheet)
	}
	return sheets, result.Err()
}

// GetSearchSheet omits cell/style payloads but retains all access-control rules.
func (r *SheetRepo) GetSearchSheet(sheetID int64) (*model.Sheet, error) {
	var sheet model.Sheet
	err := r.db.QueryRow(`SELECT id, workbook_id, name, sort_order, columns,
		COALESCE(config, '{}'::jsonb) - 'univerSheetData' - 'univerStyles', created_at, updated_at
		FROM sheets WHERE id = $1`, sheetID).Scan(&sheet.ID, &sheet.WorkbookID, &sheet.Name,
		&sheet.SortOrder, &sheet.Columns, &sheet.Config, &sheet.CreatedAt, &sheet.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sheet %d not found", sheetID)
	}
	if err != nil {
		return nil, fmt.Errorf("get search sheet: %w", err)
	}
	return &sheet, nil
}

type SheetContentQuery struct {
	SheetID           int64
	OrderedColumnKeys []string // snapshot's numeric column index -> column key
	ColumnKeys        []string // optional match restriction
	Keywords          []string
	MatchAll          bool
	StartRow          int // normalized, 0-based data row (not a LIMIT offset)
	Limit             int
}

type SheetContentRow struct {
	Row       int
	SourceRow int
	Data      json.RawMessage
}

// searchSheetContentSQL implements buildAIPreviewRows' merge semantics at the
// database boundary. Web edits live only in config.univerSheetData; searching
// rows alone would miss those edits, and ignoring the overlay would return stale
// values. Partial snapshots override only the cells they actually materialize.
// All values/patterns are parameters; LIKE wildcards in keywords are escaped.
const searchSheetContentSQL = `
WITH target AS (
    SELECT s.config #> '{univerSheetData,cellData}' AS cells
    FROM sheets s JOIN workbooks w ON w.id = s.workbook_id
    WHERE s.id = $1 AND w.deleted_at IS NULL
), row_base AS (
    SELECT COALESCE(MIN(row_index), 0) AS base FROM rows WHERE sheet_id = $1
), stored AS MATERIALIZED (
    SELECT r.row_index AS source_row, r.row_index - b.base AS row_num,
           CASE WHEN jsonb_typeof(r.data) = 'object' THEN r.data ELSE '{}'::jsonb END AS data
    FROM rows r CROSS JOIN row_base b CROSS JOIN target
    WHERE r.sheet_id = $1
), snapshot_values AS (
    SELECT COALESCE(stored.row_num, rp.source_row) AS row_num, rp.source_row,
           ($2::text[])[cp.col_index + 1] AS column_key,
           CASE
               WHEN jsonb_typeof(cell.value) <> 'object' THEN cell.value
               WHEN cell.value ? 'v' AND cell.value->'v' <> 'null'::jsonb THEN cell.value->'v'
               WHEN jsonb_typeof(cell.value->'f') = 'string' AND btrim(cell.value->>'f') <> ''
                   THEN to_jsonb(CASE WHEN left(btrim(cell.value->>'f'), 1) = '='
                       THEN btrim(cell.value->>'f') ELSE '=' || btrim(cell.value->>'f') END)
               ELSE NULL
           END AS cell_value
    FROM target t
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(t.cells) = 'object'
        THEN t.cells ELSE '{}'::jsonb END) AS sr(key, value)
    CROSS JOIN LATERAL (SELECT CASE WHEN sr.key ~ '^[0-9]{1,9}$'
        THEN sr.key::integer - 1 ELSE -1 END AS source_row) rp
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(sr.value) = 'object'
        THEN sr.value ELSE '{}'::jsonb END) AS cell(key, value)
    CROSS JOIN LATERAL (SELECT CASE WHEN cell.key ~ '^[0-9]{1,9}$'
        THEN cell.key::integer ELSE -1 END AS col_index) cp
    LEFT JOIN stored ON stored.source_row = rp.source_row
    WHERE rp.source_row >= 0 AND cp.col_index >= 0 AND cp.col_index < cardinality($2::text[])
), snapshot AS (
    SELECT row_num, MAX(source_row) AS source_row,
           jsonb_object_agg(column_key, cell_value ORDER BY source_row) AS data
    FROM snapshot_values WHERE cell_value IS NOT NULL GROUP BY row_num
), effective AS (
    SELECT COALESCE(sn.row_num, st.row_num) AS row_num,
           COALESCE(sn.source_row, st.source_row) AS source_row,
           COALESCE(st.data, '{}'::jsonb) || COALESCE(sn.data, '{}'::jsonb) AS data
    FROM stored st FULL OUTER JOIN snapshot sn ON sn.row_num = st.row_num
)
SELECT e.row_num, e.source_row, e.data
FROM effective e
WHERE e.row_num >= $3
  AND EXISTS (
      SELECT 1 FROM jsonb_each_text(e.data) AS cell(key, value)
      WHERE (cardinality($6::text[]) = 0 OR cell.key = ANY($6::text[]))
        AND COALESCE(cell.value, '<nil>') ILIKE ANY($4::text[])
  )
  AND (NOT $5 OR NOT EXISTS (
      SELECT 1 FROM unnest($4::text[]) AS needle(pattern)
      WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_each_text(e.data) AS cell(key, value)
          WHERE (cardinality($6::text[]) = 0 OR cell.key = ANY($6::text[]))
            AND COALESCE(cell.value, '<nil>') ILIKE needle.pattern
      )
  ))
ORDER BY e.row_num
LIMIT $7`

func escapeSheetSearchLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

// SearchSheetContent transfers only a bounded page of matching effective rows,
// never the entire sheet. Callers must still filter permissions and recheck the
// match on the visible subset, and paginate past redacted candidates.
func (r *SheetRepo) SearchSheetContent(query SheetContentQuery) ([]SheetContentRow, error) {
	if query.SheetID <= 0 || len(query.Keywords) == 0 {
		return nil, fmt.Errorf("sheet_id and keywords are required")
	}
	patterns := make([]string, 0, len(query.Keywords))
	for _, keyword := range query.Keywords {
		if keyword = strings.TrimSpace(keyword); keyword != "" {
			patterns = append(patterns, "%"+escapeSheetSearchLike(keyword)+"%")
		}
	}
	if len(patterns) == 0 {
		return nil, fmt.Errorf("non-empty keywords are required")
	}
	if query.StartRow < 0 {
		query.StartRow = 0
	}
	if query.Limit <= 0 {
		query.Limit = 80
	}
	if query.Limit > 500 {
		query.Limit = 500
	}
	// pq encodes a nil slice as SQL NULL, but the column filter needs an empty
	// array (cardinality=0) to mean all columns.
	if query.ColumnKeys == nil {
		query.ColumnKeys = []string{}
	}
	rows, err := r.db.Query(searchSheetContentSQL, query.SheetID, pq.Array(query.OrderedColumnKeys),
		query.StartRow, pq.Array(patterns), query.MatchAll, pq.Array(query.ColumnKeys), query.Limit)
	if err != nil {
		return nil, fmt.Errorf("search effective sheet rows: %w", err)
	}
	defer rows.Close()
	result := make([]SheetContentRow, 0, query.Limit)
	for rows.Next() {
		var row SheetContentRow
		if err := rows.Scan(&row.Row, &row.SourceRow, &row.Data); err != nil {
			return nil, fmt.Errorf("scan sheet search row: %w", err)
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
