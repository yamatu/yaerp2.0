package model

import (
	"encoding/json"
	"time"
)

type OperationLog struct {
	ID           int64           `json:"id" db:"id"`
	UserID       *int64          `json:"user_id,omitempty" db:"user_id"`
	Username     string          `json:"username" db:"username"`
	SheetID      *int64          `json:"sheet_id,omitempty" db:"sheet_id"`
	SheetName    string          `json:"sheet_name" db:"sheet_name"`
	WorkbookID   *int64          `json:"workbook_id,omitempty" db:"workbook_id"`
	WorkbookName string          `json:"workbook_name" db:"workbook_name"`
	ResourceType string          `json:"resource_type" db:"resource_type"`
	ResourceID   *int64          `json:"resource_id,omitempty" db:"resource_id"`
	RowIndex     *int            `json:"row_index,omitempty" db:"row_index"`
	ColumnKey    *string         `json:"column_key,omitempty" db:"column_key"`
	Action       string          `json:"action" db:"action"`
	Source       string          `json:"source" db:"source"`
	Summary      string          `json:"summary" db:"summary"`
	OldValue     json.RawMessage `json:"old_value,omitempty" db:"old_value"`
	NewValue     json.RawMessage `json:"new_value,omitempty" db:"new_value"`
	Metadata     json.RawMessage `json:"metadata,omitempty" db:"metadata"`
	RequestID    string          `json:"request_id,omitempty" db:"request_id"`
	IPAddress    string          `json:"ip_address,omitempty" db:"ip_address"`
	UserAgent    string          `json:"user_agent,omitempty" db:"user_agent"`
	CreatedAt    time.Time       `json:"created_at" db:"created_at"`
}

type OperationLogFilter struct {
	SheetID  *int64
	UserID   *int64
	Action   string
	Source   string
	Keyword  string
	From     *time.Time
	To       *time.Time
	Page     int
	PageSize int
}

type OperationEvent struct {
	UserID       int64
	SheetID      int64
	ResourceType string
	ResourceID   int64
	Action       string
	Source       string
	Summary      string
	OldValue     any
	NewValue     any
	Metadata     any
	RequestID    string
	IPAddress    string
	UserAgent    string
}

type Attachment struct {
	ID           int64     `json:"id" db:"id"`
	Filename     string    `json:"filename" db:"filename"`
	MimeType     string    `json:"mime_type" db:"mime_type"`
	Size         int64     `json:"size" db:"size"`
	Bucket       string    `json:"bucket" db:"bucket"`
	ObjectKey    string    `json:"object_key" db:"object_key"`
	ContentHash  string    `json:"-" db:"content_hash"`
	UploaderID   int64     `json:"uploader_id" db:"uploader_id"`
	UploaderName string    `json:"uploader_name,omitempty" db:"uploader_name"`
	CreatedAt    time.Time `json:"created_at" db:"created_at"`
}
