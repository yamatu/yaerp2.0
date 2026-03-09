package model

import (
	"encoding/json"
	"time"
)

type OperationLog struct {
	ID        int64           `json:"id" db:"id"`
	UserID    int64           `json:"user_id" db:"user_id"`
	SheetID   int64           `json:"sheet_id" db:"sheet_id"`
	RowIndex  *int            `json:"row_index" db:"row_index"`
	ColumnKey *string         `json:"column_key" db:"column_key"`
	Action    string          `json:"action" db:"action"`
	OldValue  json.RawMessage `json:"old_value" db:"old_value"`
	NewValue  json.RawMessage `json:"new_value" db:"new_value"`
	CreatedAt time.Time       `json:"created_at" db:"created_at"`
}

type Attachment struct {
	ID         int64     `json:"id" db:"id"`
	Filename   string    `json:"filename" db:"filename"`
	MimeType   string    `json:"mime_type" db:"mime_type"`
	Size       int64     `json:"size" db:"size"`
	Bucket     string    `json:"bucket" db:"bucket"`
	ObjectKey  string    `json:"object_key" db:"object_key"`
	UploaderID int64     `json:"uploader_id" db:"uploader_id"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
}
