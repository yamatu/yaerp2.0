package model

import "time"

type Folder struct {
	ID        int64     `json:"id" db:"id"`
	Name      string    `json:"name" db:"name"`
	ParentID  *int64    `json:"parent_id" db:"parent_id"`
	OwnerID   int64     `json:"owner_id" db:"owner_id"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
	UpdatedAt time.Time `json:"updated_at" db:"updated_at"`
}

type FolderVisibility struct {
	FolderID int64 `json:"folder_id" db:"folder_id"`
	RoleID   int64 `json:"role_id" db:"role_id"`
	Visible  bool  `json:"visible" db:"visible"`
}

type CreateFolderRequest struct {
	Name     string `json:"name" binding:"required"`
	ParentID *int64 `json:"parent_id"`
}

type UpdateFolderRequest struct {
	Name *string `json:"name"`
}

type MoveWorkbookRequest struct {
	FolderID *int64 `json:"folder_id"`
}

type SetFolderVisibilityRequest struct {
	Visibility []FolderVisibility `json:"visibility" binding:"required"`
}

type FolderContents struct {
	Folders   []Folder   `json:"folders"`
	Workbooks []Workbook `json:"workbooks"`
}
