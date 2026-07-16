package model

import (
	"encoding/json"
	"time"
)

type Workbook struct {
	ID            int64           `json:"id" db:"id"`
	Name          string          `json:"name" db:"name"`
	Description   *string         `json:"description" db:"description"`
	OwnerID       int64           `json:"owner_id" db:"owner_id"`
	OwnerName     *string         `json:"owner_name,omitempty" db:"owner_name"`
	FolderID      *int64          `json:"folder_id,omitempty" db:"folder_id"`
	Metadata      json.RawMessage `json:"metadata" db:"metadata"`
	IsTemplate    bool            `json:"is_template" db:"is_template"`
	Status        int             `json:"status" db:"status"`
	IsLocked      bool            `json:"is_locked,omitempty"`
	IsHidden      bool            `json:"is_hidden,omitempty"`
	IsPublic      bool            `json:"is_public,omitempty"`
	LockedByID    *int64          `json:"locked_by_id,omitempty"`
	LockedByName  *string         `json:"locked_by_name,omitempty"`
	LockedAt      *time.Time      `json:"locked_at,omitempty"`
	HiddenByID    *int64          `json:"hidden_by_id,omitempty"`
	HiddenByName  *string         `json:"hidden_by_name,omitempty"`
	HiddenAt      *time.Time      `json:"hidden_at,omitempty"`
	DeletedAt     *time.Time      `json:"deleted_at,omitempty" db:"deleted_at"`
	DeletedByID   *int64          `json:"deleted_by_id,omitempty" db:"deleted_by"`
	DeletedByName *string         `json:"deleted_by_name,omitempty" db:"deleted_by_name"`
	CreatedAt     time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt     time.Time       `json:"updated_at" db:"updated_at"`
	Sheets        []Sheet         `json:"sheets,omitempty"`
}

type Sheet struct {
	ID             int64           `json:"id" db:"id"`
	WorkbookID     int64           `json:"workbook_id" db:"workbook_id"`
	Name           string          `json:"name" db:"name"`
	SortOrder      int             `json:"sort_order" db:"sort_order"`
	Columns        json.RawMessage `json:"columns" db:"columns"`
	Frozen         json.RawMessage `json:"frozen" db:"frozen"`
	Config         json.RawMessage `json:"config" db:"config"`
	IsLocked       bool            `json:"is_locked,omitempty"`
	IsArchived     bool            `json:"is_archived,omitempty"`
	IsHidden       bool            `json:"is_hidden,omitempty"`
	LockedByID     *int64          `json:"locked_by_id,omitempty"`
	LockedByName   *string         `json:"locked_by_name,omitempty"`
	LockedAt       *time.Time      `json:"locked_at,omitempty"`
	ArchivedByID   *int64          `json:"archived_by_id,omitempty"`
	ArchivedByName *string         `json:"archived_by_name,omitempty"`
	ArchivedAt     *time.Time      `json:"archived_at,omitempty"`
	HiddenByID     *int64          `json:"hidden_by_id,omitempty"`
	HiddenByName   *string         `json:"hidden_by_name,omitempty"`
	HiddenAt       *time.Time      `json:"hidden_at,omitempty"`
	CreatedAt      time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at" db:"updated_at"`
}

