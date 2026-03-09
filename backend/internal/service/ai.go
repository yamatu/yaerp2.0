package service

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"yaerp/config"
)

type AIService struct {
	cfg *config.Config
	db  *sql.DB
}

func NewAIService(cfg *config.Config, db *sql.DB) *AIService {
	return &AIService{cfg: cfg, db: db}
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Messages []ChatMessage `json:"messages" binding:"required"`
}

type ChatResponse struct {
	Reply string `json:"reply"`
	Model string `json:"model"`
}

type AIConfigStatus struct {
	Configured bool   `json:"configured"`
	Endpoint   string `json:"endpoint"`
	Model      string `json:"model"`
}

// GetConfig returns the current AI configuration status (non-sensitive).
func (s *AIService) GetConfig() *AIConfigStatus {
	endpoint, model := s.getActiveConfig()
	return &AIConfigStatus{
		Configured: endpoint != "",
		Endpoint:   endpoint,
		Model:      model,
	}
}

// UpdateConfig persists AI config to the settings table.
func (s *AIService) UpdateConfig(endpoint, apiKey, model string) error {
	settings := map[string]string{
		"ai_endpoint": endpoint,
		"ai_api_key":  apiKey,
		"ai_model":    model,
	}
	for key, value := range settings {
		_, err := s.db.Exec(
			`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
			 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
			key, value,
		)
		if err != nil {
			return fmt.Errorf("save setting %s: %w", key, err)
		}
	}
	return nil
}

// Chat sends messages to the OpenAI-compatible API and returns the response.
func (s *AIService) Chat(userID int64, messages []ChatMessage) (*ChatResponse, error) {
	endpoint, model := s.getActiveConfig()
	apiKey := s.getAPIKey()

	if endpoint == "" || apiKey == "" {
		return nil, fmt.Errorf("AI is not configured. Please set the API endpoint and key in admin settings")
	}

	// Build context from user's accessible sheet data
	context := s.buildUserContext(userID)

	// Prepend system message with context
	systemMsg := ChatMessage{
		Role: "system",
		Content: fmt.Sprintf(
			"你是 YaERP 智能助手，帮助用户分析和处理他们的表格数据。以下是用户当前可访问的工作簿摘要：\n\n%s\n\n"+
				"请基于这些数据回答用户的问题。如果用户的问题与表格数据无关，你也可以回答通用问题。"+
				"始终使用中文回复。",
			context,
		),
	}

	allMessages := append([]ChatMessage{systemMsg}, messages...)

	// Build request body
	requestBody := map[string]interface{}{
		"model":    model,
		"messages": allMessages,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	// Ensure endpoint ends with /chat/completions
	chatURL := strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(chatURL, "/chat/completions") {
		chatURL += "/chat/completions"
	}

	req, err := http.NewRequest("POST", chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Model string `json:"model"`
	}

	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(apiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI model")
	}

	return &ChatResponse{
		Reply: apiResp.Choices[0].Message.Content,
		Model: apiResp.Model,
	}, nil
}

// getActiveConfig returns endpoint and model, preferring DB settings over env vars.
func (s *AIService) getActiveConfig() (string, string) {
	endpoint := s.getSetting("ai_endpoint")
	if endpoint == "" {
		endpoint = s.cfg.AI.Endpoint
	}

	model := s.getSetting("ai_model")
	if model == "" {
		model = s.cfg.AI.Model
	}

	return endpoint, model
}

func (s *AIService) getAPIKey() string {
	key := s.getSetting("ai_api_key")
	if key == "" {
		key = s.cfg.AI.APIKey
	}
	return key
}

func (s *AIService) getSetting(key string) string {
	var value string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = $1`, key).Scan(&value)
	if err != nil {
		return ""
	}
	return value
}

// buildUserContext creates a summary of user's accessible data.
func (s *AIService) buildUserContext(userID int64) string {
	rows, err := s.db.Query(
		`SELECT w.name, s.name,
		  (SELECT COUNT(*) FROM rows r WHERE r.sheet_id = s.id)
		 FROM workbooks w
		 JOIN sheets s ON s.workbook_id = w.id
		 WHERE w.owner_id = $1
		 ORDER BY w.name, s.sort_order
		 LIMIT 20`, userID,
	)
	if err != nil {
		return "无法加载用户数据。"
	}
	defer rows.Close()

	var sb strings.Builder
	currentWorkbook := ""

	for rows.Next() {
		var wbName, sheetName string
		var rowCount int
		if err := rows.Scan(&wbName, &sheetName, &rowCount); err != nil {
			continue
		}

		if wbName != currentWorkbook {
			if currentWorkbook != "" {
				sb.WriteString("\n")
			}
			sb.WriteString(fmt.Sprintf("工作簿「%s」：\n", wbName))
			currentWorkbook = wbName
		}
		sb.WriteString(fmt.Sprintf("  - 工作表「%s」（%d 行数据）\n", sheetName, rowCount))
	}

	if sb.Len() == 0 {
		return "用户暂无工作簿数据。"
	}

	return sb.String()
}
