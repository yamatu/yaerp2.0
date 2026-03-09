package model

type SheetPermission struct {
	ID        int64 `json:"id" db:"id"`
	SheetID   int64 `json:"sheet_id" db:"sheet_id"`
	RoleID    int64 `json:"role_id" db:"role_id"`
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
	Sheet   SheetPerm         `json:"sheet"`
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

type SetCellPermissionRequest struct {
	SheetID    int64  `json:"sheet_id" binding:"required"`
	RoleID     int64  `json:"role_id" binding:"required"`
	ColumnKey  string `json:"column_key"`
	RowIndex   *int   `json:"row_index"`
	Permission string `json:"permission" binding:"required,oneof=read write none"`
}
