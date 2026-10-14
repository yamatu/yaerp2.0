package model

import "encoding/json"

type SheetPermission struct {
	ID        int64 `json:"id" db:"id"`
	SheetID   int64 `json:"sheet_id" db:"sheet_id"`
	RoleID    int64 `json:"role_id" db:"role_id"`
	CanView   bool  `json:"can_view" db:"can_view"`
	CanEdit   bool  `json:"can_edit" db:"can_edit"`
	CanDelete bool  `json:"can_delete" db:"can_delete"`
	CanExport bool  `json:"can_export" db:"can_export"`
}

type UserSheetPermission struct {
	ID        int64 `json:"id" db:"id"`
	SheetID   int64 `json:"sheet_id" db:"sheet_id"`
	UserID    int64 `json:"user_id" db:"user_id"`
	CanView   bool  `json:"can_view" db:"can_view"`
	CanEdit   bool  `json:"can_edit" db:"can_edit"`
	CanDelete bool  `json:"can_delete" db:"can_delete"`
	CanExport bool  `json:"can_export" db:"can_export"`
}

type CellPermission struct {
	ID         int64  `json:"id" db:"id"`
	SheetID    int64  `json:"sheet_id" db:"sheet_id"`
	RoleID     int64  `json:"role_id" db:"role_id"`
	ColumnKey  string `json:"column_key" db:"column_key"`
	RowIndex   *int   `json:"row_index" db:"row_index"`
	Permission string `json:"permission" db:"permission"`
}

type PermissionMatrix struct {
	Sheet                 SheetPerm             `json:"sheet"`
	DefaultPermission     string                `json:"defaultPermission,omitempty"`
	Rows                  map[string]string     `json:"rows"`
	Columns               map[string]string     `json:"columns"`
	Cells                 map[string]string     `json:"cells"`
	DepartmentOverrides   ScopedPermissionLayer `json:"departmentOverrides"`
	UserOverrides         ScopedPermissionLayer `json:"userOverrides"`
	ExplicitUserSheetRule bool                  `json:"explicitUserSheetRule,omitempty"`
	// Grants explains where the whole-sheet flags came from. It is only sent
	// to administrators (see EffectivePermissionExplanation).
	Grants []PermissionGrant `json:"-"`
}

// PermissionGrant is one source of a user's whole-sheet access, in the order
// it was applied. Source is one of: admin, owner, legacy_role,
// legacy_role_ranges, department, public, folder, legacy_user, user, scoped,
// state, hidden, folder_denied.
type PermissionGrant struct {
	Source      string `json:"source"`
	PrincipalID int64  `json:"principal_id,omitempty"`
	CanView     bool   `json:"can_view"`
	CanEdit     bool   `json:"can_edit"`
	CanDelete   bool   `json:"can_delete"`
	CanExport   bool   `json:"can_export"`
	// Replaces marks a source that overrides every source before it.
	Replaces bool   `json:"replaces,omitempty"`
	Note     string `json:"note,omitempty"`
}

type EffectivePermissionExplanation struct {
	*PermissionMatrix
	Grants []PermissionGrant `json:"grants"`
}

type LegacyRoleSheetPermission struct {
	RoleID    int64  `json:"role_id"`
	RoleName  string `json:"role_name"`
	RoleCode  string `json:"role_code"`
	CanView   bool   `json:"can_view"`
	CanEdit   bool   `json:"can_edit"`
	CanDelete bool   `json:"can_delete"`
	CanExport bool   `json:"can_export"`
	// RangeRules counts the role's legacy row/column/cell rules on the sheet.
	RangeRules int `json:"range_rules"`
}

type LegacyUserSheetPermission struct {
	UserID    int64  `json:"user_id"`
	Username  string `json:"username"`
	CanView   bool   `json:"can_view"`
	CanEdit   bool   `json:"can_edit"`
	CanDelete bool   `json:"can_delete"`
	CanExport bool   `json:"can_export"`
}

type LegacySheetPermissions struct {
	Roles []LegacyRoleSheetPermission `json:"roles"`
	Users []LegacyUserSheetPermission `json:"users"`
}

