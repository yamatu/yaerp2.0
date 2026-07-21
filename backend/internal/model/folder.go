package model

import "time"

type Folder struct {
	ID            int64      `json:"id" db:"id"`
	Name          string     `json:"name" db:"name"`
	ParentID      *int64     `json:"parent_id" db:"parent_id"`
	OwnerID       int64      `json:"owner_id" db:"owner_id"`
	OwnerName     *string    `json:"owner_name,omitempty" db:"owner_name"`
	AccessLevel   string     `json:"access_level,omitempty" db:"access_level"`
	CanWrite      bool       `json:"can_write,omitempty" db:"can_write"`
	CanManage     bool       `json:"can_manage,omitempty" db:"can_manage"`
	DeletedAt     *time.Time `json:"deleted_at,omitempty" db:"deleted_at"`
	DeletedByID   *int64     `json:"deleted_by_id,omitempty" db:"deleted_by"`
	DeletedByName *string    `json:"deleted_by_name,omitempty" db:"deleted_by_name"`
	CreatedAt     time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at" db:"updated_at"`
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

type FolderOption struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Path     string `json:"path"`
	ParentID *int64 `json:"parent_id,omitempty"`
	OwnerID  int64  `json:"owner_id"`
	CanWrite bool   `json:"can_write"`
}

type SetFolderVisibilityRequest struct {
	Visibility []FolderVisibility `json:"visibility" binding:"required"`
}

type FolderShareUser struct {
	ID          int64  `json:"id" db:"id"`
	Username    string `json:"username" db:"username"`
	Email       string `json:"email" db:"email"`
	AccessLevel string `json:"access_level" db:"access_level"`
}

type FolderShareEntry struct {
	UserID      int64  `json:"user_id" binding:"required"`
	AccessLevel string `json:"access_level" binding:"required,oneof=view edit"`
}

type SetFolderSharesRequest struct {
	Shares []FolderShareEntry `json:"shares"`
}

type FolderContents struct {
	Folders   []Folder   `json:"folders"`
	Workbooks []Workbook `json:"workbooks"`
}

type RecycleBinContents struct {
	Folders       []Folder            `json:"folders"`
	Workbooks     []Workbook          `json:"workbooks"`
	TradeOrders   []DeletedTradeOrder `json:"trade_orders"`
	RetentionDays int                 `json:"retention_days"`
}

type DeletedTradeOrder struct {
	ID                   int64      `json:"id"`
	OrderNo              string     `json:"order_no"`
	Title                string     `json:"title"`
	Stage                string     `json:"stage"`
	CustomerName         string     `json:"customer_name"`
	CustomerCompany      string     `json:"customer_company"`
	OwnerID              int64      `json:"owner_id"`
	OwnerName            string     `json:"owner_name"`
	WorkbookID           *int64     `json:"workbook_id,omitempty"`
	WorkbookName         string     `json:"workbook_name"`
	ItemCount            int64      `json:"item_count"`
	SupplierQuoteCount   int64      `json:"supplier_quote_count"`
	CustomerQuoteCount   int64      `json:"customer_quote_count"`
	StageEventCount      int64      `json:"stage_event_count"`
	InspectionPhotoCount int64      `json:"inspection_photo_count"`
	DeletedAt            *time.Time `json:"deleted_at,omitempty"`
	DeletedByID          *int64     `json:"deleted_by_id,omitempty"`
	DeletedByName        *string    `json:"deleted_by_name,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	UpdatedAt            time.Time  `json:"updated_at"`
}
