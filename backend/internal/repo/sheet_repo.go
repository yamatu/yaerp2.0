package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
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
	metadata := wb.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	status := wb.Status
	if status == 0 {
		status = 1
	}
	err := r.db.QueryRow(
		`INSERT INTO workbooks (name, description, owner_id, folder_id, metadata, is_template, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		 RETURNING id`,
		wb.Name, wb.Description, wb.OwnerID, wb.FolderID, metadata, wb.IsTemplate, status, now, now,
	).Scan(&wb.ID)
	if err != nil {
		return fmt.Errorf("create workbook: %w", err)
	}
	wb.Metadata = metadata
	wb.Status = status
	wb.CreatedAt = now
	wb.UpdatedAt = now
	return nil
}

func (r *SheetRepo) ListWorkbookNames(ownerID int64, folderID *int64) ([]string, error) {
	rows, err := r.db.Query(
		`SELECT name
		 FROM workbooks
		 WHERE owner_id = $1 AND folder_id IS NOT DISTINCT FROM $2
		 ORDER BY id`,
		ownerID, folderID,
	)
	if err != nil {
		return nil, fmt.Errorf("list workbook names: %w", err)
	}
	defer rows.Close()

	names := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, fmt.Errorf("scan workbook name: %w", err)
		}
		names = append(names, name)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workbook names: %w", err)
	}
	return names, nil
}

func (r *SheetRepo) DuplicateWorkbook(sourceWorkbookID int64, clone *model.Workbook, actorID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin duplicate workbook: %w", err)
	}
	defer tx.Rollback()

	var sourceExists int
	if err := tx.QueryRow(`SELECT 1 FROM workbooks WHERE id = $1 FOR SHARE`, sourceWorkbookID).Scan(&sourceExists); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("workbook %d not found", sourceWorkbookID)
		}
		return fmt.Errorf("lock source workbook: %w", err)
	}

	now := time.Now()
	metadata := clone.Metadata
	if len(metadata) == 0 {
		metadata = json.RawMessage(`{}`)
	}
	status := clone.Status
	if status == 0 {
		status = 1
	}
	if err := tx.QueryRow(
		`INSERT INTO workbooks (name, description, owner_id, folder_id, metadata, is_template, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8)
		 RETURNING id`,
		clone.Name, clone.Description, clone.OwnerID, clone.FolderID, metadata, clone.IsTemplate, status, now,
	).Scan(&clone.ID); err != nil {
		return fmt.Errorf("create duplicated workbook: %w", err)
	}

	type sourceSheet struct {
		id        int64
		name      string
		sortOrder int
	}
	sourceRows, err := tx.Query(
		`SELECT id, name, sort_order
		 FROM sheets
		 WHERE workbook_id = $1
		 ORDER BY sort_order, id`,
		sourceWorkbookID,
	)
	if err != nil {
		return fmt.Errorf("list source workbook sheets: %w", err)
	}
	sourceSheets := make([]sourceSheet, 0)
	for sourceRows.Next() {
		var item sourceSheet
		if err := sourceRows.Scan(&item.id, &item.name, &item.sortOrder); err != nil {
			sourceRows.Close()
			return fmt.Errorf("scan source workbook sheet: %w", err)
		}
		sourceSheets = append(sourceSheets, item)
	}
	if err := sourceRows.Err(); err != nil {
		sourceRows.Close()
		return fmt.Errorf("iterate source workbook sheets: %w", err)
	}
	if err := sourceRows.Close(); err != nil {
		return fmt.Errorf("close source workbook sheets: %w", err)
	}

	for _, source := range sourceSheets {
		if _, err := duplicateSheetTx(tx, source.id, clone.ID, source.name, source.sortOrder, actorID, now); err != nil {
			return fmt.Errorf("duplicate sheet %d: %w", source.id, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit duplicate workbook: %w", err)
	}
	clone.Metadata = metadata
	clone.Status = status
	clone.CreatedAt = now
	clone.UpdatedAt = now
	return nil
}

func (r *SheetRepo) GetWorkbook(id int64) (*model.Workbook, error) {
	var wb model.Workbook
	err := r.db.QueryRow(
		`SELECT w.id, w.name, w.description, w.owner_id, u.username, w.folder_id, w.metadata, w.is_template, w.status, w.created_at, w.updated_at
		 FROM workbooks w
		 LEFT JOIN users u ON u.id = w.owner_id
		 WHERE w.id = $1`, id,
	).Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.OwnerName, &wb.FolderID, &wb.Metadata, &wb.IsTemplate, &wb.Status, &wb.CreatedAt, &wb.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("workbook %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get workbook: %w", err)
	}
	return &wb, nil
}

