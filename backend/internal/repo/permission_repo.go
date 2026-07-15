package repo

import (
	"database/sql"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

type PermissionRepo struct {
	db *sql.DB
}

func NewPermissionRepo(db *sql.DB) *PermissionRepo {
	return &PermissionRepo{db: db}
}

func (r *PermissionRepo) SetSheetPermission(perm *model.SheetPermission) error {
	_, err := r.db.Exec(
		`INSERT INTO sheet_permissions (sheet_id, role_id, can_view, can_edit, can_delete, can_export)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (sheet_id, role_id)
		 DO UPDATE SET can_view = $3, can_edit = $4, can_delete = $5, can_export = $6`,
		perm.SheetID, perm.RoleID, perm.CanView, perm.CanEdit, perm.CanDelete, perm.CanExport,
	)
	return err
}

func (r *PermissionRepo) SetUserSheetPermission(perm *model.UserSheetPermission) error {
	_, err := r.db.Exec(
		`INSERT INTO user_sheet_permissions (sheet_id, user_id, can_view, can_edit, can_delete, can_export)
		 VALUES ($1, $2, $3, $4, $5, $6)
		 ON CONFLICT (sheet_id, user_id)
		 DO UPDATE SET can_view = $3, can_edit = $4, can_delete = $5, can_export = $6`,
		perm.SheetID, perm.UserID, perm.CanView, perm.CanEdit, perm.CanDelete, perm.CanExport,
	)
	return err
}

func (r *PermissionRepo) GetSheetPermissions(sheetID, roleID int64) (*model.SheetPermission, error) {
	var p model.SheetPermission
	err := r.db.QueryRow(
		`SELECT id, sheet_id, role_id, can_view, can_edit, can_delete, can_export
		 FROM sheet_permissions WHERE sheet_id = $1 AND role_id = $2`,
		sheetID, roleID,
	).Scan(&p.ID, &p.SheetID, &p.RoleID, &p.CanView, &p.CanEdit, &p.CanDelete, &p.CanExport)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *PermissionRepo) SetCellPermission(perm *model.CellPermission) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columnKey := strings.TrimSpace(perm.ColumnKey)
	rowIndexKey := -1
	if perm.RowIndex != nil {
		rowIndexKey = *perm.RowIndex
	}

	if _, err := tx.Exec(
		`DELETE FROM cell_permissions
		 WHERE sheet_id = $1
		   AND role_id = $2
		   AND COALESCE(column_key, '') = $3
		   AND COALESCE(row_index, -1) = $4`,
		perm.SheetID, perm.RoleID, columnKey, rowIndexKey,
	); err != nil {
		return err
	}

	if _, err := tx.Exec(
		`INSERT INTO cell_permissions (sheet_id, role_id, column_key, row_index, permission)
		 VALUES ($1, $2, $3, $4, $5)`,
		perm.SheetID, perm.RoleID, columnKey, perm.RowIndex, perm.Permission,
	); err != nil {
		return err
	}

	return tx.Commit()
}

