package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"yaerp/internal/model"
)

type SheetRepo struct {
	db *sql.DB
}

func NewSheetRepo(db *sql.DB) *SheetRepo {
	return &SheetRepo{db: db}
}

// ---------------------------------------------------------------------------
// Workbook CRUD
// ---------------------------------------------------------------------------

func (r *SheetRepo) CreateWorkbook(wb *model.Workbook) error {
	now := time.Now()
	err := r.db.QueryRow(
		`INSERT INTO workbooks (name, description, owner_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		wb.Name, wb.Description, wb.OwnerID, now, now,
	).Scan(&wb.ID)
	if err != nil {
		return fmt.Errorf("create workbook: %w", err)
	}
	wb.CreatedAt = now
	wb.UpdatedAt = now
	return nil
}

func (r *SheetRepo) GetWorkbook(id int64) (*model.Workbook, error) {
	var wb model.Workbook
	err := r.db.QueryRow(
		`SELECT id, name, description, owner_id, created_at, updated_at
		 FROM workbooks WHERE id = $1`, id,
	).Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.CreatedAt, &wb.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("workbook %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get workbook: %w", err)
	}
	return &wb, nil
}

func (r *SheetRepo) ListWorkbooks(ownerID int64, page, size int) ([]model.Workbook, int64, error) {
	var total int64
	err := r.db.QueryRow(
		`SELECT COUNT(*) FROM workbooks WHERE owner_id = $1`, ownerID,
	).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("count workbooks: %w", err)
	}

	offset := (page - 1) * size
	rows, err := r.db.Query(
		`SELECT id, name, description, owner_id, created_at, updated_at
		 FROM workbooks WHERE owner_id = $1
		 ORDER BY id LIMIT $2 OFFSET $3`, ownerID, size, offset,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("list workbooks: %w", err)
	}
	defer rows.Close()

	wbs := make([]model.Workbook, 0)
	for rows.Next() {
		var wb model.Workbook
		if err := rows.Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.CreatedAt, &wb.UpdatedAt); err != nil {
			return nil, 0, fmt.Errorf("scan workbook: %w", err)
		}
		wbs = append(wbs, wb)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate workbooks: %w", err)
	}
	return wbs, total, nil
}

func (r *SheetRepo) UpdateWorkbook(wb *model.Workbook) error {
	wb.UpdatedAt = time.Now()
	result, err := r.db.Exec(
		`UPDATE workbooks SET name = $1, description = $2, updated_at = $3
		 WHERE id = $4`,
		wb.Name, wb.Description, wb.UpdatedAt, wb.ID,
	)
	if err != nil {
		return fmt.Errorf("update workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("workbook %d not found", wb.ID)
	}
	return nil
}

func (r *SheetRepo) DeleteWorkbook(id int64) error {
	result, err := r.db.Exec(`DELETE FROM workbooks WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("workbook %d not found", id)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Sheet CRUD
// ---------------------------------------------------------------------------

func (r *SheetRepo) CreateSheet(s *model.Sheet) error {
	now := time.Now()
	err := r.db.QueryRow(
		`INSERT INTO sheets (workbook_id, name, sort_order, columns, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 RETURNING id, frozen, config`,
		s.WorkbookID, s.Name, s.SortOrder, s.Columns, now, now,
	).Scan(&s.ID, &s.Frozen, &s.Config)
	if err != nil {
		return fmt.Errorf("create sheet: %w", err)
	}
	s.CreatedAt = now
	s.UpdatedAt = now
	return nil
}

func (r *SheetRepo) GetSheet(id int64) (*model.Sheet, error) {
	var s model.Sheet
	err := r.db.QueryRow(
		`SELECT id, workbook_id, name, sort_order, columns, frozen, config, created_at, updated_at
		 FROM sheets WHERE id = $1`, id,
	).Scan(&s.ID, &s.WorkbookID, &s.Name, &s.SortOrder, &s.Columns, &s.Frozen, &s.Config, &s.CreatedAt, &s.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sheet %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get sheet: %w", err)
	}
	return &s, nil
}

func (r *SheetRepo) UpdateSheet(s *model.Sheet) error {
	s.UpdatedAt = time.Now()
	result, err := r.db.Exec(
		`UPDATE sheets SET name = $1, sort_order = $2, columns = $3, frozen = $4, config = $5, updated_at = $6
		 WHERE id = $7`,
		s.Name, s.SortOrder, s.Columns, s.Frozen, s.Config, s.UpdatedAt, s.ID,
	)
	if err != nil {
		return fmt.Errorf("update sheet: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("sheet %d not found", s.ID)
	}
	return nil
}

func (r *SheetRepo) DeleteSheet(id int64) error {
	result, err := r.db.Exec(`DELETE FROM sheets WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete sheet: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("sheet %d not found", id)
	}
	return nil
}

func (r *SheetRepo) GetSheetsByWorkbook(workbookID int64) ([]model.Sheet, error) {
	rows, err := r.db.Query(
		`SELECT id, workbook_id, name, sort_order, columns, frozen, config, created_at, updated_at
		 FROM sheets WHERE workbook_id = $1
		 ORDER BY sort_order, id`, workbookID,
	)
	if err != nil {
		return nil, fmt.Errorf("get sheets by workbook: %w", err)
	}
	defer rows.Close()

	sheets := make([]model.Sheet, 0)
	for rows.Next() {
		var s model.Sheet
		if err := rows.Scan(&s.ID, &s.WorkbookID, &s.Name, &s.SortOrder, &s.Columns, &s.Frozen, &s.Config, &s.CreatedAt, &s.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan sheet: %w", err)
		}
		sheets = append(sheets, s)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate sheets: %w", err)
	}
	return sheets, nil
}

// ---------------------------------------------------------------------------
// Row operations
// ---------------------------------------------------------------------------

func (r *SheetRepo) UpsertRow(sheetID int64, rowIndex int, data json.RawMessage, userID int64) error {
	now := time.Now()
	_, err := r.db.Exec(
		`INSERT INTO rows (sheet_id, row_index, data, updated_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (sheet_id, row_index)
		 DO UPDATE SET data = $3, updated_by = $4, updated_at = $6`,
		sheetID, rowIndex, data, userID, now, now,
	)
	if err != nil {
		return fmt.Errorf("upsert row: %w", err)
	}
	return nil
}

func (r *SheetRepo) GetRows(sheetID int64) ([]model.Row, error) {
	rows, err := r.db.Query(
		`SELECT id, sheet_id, row_index, data, updated_by, created_at, updated_at
		 FROM rows WHERE sheet_id = $1
		 ORDER BY row_index`, sheetID,
	)
	if err != nil {
		return nil, fmt.Errorf("get rows: %w", err)
	}
	defer rows.Close()

	result := make([]model.Row, 0)
	for rows.Next() {
		var row model.Row
		if err := rows.Scan(
			&row.ID, &row.SheetID, &row.RowIndex, &row.Data,
			&row.UpdatedBy, &row.CreatedAt, &row.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		result = append(result, row)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rows: %w", err)
	}
	return result, nil
}

func (r *SheetRepo) DeleteRow(sheetID int64, rowIndex int) error {
	const rowShiftOffset = 1000000

	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`DELETE FROM rows WHERE sheet_id = $1 AND row_index = $2`,
		sheetID, rowIndex,
	)
	if err != nil {
		return fmt.Errorf("delete row: %w", err)
	}

	// Move following rows out of the unique-key range first, then shift back.
	_, err = tx.Exec(
		`UPDATE rows SET row_index = row_index + $3
		 WHERE sheet_id = $1 AND row_index > $2`,
		sheetID, rowIndex, rowShiftOffset,
	)
	if err != nil {
		return fmt.Errorf("shift rows after delete: %w", err)
	}

	_, err = tx.Exec(
		`UPDATE rows SET row_index = row_index - $3 - 1
		 WHERE sheet_id = $1 AND row_index > ($2::int + $3::int)`,
		sheetID, rowIndex, rowShiftOffset,
	)
	if err != nil {
		return fmt.Errorf("finalize delete row shift: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func (r *SheetRepo) InsertRow(sheetID int64, afterRow int) error {
	const rowShiftOffset = 1000000

	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(
		`UPDATE rows SET row_index = row_index + $3
		 WHERE sheet_id = $1 AND row_index > $2
		`,
		sheetID, afterRow, rowShiftOffset,
	)
	if err != nil {
		return fmt.Errorf("shift rows for insert: %w", err)
	}

	_, err = tx.Exec(
		`UPDATE rows SET row_index = row_index - $3 + 1
		 WHERE sheet_id = $1 AND row_index > ($2::int + $3::int)`,
		sheetID, afterRow, rowShiftOffset,
	)
	if err != nil {
		return fmt.Errorf("finalize insert row shift: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (r *SheetRepo) GetSheetData(sheetID int64) ([]model.Row, error) {
	return r.GetRows(sheetID)
}