type SheetPermissionOverviewEntry struct {
	PrincipalType string                    `json:"principal_type"`
	PrincipalID   int64                     `json:"principal_id"`
	Sheet         *PrincipalSheetPermission `json:"sheet,omitempty"`
	RuleCounts    map[string]int            `json:"rule_counts"`
}

type SheetPermissionOverview struct {
	Principals []SheetPermissionOverviewEntry `json:"principals"`
	Legacy     LegacySheetPermissions         `json:"legacy"`
}

type PermissionSheetOption struct {
	ID           int64           `json:"id"`
	Name         string          `json:"name"`
	WorkbookID   int64           `json:"workbook_id"`
	WorkbookName string          `json:"workbook_name"`
	Columns      json.RawMessage `json:"columns"`
}

type ScopedPermissionLayer struct {
	Rows    map[string]string `json:"rows"`
	Columns map[string]string `json:"columns"`
	Cells   map[string]string `json:"cells"`
}

type SheetPerm struct {
	CanView   bool `json:"canView"`
	CanEdit   bool `json:"canEdit"`
	CanDelete bool `json:"canDelete"`
	CanExport bool `json:"canExport"`
}

type SetSheetPermissionRequest struct {
	SheetID   int64 `json:"sheet_id" binding:"required"`
	RoleID    int64 `json:"role_id" binding:"required"`
	CanView   bool  `json:"can_view"`
	CanEdit   bool  `json:"can_edit"`
	CanDelete bool  `json:"can_delete"`
	CanExport bool  `json:"can_export"`
}

type SetUserSheetPermissionRequest struct {
	SheetID   int64 `json:"sheet_id" binding:"required"`
	UserID    int64 `json:"user_id" binding:"required"`
	CanView   bool  `json:"can_view"`
	CanEdit   bool  `json:"can_edit"`
	CanDelete bool  `json:"can_delete"`
	CanExport bool  `json:"can_export"`
}

type SetCellPermissionRequest struct {
	SheetID    int64  `json:"sheet_id" binding:"required"`
	RoleID     int64  `json:"role_id" binding:"required"`
	ColumnKey  string `json:"column_key"`
	RowIndex   *int   `json:"row_index"`
	Permission string `json:"permission" binding:"required,oneof=read write none"`
}

type PrincipalSheetPermission struct {
	ID            int64  `json:"id"`
	SheetID       int64  `json:"sheet_id"`
	PrincipalType string `json:"principal_type"`
	PrincipalID   int64  `json:"principal_id"`
	CanView       bool   `json:"can_view"`
	CanEdit       bool   `json:"can_edit"`
	CanDelete     bool   `json:"can_delete"`
	CanExport     bool   `json:"can_export"`
}

type PrincipalCellPermission struct {
	ID            int64  `json:"id"`
	SheetID       int64  `json:"sheet_id"`
	PrincipalType string `json:"principal_type"`
	PrincipalID   int64  `json:"principal_id"`
	ColumnKey     string `json:"column_key"`
	RowIndex      *int   `json:"row_index,omitempty"`
	Permission    string `json:"permission"`
}

type SetPrincipalSheetPermissionRequest struct {
	SheetID       int64  `json:"sheet_id" binding:"required"`
	PrincipalType string `json:"principal_type" binding:"required,oneof=department user"`
	PrincipalID   int64  `json:"principal_id" binding:"required"`
	CanView       bool   `json:"can_view"`
	CanEdit       bool   `json:"can_edit"`
	CanDelete     bool   `json:"can_delete"`
	CanExport     bool   `json:"can_export"`
}

type SetPrincipalCellPermissionRequest struct {
	SheetID       int64  `json:"sheet_id" binding:"required"`
	PrincipalType string `json:"principal_type" binding:"required,oneof=department user"`
	PrincipalID   int64  `json:"principal_id" binding:"required"`
	ColumnKey     string `json:"column_key"`
	RowIndex      *int   `json:"row_index"`
	Permission    string `json:"permission" binding:"required,oneof=read write none"`
}

type PrincipalPermissionConfig struct {
	Sheet   PrincipalSheetPermission  `json:"sheet"`
	Rows    []PrincipalCellPermission `json:"rows"`
	Columns []PrincipalCellPermission `json:"columns"`
	Cells   []PrincipalCellPermission `json:"cells"`
}
