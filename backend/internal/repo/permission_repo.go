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
	_, err := r.db.Exec(
		`INSERT INTO cell_permissions (sheet_id, role_id, column_key, row_index, permission)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (sheet_id, role_id, column_key, row_index)
		 DO UPDATE SET permission = $5`,
		perm.SheetID, perm.RoleID, perm.ColumnKey, perm.RowIndex, perm.Permission,
	)
	return err
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

// GetPermissionMatrix builds a combined PermissionMatrix for a user across all their roles.
func (r *PermissionRepo) GetPermissionMatrix(sheetID int64, roleIDs []int64) (*model.PermissionMatrix, error) {
	matrix := &model.PermissionMatrix{
		Sheet:   model.SheetPerm{},
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
		var colKey string
		var rowIndex *int
		var perm string
		if err := cellRows.Scan(&colKey, &rowIndex, &perm); err != nil {
			return nil, err
		}
		if rowIndex != nil {
			// Cell-specific permission
			key := fmt.Sprintf("%d:%s", *rowIndex, colKey)
			matrix.Cells[key] = bestPermission(matrix.Cells[key], perm)
		} else {
			// Column-level permission
			matrix.Columns[colKey] = bestPermission(matrix.Columns[colKey], perm)
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