func (r *SheetRepo) ListWorkbooks(ownerID *int64, page, size int) ([]model.Workbook, int64, error) {
	var total int64
	countQuery := `SELECT COUNT(*) FROM workbooks`
	countArgs := make([]interface{}, 0, 1)
	if ownerID != nil {
		countQuery += ` WHERE owner_id = $1`
		countArgs = append(countArgs, *ownerID)
	}
	err := r.db.QueryRow(countQuery, countArgs...).Scan(&total)
	if err != nil {
		return nil, 0, fmt.Errorf("count workbooks: %w", err)
	}

	offset := (page - 1) * size
	query := `SELECT w.id, w.name, w.description, w.owner_id, u.username, w.folder_id, w.metadata, w.is_template, w.status, w.created_at, w.updated_at
		 FROM workbooks w
		 LEFT JOIN users u ON u.id = w.owner_id`
	args := make([]interface{}, 0, 3)
	if ownerID != nil {
		query += ` WHERE w.owner_id = $1`
		args = append(args, *ownerID)
		query += ` ORDER BY w.updated_at DESC, w.id DESC LIMIT $2 OFFSET $3`
		args = append(args, size, offset)
	} else {
		query += ` ORDER BY w.updated_at DESC, w.id DESC LIMIT $1 OFFSET $2`
		args = append(args, size, offset)
	}
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list workbooks: %w", err)
	}
	defer rows.Close()

	wbs := make([]model.Workbook, 0)
	for rows.Next() {
		var wb model.Workbook
		if err := rows.Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.OwnerName, &wb.FolderID, &wb.Metadata, &wb.IsTemplate, &wb.Status, &wb.CreatedAt, &wb.UpdatedAt); err != nil {
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
		`UPDATE workbooks SET name = $1, description = $2, metadata = $3, updated_at = $4
		 WHERE id = $5`,
		wb.Name, wb.Description, wb.Metadata, wb.UpdatedAt, wb.ID,
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

func (r *SheetRepo) ListWorkbooksInAssignmentGroup(sourceWorkbookID int64) ([]model.Workbook, error) {
	rows, err := r.db.Query(
		`SELECT w.id, w.name, w.description, w.owner_id, u.username, w.folder_id, w.metadata, w.is_template, w.status, w.created_at, w.updated_at
		 FROM workbooks w
		 LEFT JOIN users u ON u.id = w.owner_id
		 WHERE w.id = $1 OR w.metadata->>'source_workbook_id' = $2
		 ORDER BY CASE WHEN w.id = $1 THEN 0 ELSE 1 END, w.id`,
		sourceWorkbookID, strconv.FormatInt(sourceWorkbookID, 10),
	)
	if err != nil {
		return nil, fmt.Errorf("list assignment workbooks: %w", err)
	}
	defer rows.Close()

	workbooks := make([]model.Workbook, 0)
	for rows.Next() {
		var wb model.Workbook
		if err := rows.Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.OwnerName, &wb.FolderID, &wb.Metadata, &wb.IsTemplate, &wb.Status, &wb.CreatedAt, &wb.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan assignment workbook: %w", err)
		}
		workbooks = append(workbooks, wb)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate assignment workbooks: %w", err)
	}
	return workbooks, nil
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
	frozen := s.Frozen
	if len(frozen) == 0 {
		frozen = json.RawMessage(`{"row":0,"col":0}`)
	}
	config := s.Config
	if len(config) == 0 {
		config = json.RawMessage(`{}`)
	}
	err := r.db.QueryRow(
		`INSERT INTO sheets (workbook_id, name, sort_order, columns, frozen, config, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 RETURNING id`,
		s.WorkbookID, s.Name, s.SortOrder, s.Columns, frozen, config, now, now,
	).Scan(&s.ID)
	if err != nil {
		return fmt.Errorf("create sheet: %w", err)
	}
	s.Frozen = frozen
	s.Config = config
	s.CreatedAt = now
	s.UpdatedAt = now
	return nil
}

