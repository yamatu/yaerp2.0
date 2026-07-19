package model

import (
	"encoding/json"
	"time"
)

type SheetVersion struct {
	ID             int64           `json:"id" db:"id"`
	SheetID        int64           `json:"sheet_id" db:"sheet_id"`
	VersionNumber  int64           `json:"version_number" db:"version_number"`
	CreatedBy      *int64          `json:"created_by,omitempty" db:"created_by"`
	CreatedByName  string          `json:"created_by_name" db:"created_by_name"`
	Source         string          `json:"source" db:"source"`
	Summary        string          `json:"summary" db:"summary"`
	Checksum       string          `json:"checksum" db:"checksum"`
	ChangeCount    int             `json:"change_count" db:"change_count"`
	RestoredFromID *int64          `json:"restored_from_id,omitempty" db:"restored_from_id"`
	RestoredFrom   *int64          `json:"restored_from_version,omitempty" db:"restored_from_version"`
	CreatedAt      time.Time       `json:"created_at" db:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at" db:"updated_at"`
	CanViewDetails bool            `json:"can_view_details"`
	CanRestore     bool            `json:"can_restore"`
	Snapshot       json.RawMessage `json:"-" db:"snapshot"`
}

type SheetVersionSnapshot struct {
	SchemaVersion int                       `json:"schema_version"`
	Sheet         SheetVersionSheetSnapshot `json:"sheet"`
	Rows          []SheetVersionRowSnapshot `json:"rows"`
}

type SheetVersionSheetSnapshot struct {
	Name      string          `json:"name"`
	SortOrder int             `json:"sort_order"`
	Columns   json.RawMessage `json:"columns"`
	Frozen    json.RawMessage `json:"frozen"`
	Config    json.RawMessage `json:"config"`
}

type SheetVersionRowSnapshot struct {
	RowIndex int             `json:"row_index"`
	Data     json.RawMessage `json:"data"`
}

type SheetVersionCapture struct {
	UserID         int64
	SheetID        int64
	Source         string
	Summary        string
	Coalesce       bool
	Force          bool
	RestoredFromID *int64
}

type SheetVersionCellChange struct {
	Row      int             `json:"row"`
	Column   string          `json:"column"`
	OldValue json.RawMessage `json:"old_value,omitempty"`
	NewValue json.RawMessage `json:"new_value,omitempty"`
	Kind     string          `json:"kind"`
}

type SheetVersionFieldChange struct {
	Field    string          `json:"field"`
	OldValue json.RawMessage `json:"old_value,omitempty"`
	NewValue json.RawMessage `json:"new_value,omitempty"`
}

type SheetVersionDiff struct {
	Version            SheetVersion              `json:"version"`
	ChangedCells       int                       `json:"changed_cells"`
	AddedRows          int                       `json:"added_rows"`
	RemovedRows        int                       `json:"removed_rows"`
	ModifiedRows       int                       `json:"modified_rows"`
	FieldChanges       []SheetVersionFieldChange `json:"field_changes"`
	CellChanges        []SheetVersionCellChange  `json:"cell_changes"`
	CellChangesLimited bool                      `json:"cell_changes_limited"`
}

type CreateSheetCheckpointRequest struct {
	Summary string `json:"summary" binding:"omitempty,max=256"`
}

type RestoreSheetVersionRequest struct {
	Reason string `json:"reason" binding:"omitempty,max=256"`
}
