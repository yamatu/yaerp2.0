package repo

import (
	"database/sql"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

// ListPermissionSheets returns every sheet of every live workbook with its
// columns, for the permission administration screen.
func (r *PermissionRepo) ListPermissionSheets() ([]model.PermissionSheetOption, error) {
	rows, err := r.db.Query(
		`SELECT s.id, s.name, w.id, w.name, COALESCE(s.columns, '[]'::jsonb)
		 FROM sheets s
		 JOIN workbooks w ON w.id = s.workbook_id
		 WHERE w.deleted_at IS NULL
		 ORDER BY w.updated_at DESC, w.id DESC, s.sort_order, s.id`,
	)
	if err != nil {
		return nil, fmt.Errorf("list permission sheets: %w", err)
	}
	defer rows.Close()
	sheets := make([]model.PermissionSheetOption, 0)
	for rows.Next() {
		var item model.PermissionSheetOption
		var columns []byte
		if err := rows.Scan(&item.ID, &item.Name, &item.WorkbookID, &item.WorkbookName, &columns); err != nil {
			return nil, err
		}
		item.Columns = append([]byte(nil), columns...)
		sheets = append(sheets, item)
	}
	return sheets, rows.Err()
}

// GetSheetPermissionOverview lists every department and employee that has a
// whole-sheet rule or range rules on the sheet.
func (r *PermissionRepo) GetSheetPermissionOverview(sheetID int64) ([]model.SheetPermissionOverviewEntry, error) {
	type principalKey struct {
		kind string
		id   int64
	}
	entries := map[principalKey]*model.SheetPermissionOverviewEntry{}
	order := make([]principalKey, 0)
	entry := func(kind string, id int64) *model.SheetPermissionOverviewEntry {
		key := principalKey{kind, id}
		if existing, ok := entries[key]; ok {
			return existing
		}
		created := &model.SheetPermissionOverviewEntry{PrincipalType: kind, PrincipalID: id, RuleCounts: map[string]int{}}
		entries[key] = created
		order = append(order, key)
		return created
	}

	sheetRows, err := r.db.Query(
		`SELECT id, principal_type, principal_id, can_view, can_edit, can_delete, can_export
		 FROM principal_sheet_permissions WHERE sheet_id = $1
		 ORDER BY principal_type, principal_id`, sheetID)
	if err != nil {
		return nil, err
	}
	defer sheetRows.Close()
	for sheetRows.Next() {
		permission := model.PrincipalSheetPermission{SheetID: sheetID}
		if err := sheetRows.Scan(&permission.ID, &permission.PrincipalType, &permission.PrincipalID,
			&permission.CanView, &permission.CanEdit, &permission.CanDelete, &permission.CanExport); err != nil {
			return nil, err
		}
		item := entry(permission.PrincipalType, permission.PrincipalID)
		copied := permission
		item.Sheet = &copied
	}
	if err := sheetRows.Err(); err != nil {
		return nil, err
	}

	ruleRows, err := r.db.Query(
		`SELECT principal_type, principal_id, permission, COUNT(*)
		 FROM principal_cell_permissions WHERE sheet_id = $1
		 GROUP BY principal_type, principal_id, permission
		 ORDER BY principal_type, principal_id`, sheetID)
	if err != nil {
		return nil, err
	}
	defer ruleRows.Close()
	for ruleRows.Next() {
		var kind, permission string
		var id int64
		var count int
		if err := ruleRows.Scan(&kind, &id, &permission, &count); err != nil {
			return nil, err
		}
		entry(kind, id).RuleCounts[permission] += count
	}
	if err := ruleRows.Err(); err != nil {
		return nil, err
	}

	result := make([]model.SheetPermissionOverviewEntry, 0, len(order))
	for _, key := range order {
		result = append(result, *entries[key])
	}
	return result, nil
}

// GetLegacySheetPermissions lists the rules stored in the pre-department
// permission tables, which still count towards access.
func (r *PermissionRepo) GetLegacySheetPermissions(sheetID int64) (*model.LegacySheetPermissions, error) {
	legacy := &model.LegacySheetPermissions{Roles: []model.LegacyRoleSheetPermission{}, Users: []model.LegacyUserSheetPermission{}}

	roleRows, err := r.db.Query(
		`SELECT ro.id, ro.name, ro.code,
		        COALESCE(sp.can_view, FALSE), COALESCE(sp.can_edit, FALSE), COALESCE(sp.can_delete, FALSE), COALESCE(sp.can_export, FALSE),
		        (SELECT COUNT(*) FROM cell_permissions cp WHERE cp.sheet_id = $1 AND cp.role_id = ro.id)
		 FROM roles ro
		 LEFT JOIN sheet_permissions sp ON sp.role_id = ro.id AND sp.sheet_id = $1
		 WHERE sp.id IS NOT NULL OR EXISTS (SELECT 1 FROM cell_permissions cp WHERE cp.sheet_id = $1 AND cp.role_id = ro.id)
		 ORDER BY ro.id`, sheetID)
	if err != nil {
		return nil, err
	}
	defer roleRows.Close()
	for roleRows.Next() {
		var item model.LegacyRoleSheetPermission
		if err := roleRows.Scan(&item.RoleID, &item.RoleName, &item.RoleCode,
			&item.CanView, &item.CanEdit, &item.CanDelete, &item.CanExport, &item.RangeRules); err != nil {
			return nil, err
		}
		legacy.Roles = append(legacy.Roles, item)
	}
	if err := roleRows.Err(); err != nil {
		return nil, err
	}

	userRows, err := r.db.Query(
		`SELECT up.user_id, COALESCE(u.username, ''), up.can_view, up.can_edit, up.can_delete, up.can_export
		 FROM user_sheet_permissions up
		 LEFT JOIN users u ON u.id = up.user_id
		 WHERE up.sheet_id = $1
		 ORDER BY up.user_id`, sheetID)
	if err != nil {
		return nil, err
	}
	defer userRows.Close()
	for userRows.Next() {
		var item model.LegacyUserSheetPermission
		if err := userRows.Scan(&item.UserID, &item.Username, &item.CanView, &item.CanEdit, &item.CanDelete, &item.CanExport); err != nil {
			return nil, err
		}
		legacy.Users = append(legacy.Users, item)
	}
	return legacy, userRows.Err()
}

// DeleteLegacySheetPermissions removes legacy rules of one sheet: those of a
// role (kind "role"), of an employee (kind "user"), or all of them (kind "").
func (r *PermissionRepo) DeleteLegacySheetPermissions(sheetID int64, kind string, principalID int64) (int64, error) {
	var statements []string
	switch strings.TrimSpace(kind) {
	case "role":
		statements = []string{
			`DELETE FROM sheet_permissions WHERE sheet_id = $1 AND role_id = $2`,
			`DELETE FROM cell_permissions WHERE sheet_id = $1 AND role_id = $2`,
		}
	case "user":
		statements = []string{`DELETE FROM user_sheet_permissions WHERE sheet_id = $1 AND user_id = $2`}
	case "":
		statements = []string{
			`DELETE FROM sheet_permissions WHERE sheet_id = $1`,
			`DELETE FROM cell_permissions WHERE sheet_id = $1`,
			`DELETE FROM user_sheet_permissions WHERE sheet_id = $1`,
		}
	default:
		return 0, fmt.Errorf("unknown legacy permission kind %q", kind)
	}

	tx, err := r.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var removed int64
	for _, statement := range statements {
		var result sql.Result
		if kind == "" {
			result, err = tx.Exec(statement, sheetID)
		} else {
			result, err = tx.Exec(statement, sheetID, principalID)
		}
		if err != nil {
			return 0, err
		}
		affected, _ := result.RowsAffected()
		removed += affected
	}
	return removed, tx.Commit()
}