type Row struct {
	ID        int64           `json:"id" db:"id"`
	SheetID   int64           `json:"sheet_id" db:"sheet_id"`
	RowIndex  int             `json:"row_index" db:"row_index"`
	Data      json.RawMessage `json:"data" db:"data"`
	CreatedBy *int64          `json:"created_by" db:"created_by"`
	UpdatedBy *int64          `json:"updated_by" db:"updated_by"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt time.Time       `json:"updated_at" db:"updated_at"`
}

type CreateWorkbookRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
	IsTemplate  bool   `json:"is_template"`
	FolderID    *int64 `json:"folder_id"`
}

type UpdateWorkbookRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type UpdateWorkbookStateRequest struct {
	Action string `json:"action" binding:"required,oneof=lock unlock hide unhide publish unpublish"`
}

type BatchUpdateWorkbookStateRequest struct {
	WorkbookIDs []int64 `json:"workbook_ids" binding:"required,min=1"`
	Action      string  `json:"action" binding:"required,oneof=lock unlock hide unhide publish unpublish"`
}

type AssignWorkbookRequest struct {
	UserIDs []int64 `json:"user_ids" binding:"required,min=1"`
}

type UpdateProtectionRequest struct {
	Scope                   string  `json:"scope" binding:"required,oneof=row column cell"`
	Action                  string  `json:"action" binding:"required,oneof=lock unlock"`
	RowIndex                *int    `json:"row_index,omitempty"`
	ColumnKey               *string `json:"column_key,omitempty"`
	ReadonlyUserIDs         []int64 `json:"readonly_user_ids,omitempty"`
	ReadonlyDepartmentIDs   []int64 `json:"readonly_department_ids,omitempty"`
	EditableUserIDs         []int64 `json:"editable_user_ids,omitempty"`
	EditableDepartmentIDs   []int64 `json:"editable_department_ids,omitempty"`
	ViewHiddenUserIDs       []int64 `json:"view_hidden_user_ids,omitempty"`
	ViewHiddenDepartmentIDs []int64 `json:"view_hidden_department_ids,omitempty"`
	LockEditing             *bool   `json:"lock_editing,omitempty"`
	Hidden                  *bool   `json:"hidden,omitempty"`
}

type BatchUpdateProtectionRequest struct {
	Items []UpdateProtectionRequest `json:"items" binding:"required,min=1"`
}

type UpdateSheetStateRequest struct {
	Action string `json:"action" binding:"required,oneof=lock unlock archive unarchive hide unhide"`
}

type ProtectionInfo struct {
	Scope                   string    `json:"scope"`
	Key                     string    `json:"key"`
	RowIndex                *int      `json:"row_index,omitempty"`
	ColumnKey               *string   `json:"column_key,omitempty"`
	OwnerID                 int64     `json:"owner_id"`
	OwnerName               string    `json:"owner_name"`
	ReadonlyUserIDs         []int64   `json:"readonly_user_ids,omitempty"`
	ReadonlyDepartmentIDs   []int64   `json:"readonly_department_ids,omitempty"`
	EditableUserIDs         []int64   `json:"editable_user_ids,omitempty"`
	EditableDepartmentIDs   []int64   `json:"editable_department_ids,omitempty"`
	ViewHiddenUserIDs       []int64   `json:"view_hidden_user_ids,omitempty"`
	ViewHiddenDepartmentIDs []int64   `json:"view_hidden_department_ids,omitempty"`
	LockEditing             bool      `json:"lock_editing"`
	Hidden                  bool      `json:"hidden,omitempty"`
	CanEdit                 bool      `json:"can_edit"`
	MaskedForCurrentUser    bool      `json:"masked_for_current_user"`
	ProtectedAt             time.Time `json:"protected_at"`
}

type ProtectionSnapshot struct {
	Rows    []ProtectionInfo `json:"rows"`
	Columns []ProtectionInfo `json:"columns"`
	Cells   []ProtectionInfo `json:"cells"`
}

type CreateSheetRequest struct {
	Name    string          `json:"name" binding:"required"`
	Columns json.RawMessage `json:"columns"`
}

type UpdateSheetRequest struct {
	Name        *string          `json:"name"`
	Columns     *json.RawMessage `json:"columns"`
	SortOrder   *int             `json:"sort_order"`
	Frozen      *json.RawMessage `json:"frozen"`
	Config      *json.RawMessage `json:"config"`
	CellChanges []CellUpdate     `json:"cell_changes"`
}

type CellUpdate struct {
	SheetID int64           `json:"sheet_id"`
	Row     int             `json:"row"`
	Col     string          `json:"col"`
	Value   json.RawMessage `json:"value"`
}

type BatchUpdateRequest struct {
	Changes []CellUpdate `json:"changes"`
}