func (r *SheetRepo) DuplicateSheet(sourceSheetID, workbookID int64, name string, sortOrder int, actorID int64) (*model.Sheet, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin duplicate sheet: %w", err)
	}
	defer tx.Rollback()

	clone, err := duplicateSheetTx(tx, sourceSheetID, workbookID, name, sortOrder, actorID, time.Now())
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit duplicate sheet: %w", err)
	}
	return clone, nil
}

func duplicateSheetTx(tx *sql.Tx, sourceSheetID, workbookID int64, name string, sortOrder int, actorID int64, now time.Time) (*model.Sheet, error) {
	clone := &model.Sheet{}
	err := tx.QueryRow(
		`INSERT INTO sheets (workbook_id, name, sort_order, columns, frozen, config, created_at, updated_at)
		 SELECT $2, $3, $4, columns, frozen, config, $5, $5
		 FROM sheets
		 WHERE id = $1
		 RETURNING id, workbook_id, name, sort_order, columns, frozen, config, created_at, updated_at`,
		sourceSheetID, workbookID, name, sortOrder, now,
	).Scan(
		&clone.ID,
		&clone.WorkbookID,
		&clone.Name,
		&clone.SortOrder,
		&clone.Columns,
		&clone.Frozen,
		&clone.Config,
		&clone.CreatedAt,
		&clone.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sheet %d not found", sourceSheetID)
	}
	if err != nil {
		return nil, fmt.Errorf("create duplicated sheet: %w", err)
	}

	if _, err := tx.Exec(
		`INSERT INTO rows (sheet_id, row_index, data, created_by, updated_by, created_at, updated_at)
		 SELECT $2, row_index, data, $3, $3, $4, $4
		 FROM rows
		 WHERE sheet_id = $1`,
		sourceSheetID, clone.ID, actorID, now,
	); err != nil {
		return nil, fmt.Errorf("copy sheet rows: %w", err)
	}

	permissionCopies := []struct {
		name  string
		query string
	}{
		{
			name: "role sheet permissions",
			query: `INSERT INTO sheet_permissions (sheet_id, role_id, can_view, can_edit, can_delete, can_export)
				SELECT $2, role_id, can_view, can_edit, can_delete, can_export
				FROM sheet_permissions WHERE sheet_id = $1`,
		},
		{
			name: "role cell permissions",
			query: `INSERT INTO cell_permissions (sheet_id, role_id, column_key, row_index, permission)
				SELECT $2, role_id, column_key, row_index, permission
				FROM cell_permissions WHERE sheet_id = $1`,
		},
		{
			name: "user sheet permissions",
			query: `INSERT INTO user_sheet_permissions (sheet_id, user_id, can_view, can_edit, can_delete, can_export)
				SELECT $2, user_id, can_view, can_edit, can_delete, can_export
				FROM user_sheet_permissions WHERE sheet_id = $1`,
		},
		{
			name: "principal sheet permissions",
			query: `INSERT INTO principal_sheet_permissions (sheet_id, principal_type, principal_id, can_view, can_edit, can_delete, can_export, created_at, updated_at)
				SELECT $2, principal_type, principal_id, can_view, can_edit, can_delete, can_export, created_at, updated_at
				FROM principal_sheet_permissions WHERE sheet_id = $1`,
		},
		{
			name: "principal cell permissions",
			query: `INSERT INTO principal_cell_permissions (sheet_id, principal_type, principal_id, column_key, row_index, permission, created_at, updated_at)
				SELECT $2, principal_type, principal_id, column_key, row_index, permission, created_at, updated_at
				FROM principal_cell_permissions WHERE sheet_id = $1`,
		},
	}
	for _, permissionCopy := range permissionCopies {
		if _, err := tx.Exec(permissionCopy.query, sourceSheetID, clone.ID); err != nil {
			return nil, fmt.Errorf("copy %s: %w", permissionCopy.name, err)
		}
	}

	return clone, nil
}

