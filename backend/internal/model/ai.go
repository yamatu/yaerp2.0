package model

import "time"

type AIAssistant struct {
	ID              int64     `json:"id"`
	Name            string    `json:"name"`
	Description     string    `json:"description"`
	Provider        string    `json:"provider"`
	APIProtocol     string    `json:"api_protocol"`
	Endpoint        string    `json:"endpoint,omitempty"`
	Model           string    `json:"model"`
	ReasoningEffort string    `json:"reasoning_effort"`
	HasAPIKey       bool      `json:"has_api_key"`
	SystemPrompt    string    `json:"system_prompt,omitempty"`
	Enabled         bool      `json:"enabled"`
	IsDefault       bool      `json:"is_default"`
	SupportsVision  bool      `json:"supports_vision"`
	SupportsFiles   bool      `json:"supports_files"`
	SupportsTools   bool      `json:"supports_tools"`
	CreatedBy       *int64    `json:"created_by,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type AIAssistantInput struct {
	Name            string `json:"name" binding:"required"`
	Description     string `json:"description"`
	Provider        string `json:"provider"`
	APIProtocol     string `json:"api_protocol"`
	Endpoint        string `json:"endpoint"`
	Model           string `json:"model" binding:"required"`
	ReasoningEffort string `json:"reasoning_effort"`
	APIKey          string `json:"api_key"`
	ClearAPIKey     bool   `json:"clear_api_key"`
	SystemPrompt    string `json:"system_prompt"`
	Enabled         bool   `json:"enabled"`
	IsDefault       bool   `json:"is_default"`
	SupportsVision  bool   `json:"supports_vision"`
	SupportsFiles   bool   `json:"supports_files"`
	SupportsTools   bool   `json:"supports_tools"`
}

type AISummaryMetric struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
}

type AISummarySection struct {
	Title   string          `json:"title"`
	Body    string          `json:"body"`
	Bullets []string        `json:"bullets,omitempty"`
	Table   *AISummaryTable `json:"table,omitempty"`
}

// AISummaryTable is a small result table (for example profit by product)
// shown inside a summary section.
type AISummaryTable struct {
	Columns []string   `json:"columns"`
	Rows    [][]string `json:"rows"`
}

type AISummarySource struct {
	WorkbookID   int64    `json:"workbook_id"`
	WorkbookName string   `json:"workbook_name"`
	SheetNames   []string `json:"sheet_names"`
	// Sheets lists the sheets read, with the range when only part was read.
	Sheets []AISummarySourceSheet `json:"sheets,omitempty"`
}

type AISummarySourceSheet struct {
	SheetID   int64  `json:"sheet_id"`
	SheetName string `json:"sheet_name"`
	Range     string `json:"range,omitempty"`
}

type AISummaryContent struct {
	Headline string             `json:"headline"`
	Overview string             `json:"overview"`
	Metrics  []AISummaryMetric  `json:"metrics"`
	Sections []AISummarySection `json:"sections"`
	Sources  []AISummarySource  `json:"sources"`
}

type AISummaryPage struct {
	ID                int64            `json:"id"`
	Title             string           `json:"title"`
	OwnerID           int64            `json:"owner_id"`
	OwnerName         string           `json:"owner_name,omitempty"`
	AssistantID       *int64           `json:"assistant_id,omitempty"`
	AssistantName     string           `json:"assistant_name,omitempty"`
	SourceWorkbookIDs []int64          `json:"source_workbook_ids"`
	Content           AISummaryContent `json:"content"`
	CreatedAt         time.Time        `json:"created_at"`
	UpdatedAt         time.Time        `json:"updated_at"`
}

type AISummaryGenerateRequest struct {
	Title       string  `json:"title" binding:"required"`
	WorkbookIDs []int64 `json:"workbook_ids"`
	// FolderIDs adds every workbook the user can open inside these folders.
	FolderIDs []int64 `json:"folder_ids"`
	// Sheets limits the analysis to single sheets, optionally to a range of
	// each; with only sheets selected, the rest of their workbooks is not read.
	Sheets      []AISummarySheetTarget `json:"sheets"`
	AssistantID *int64                 `json:"assistant_id"`
	Prompt      string                 `json:"prompt"`
}

// AISummarySheetTarget is one sheet of a summary. Range is an A1 range such
// as "A1:F200", "B:D" or "2:50"; empty means the whole sheet.
type AISummarySheetTarget struct {
	SheetID int64  `json:"sheet_id"`
	Range   string `json:"range"`
}

type AISummaryUpdateRequest struct {
	Title   *string           `json:"title"`
	Content *AISummaryContent `json:"content"`
}