func (r *PermissionRepo) GetCellPermissions(sheetID, roleID int64) ([]model.CellPermission, error) {
	rows, err := r.db.Query(
		`SELECT id, sheet_id, role_id, column_key, row_index, permission
		 FROM cell_permissions WHERE sheet_id = $1 AND role_id = $2`,
		sheetID, roleID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var perms []model.CellPermission
	for rows.Next() {
		var p model.CellPermission
		if err := rows.Scan(&p.ID, &p.SheetID, &p.RoleID, &p.ColumnKey, &p.RowIndex, &p.Permission); err != nil {
			return nil, err
		}
		perms = append(perms, p)
	}
	return perms, rows.Err()
}

func (r *PermissionRepo) GetUserSheetPermission(sheetID, userID int64) (*model.UserSheetPermission, error) {
	var p model.UserSheetPermission
	err := r.db.QueryRow(
		`SELECT id, sheet_id, user_id, can_view, can_edit, can_delete, can_export
		 FROM user_sheet_permissions WHERE sheet_id = $1 AND user_id = $2`,
		sheetID, userID,
	).Scan(&p.ID, &p.SheetID, &p.UserID, &p.CanView, &p.CanEdit, &p.CanDelete, &p.CanExport)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (r *PermissionRepo) ListUserSheetPermissions(sheetID int64) ([]model.UserSheetPermission, error) {
	rows, err := r.db.Query(
		`SELECT id, sheet_id, user_id, can_view, can_edit, can_delete, can_export
		 FROM user_sheet_permissions
		 WHERE sheet_id = $1
		 ORDER BY user_id`,
		sheetID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	perms := make([]model.UserSheetPermission, 0)
	for rows.Next() {
		var p model.UserSheetPermission
		if err := rows.Scan(&p.ID, &p.SheetID, &p.UserID, &p.CanView, &p.CanEdit, &p.CanDelete, &p.CanExport); err != nil {
			return nil, err
		}
		perms = append(perms, p)
	}

	return perms, rows.Err()
}

func (r *PermissionRepo) SetPrincipalSheetPermission(perm *model.PrincipalSheetPermission) error {
	_, err := r.db.Exec(
		`INSERT INTO principal_sheet_permissions
		 (sheet_id, principal_type, principal_id, can_view, can_edit, can_delete, can_export)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)
		 ON CONFLICT (sheet_id, principal_type, principal_id)
		 DO UPDATE SET can_view = EXCLUDED.can_view,
		               can_edit = EXCLUDED.can_edit,
		               can_delete = EXCLUDED.can_delete,
		               can_export = EXCLUDED.can_export,
		               updated_at = NOW()`,
		perm.SheetID, perm.PrincipalType, perm.PrincipalID,
		perm.CanView, perm.CanEdit, perm.CanDelete, perm.CanExport,
	)
	return err
}

func (r *PermissionRepo) DeletePrincipalSheetPermission(sheetID int64, principalType string, principalID int64) error {
	_, err := r.db.Exec(
		`DELETE FROM principal_sheet_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id = $3`,
		sheetID, principalType, principalID,
	)
	return err
}

func (r *PermissionRepo) SetPrincipalCellPermission(perm *model.PrincipalCellPermission) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columnKey := strings.TrimSpace(perm.ColumnKey)
	rowIndexKey := -1
	if perm.RowIndex != nil {
		rowIndexKey = *perm.RowIndex
	}
	if _, err := tx.Exec(
		`DELETE FROM principal_cell_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id = $3
		   AND COALESCE(column_key, '') = $4 AND COALESCE(row_index, -1) = $5`,
		perm.SheetID, perm.PrincipalType, perm.PrincipalID, columnKey, rowIndexKey,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO principal_cell_permissions
		 (sheet_id, principal_type, principal_id, column_key, row_index, permission)
		 VALUES ($1, $2, $3, $4, $5, $6)`,
		perm.SheetID, perm.PrincipalType, perm.PrincipalID, columnKey, perm.RowIndex, perm.Permission,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *PermissionRepo) DeletePrincipalCellPermission(id int64) error {
	result, err := r.db.Exec(`DELETE FROM principal_cell_permissions WHERE id = $1`, id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("range permission %d not found", id)
	}
	return nil
}

func (r *PermissionRepo) GetPrincipalPermissionConfig(sheetID int64, principalType string, principalID int64) (*model.PrincipalPermissionConfig, error) {
	config := &model.PrincipalPermissionConfig{
		Sheet: model.PrincipalSheetPermission{
			SheetID: sheetID, PrincipalType: principalType, PrincipalID: principalID,
		},
		Rows: []model.PrincipalCellPermission{}, Columns: []model.PrincipalCellPermission{}, Cells: []model.PrincipalCellPermission{},
	}
	if err := r.db.QueryRow(
		`SELECT id, can_view, can_edit, can_delete, can_export
		 FROM principal_sheet_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id = $3`,
		sheetID, principalType, principalID,
	).Scan(&config.Sheet.ID, &config.Sheet.CanView, &config.Sheet.CanEdit, &config.Sheet.CanDelete, &config.Sheet.CanExport); err != nil && err != sql.ErrNoRows {
		return nil, err
	}

	rows, err := r.db.Query(
		`SELECT id, column_key, row_index, permission
		 FROM principal_cell_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id = $3
		 ORDER BY COALESCE(row_index, -1), column_key`,
		sheetID, principalType, principalID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		permission := model.PrincipalCellPermission{
			SheetID: sheetID, PrincipalType: principalType, PrincipalID: principalID,
		}
		if err := rows.Scan(&permission.ID, &permission.ColumnKey, &permission.RowIndex, &permission.Permission); err != nil {
			return nil, err
		}
		switch {
		case permission.RowIndex != nil && strings.TrimSpace(permission.ColumnKey) != "":
			config.Cells = append(config.Cells, permission)
		case permission.RowIndex != nil:
			config.Rows = append(config.Rows, permission)
		default:
			config.Columns = append(config.Columns, permission)
		}
	}
	return config, rows.Err()
}

func (r *PermissionRepo) GetPrincipalSheetPermissions(sheetID int64, principalType string, principalIDs []int64) ([]model.PrincipalSheetPermission, error) {
	if len(principalIDs) == 0 {
		return []model.PrincipalSheetPermission{}, nil
	}
	query, args := principalLookupQuery(
		`SELECT id, sheet_id, principal_type, principal_id, can_view, can_edit, can_delete, can_export
		 FROM principal_sheet_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id IN (%s)`,
		sheetID, principalType, principalIDs,
	)
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	permissions := make([]model.PrincipalSheetPermission, 0)
	for rows.Next() {
		var permission model.PrincipalSheetPermission
		if err := rows.Scan(
			&permission.ID, &permission.SheetID, &permission.PrincipalType, &permission.PrincipalID,
			&permission.CanView, &permission.CanEdit, &permission.CanDelete, &permission.CanExport,
		); err != nil {
			return nil, err
		}
		permissions = append(permissions, permission)
	}
	return permissions, rows.Err()
}

func (r *PermissionRepo) GetPrincipalCellPermissions(sheetID int64, principalType string, principalIDs []int64) ([]model.PrincipalCellPermission, error) {
	if len(principalIDs) == 0 {
		return []model.PrincipalCellPermission{}, nil
	}
	query, args := principalLookupQuery(
		`SELECT id, sheet_id, principal_type, principal_id, column_key, row_index, permission
		 FROM principal_cell_permissions
		 WHERE sheet_id = $1 AND principal_type = $2 AND principal_id IN (%s)`,
		sheetID, principalType, principalIDs,
	)
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	permissions := make([]model.PrincipalCellPermission, 0)
	for rows.Next() {
		var permission model.PrincipalCellPermission
		if err := rows.Scan(
			&permission.ID, &permission.SheetID, &permission.PrincipalType, &permission.PrincipalID,
			&permission.ColumnKey, &permission.RowIndex, &permission.Permission,
		); err != nil {
			return nil, err
		}
		permissions = append(permissions, permission)
	}
	return permissions, rows.Err()
}

func principalLookupQuery(template string, sheetID int64, principalType string, principalIDs []int64) (string, []interface{}) {
	placeholders := make([]string, len(principalIDs))
	args := make([]interface{}, 0, len(principalIDs)+2)
	args = append(args, sheetID, principalType)
	for index, principalID := range principalIDs {
		placeholders[index] = fmt.Sprintf("$%d", index+3)
		args = append(args, principalID)
	}
	return fmt.Sprintf(template, strings.Join(placeholders, ", ")), args
}

func (r *PermissionRepo) SheetHasScopedPermissions(sheetID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRow(`
		SELECT EXISTS(
			SELECT 1 FROM principal_cell_permissions WHERE sheet_id = $1
			UNION ALL
			SELECT 1 FROM cell_permissions WHERE sheet_id = $1 AND permission <> 'write'
		)`, sheetID).Scan(&exists)
	return exists, err
}

// GetPermissionMatrix builds a combined PermissionMatrix for a user across all their roles.
func (r *PermissionRepo) GetPermissionMatrix(sheetID int64, roleIDs []int64) (*model.PermissionMatrix, error) {
	matrix := &model.PermissionMatrix{
		Sheet:   model.SheetPerm{},
		Rows:    make(map[string]string),
		Columns: make(map[string]string),
		Cells:   make(map[string]string),
	}

	if len(roleIDs) == 0 {
		return matrix, nil
	}

	// Build IN clause
	placeholders := make([]string, len(roleIDs))
	args := make([]interface{}, 0, len(roleIDs)+1)
	args = append(args, sheetID)
	for i, rid := range roleIDs {
		placeholders[i] = fmt.Sprintf("$%d", i+2)
		args = append(args, rid)
	}
	inClause := strings.Join(placeholders, ", ")

	// Merge sheet-level permissions (OR across roles)
	query := fmt.Sprintf(
		`SELECT can_view, can_edit, can_delete, can_export
		 FROM sheet_permissions WHERE sheet_id = $1 AND role_id IN (%s)`, inClause)
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var v, e, d, x bool
		if err := rows.Scan(&v, &e, &d, &x); err != nil {
			return nil, err
		}
		if v {
			matrix.Sheet.CanView = true
		}
		if e {
			matrix.Sheet.CanEdit = true
		}
		if d {
			matrix.Sheet.CanDelete = true
		}
		if x {
			matrix.Sheet.CanExport = true
		}
	}

	// Cell-level permissions
	cellQuery := fmt.Sprintf(
		`SELECT column_key, row_index, permission
		 FROM cell_permissions WHERE sheet_id = $1 AND role_id IN (%s)`, inClause)
	cellRows, err := r.db.Query(cellQuery, args...)
	if err != nil {
		return nil, err
	}
	defer cellRows.Close()

	for cellRows.Next() {
		var colKey sql.NullString
		var rowIndex *int
		var perm string
		if err := cellRows.Scan(&colKey, &rowIndex, &perm); err != nil {
			return nil, err
		}
		normalizedColKey := strings.TrimSpace(colKey.String)
		if rowIndex != nil {
			if normalizedColKey == "" {
				key := fmt.Sprintf("%d", *rowIndex)
				matrix.Rows[key] = bestPermission(matrix.Rows[key], perm)
			} else {
				// Cell-specific permission
				key := fmt.Sprintf("%d:%s", *rowIndex, normalizedColKey)
				matrix.Cells[key] = bestPermission(matrix.Cells[key], perm)
			}
		} else if normalizedColKey != "" {
			// Column-level permission
			matrix.Columns[normalizedColKey] = bestPermission(matrix.Columns[normalizedColKey], perm)
		}
	}

	return matrix, nil
}

// bestPermission returns the more permissive of two permission levels.
func bestPermission(current, new string) string {
	levels := map[string]int{"none": 0, "read": 1, "write": 2, "": -1}
	if levels[new] > levels[current] {
		return new
	}
	return current
}

func (r *PermissionRepo) CreateLog(log *model.OperationLog) error {
	_, err := r.db.Exec(
		`INSERT INTO operation_logs (user_id, sheet_id, row_index, column_key, action, old_value, new_value)
		 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
		log.UserID, log.SheetID, log.RowIndex, log.ColumnKey, log.Action, log.OldValue, log.NewValue,
	)
	return err
}