func (r *SheetRepo) GetNextSheetSortOrder(workbookID int64) (int, error) {
	var nextSortOrder int
	err := r.db.QueryRow(
		`SELECT COALESCE(MAX(sort_order), -1) + 1 FROM sheets WHERE workbook_id = $1`,
		workbookID,
	).Scan(&nextSortOrder)
	if err != nil {
		return 0, fmt.Errorf("get next sheet sort order: %w", err)
	}
	return nextSortOrder, nil
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

	if err := shiftRowsForDeleteTx(tx, sheetID, rowIndex); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func (r *SheetRepo) DeleteRowWithConfig(sheetID int64, rowIndex int, config json.RawMessage) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`UPDATE sheets SET config = $1, updated_at = NOW() WHERE id = $2`,
		config, sheetID,
	); err != nil {
		return fmt.Errorf("update sheet config: %w", err)
	}

	if _, err := tx.Exec(
		`DELETE FROM rows WHERE sheet_id = $1 AND row_index = $2`,
		sheetID, rowIndex,
	); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}

	if err := shiftRowsForDeleteTx(tx, sheetID, rowIndex); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	return nil
}

func (r *SheetRepo) InsertRow(sheetID int64, afterRow int) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if err := shiftRowsForInsertTx(tx, sheetID, afterRow+1); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}
	return nil
}

func (r *SheetRepo) InsertRowWithConfig(sheetID int64, afterRow int, config json.RawMessage) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`UPDATE sheets SET config = $1, updated_at = NOW() WHERE id = $2`,
		config, sheetID,
	); err != nil {
		return fmt.Errorf("update sheet config: %w", err)
	}

	if err := shiftRowsForInsertTx(tx, sheetID, afterRow+1); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	return nil
}

func shiftRowsForDeleteTx(tx *sql.Tx, sheetID int64, rowIndex int) error {
	const rowShiftOffset = 1000000
	firstAffectedRow := rowIndex + 1

	if _, err := tx.Exec(
		`UPDATE rows SET row_index = row_index + $3
		 WHERE sheet_id = $1 AND row_index >= $2`,
		sheetID, firstAffectedRow, rowShiftOffset,
	); err != nil {
		return fmt.Errorf("shift rows after delete: %w", err)
	}

	if _, err := tx.Exec(
		`UPDATE rows SET row_index = row_index - $3 - 1
		 WHERE sheet_id = $1 AND row_index >= ($2::int + $3::int)`,
		sheetID, firstAffectedRow, rowShiftOffset,
	); err != nil {
		return fmt.Errorf("finalize delete row shift: %w", err)
	}

	return nil
}

func shiftRowsForInsertTx(tx *sql.Tx, sheetID int64, insertAt int) error {
	const rowShiftOffset = 1000000

	if _, err := tx.Exec(
		`UPDATE rows SET row_index = row_index + $3
		 WHERE sheet_id = $1 AND row_index >= $2`,
		sheetID, insertAt, rowShiftOffset,
	); err != nil {
		return fmt.Errorf("shift rows for insert: %w", err)
	}

	if _, err := tx.Exec(
		`UPDATE rows SET row_index = row_index - $3 + 1
		 WHERE sheet_id = $1 AND row_index >= ($2::int + $3::int)`,
		sheetID, insertAt, rowShiftOffset,
	); err != nil {
		return fmt.Errorf("finalize insert row shift: %w", err)
	}

	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (r *SheetRepo) GetSheetData(sheetID int64) ([]model.Row, error) {
	return r.GetRows(sheetID)
}
