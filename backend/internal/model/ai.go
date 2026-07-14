package model

import "time"

type AIAssistant struct {
	ID             int64     `json:"id"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	Endpoint       string    `json:"endpoint,omitempty"`
	Model          string    `json:"model"`
	HasAPIKey      bool      `json:"has_api_key"`
	SystemPrompt   string    `json:"system_prompt,omitempty"`
	Enabled        bool      `json:"enabled"`
	IsDefault      bool      `json:"is_default"`
	SupportsVision bool      `json:"supports_vision"`
	SupportsFiles  bool      `json:"supports_files"`
	CreatedBy      *int64    `json:"created_by,omitempty"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type AIAssistantInput struct {
	Name           string `json:"name" binding:"required"`
	Description    string `json:"description"`
	Endpoint       string `json:"endpoint" binding:"required"`
	Model          string `json:"model" binding:"required"`
	APIKey         string `json:"api_key"`
	SystemPrompt   string `json:"system_prompt"`
	Enabled        bool   `json:"enabled"`
	IsDefault      bool   `json:"is_default"`
	SupportsVision bool   `json:"supports_vision"`
	SupportsFiles  bool   `json:"supports_files"`
}

type AISummaryMetric struct {
	Label string `json:"label"`
	Value string `json:"value"`
	Hint  string `json:"hint,omitempty"`
}

type AISummarySection struct {
	Title   string   `json:"title"`
	Body    string   `json:"body"`
	Bullets []string `json:"bullets,omitempty"`
}

type AISummarySource struct {
	WorkbookID   int64    `json:"workbook_id"`
	WorkbookName string   `json:"workbook_name"`
	SheetNames   []string `json:"sheet_names"`
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
	WorkbookIDs []int64 `json:"workbook_ids" binding:"required,min=1"`
	AssistantID *int64  `json:"assistant_id"`
	Prompt      string  `json:"prompt"`
}

type AISummaryUpdateRequest struct {
	Title   *string           `json:"title"`
	Content *AISummaryContent `json:"content"`
}
