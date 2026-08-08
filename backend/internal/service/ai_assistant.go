package service

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"strings"
	"time"

	"yaerp/internal/model"
)

type activeAIAssistant struct {
	model.AIAssistant
	APIKey string
}

type aiRowScanner interface {
	Scan(dest ...any) error
}

type AIAssistantTestResult struct {
	Provider   string `json:"provider"`
	Protocol   string `json:"protocol"`
	Model      string `json:"model"`
	LatencyMS  int64  `json:"latency_ms"`
	TextOK     bool   `json:"text_ok"`
	ToolCallOK bool   `json:"tool_call_ok"`
}

const aiAssistantSelectColumns = `
	id, name, description, provider, api_protocol, endpoint, model, reasoning_effort,
	api_key, system_prompt, enabled, is_default, supports_vision, supports_files,
	supports_tools, created_by, created_at, updated_at`

func scanActiveAIAssistant(scanner aiRowScanner) (*activeAIAssistant, error) {
	var assistant activeAIAssistant
	err := scanner.Scan(
		&assistant.ID,
		&assistant.Name,
		&assistant.Description,
		&assistant.Provider,
		&assistant.APIProtocol,
		&assistant.Endpoint,
		&assistant.Model,
		&assistant.ReasoningEffort,
		&assistant.APIKey,
		&assistant.SystemPrompt,
		&assistant.Enabled,
		&assistant.IsDefault,
		&assistant.SupportsVision,
		&assistant.SupportsFiles,
		&assistant.SupportsTools,
		&assistant.CreatedBy,
		&assistant.CreatedAt,
		&assistant.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	assistant.HasAPIKey = strings.TrimSpace(assistant.APIKey) != ""
	return &assistant, nil
}

func publicAIAssistant(item *activeAIAssistant, admin bool) model.AIAssistant {
	result := item.AIAssistant
	if !admin {
		result.Endpoint = ""
		result.SystemPrompt = ""
		result.CreatedBy = nil
	}
	return result
}

func (s *AIService) ListAIAssistants(admin bool) ([]model.AIAssistant, error) {
	query := `SELECT ` + aiAssistantSelectColumns + ` FROM ai_assistants`
	if !admin {
		query += ` WHERE enabled = TRUE`
	}
	query += ` ORDER BY is_default DESC, enabled DESC, id`

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("list AI assistants: %w", err)
	}
	defer rows.Close()

	items := make([]model.AIAssistant, 0)
	for rows.Next() {
		assistant, err := scanActiveAIAssistant(rows)
		if err != nil {
			return nil, fmt.Errorf("scan AI assistant: %w", err)
		}
		items = append(items, publicAIAssistant(assistant, admin))
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate AI assistants: %w", err)
	}

	if len(items) == 0 && !admin && !s.aiAssistantsMigrated() {
		endpoint, modelName := s.getActiveConfig()
		if strings.TrimSpace(endpoint) != "" && strings.TrimSpace(modelName) != "" {
			items = append(items, model.AIAssistant{
				ID:              0,
				Name:            "默认助手",
				Description:     "系统默认 AI 助手",
				Provider:        "openai_compatible",
				APIProtocol:     "chat_completions",
				Model:           modelName,
				ReasoningEffort: "auto",
				HasAPIKey:       strings.TrimSpace(s.getAPIKey()) != "",
				Enabled:         true,
				IsDefault:       true,
				SupportsTools:   true,
			})
		}
	}

	return items, nil
}

func (s *AIService) CreateAIAssistant(userID int64, input *model.AIAssistantInput) (*model.AIAssistant, error) {
	if input == nil {
		return nil, fmt.Errorf("AI 助手配置不能为空")
	}
	name, provider, protocol, endpoint, modelName, reasoningEffort, err := normalizeAIAssistantInput(input)
	if err != nil {
		return nil, err
	}
	if provider == "openai" && strings.TrimSpace(input.APIKey) == "" {
		return nil, fmt.Errorf("OpenAI 官方接口必须填写 API 密钥")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin AI assistant transaction: %w", err)
	}
	defer tx.Rollback()

	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM ai_assistants`).Scan(&count); err != nil {
		return nil, fmt.Errorf("count AI assistants: %w", err)
	}

	enabled := input.Enabled
	isDefault := input.IsDefault
	if count == 0 {
		enabled = true
		isDefault = true
	}
	if isDefault {
		enabled = true
		if _, err := tx.Exec(`UPDATE ai_assistants SET is_default = FALSE, updated_at = NOW() WHERE is_default = TRUE`); err != nil {
			return nil, fmt.Errorf("clear default AI assistant: %w", err)
		}
	}

	row := tx.QueryRow(
		`INSERT INTO ai_assistants
		 (name, description, provider, api_protocol, endpoint, model, reasoning_effort,
		  api_key, system_prompt, enabled, is_default, supports_vision, supports_files, supports_tools, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
		 RETURNING `+aiAssistantSelectColumns,
		name,
		strings.TrimSpace(input.Description),
		provider,
		protocol,
		endpoint,
		modelName,
		reasoningEffort,
		strings.TrimSpace(input.APIKey),
		strings.TrimSpace(input.SystemPrompt),
		enabled,
		isDefault,
		input.SupportsVision,
		input.SupportsFiles,
		input.SupportsTools,
		userID,
	)
	created, err := scanActiveAIAssistant(row)
	if err != nil {
		return nil, fmt.Errorf("create AI assistant: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit AI assistant: %w", err)
	}
	result := publicAIAssistant(created, true)
	return &result, nil
}

func (s *AIService) UpdateAIAssistant(id int64, input *model.AIAssistantInput) (*model.AIAssistant, error) {
	if input == nil {
		return nil, fmt.Errorf("AI 助手配置不能为空")
	}
	current, err := s.getAIAssistantByID(id, false)
	if err != nil {
		return nil, err
	}

	name, provider, protocol, endpoint, modelName, reasoningEffort, err := normalizeAIAssistantInput(input)
	if err != nil {
		return nil, err
	}
	if current.IsDefault && !input.Enabled {
		return nil, fmt.Errorf("默认助手不能停用，请先设置其他默认助手")
	}

	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin AI assistant transaction: %w", err)
	}
	defer tx.Rollback()

	isDefault := current.IsDefault || input.IsDefault
	enabled := input.Enabled || isDefault
	if input.IsDefault {
		if _, err := tx.Exec(`UPDATE ai_assistants SET is_default = FALSE, updated_at = NOW() WHERE id <> $1 AND is_default = TRUE`, id); err != nil {
			return nil, fmt.Errorf("clear default AI assistant: %w", err)
		}
	}

	apiKey, err := updatedAIAssistantAPIKey(current, provider, endpoint, input)
	if err != nil {
		return nil, err
	}

	row := tx.QueryRow(
		`UPDATE ai_assistants
		 SET name = $2,
		     description = $3,
		     provider = $4,
		     api_protocol = $5,
		     endpoint = $6,
		     model = $7,
		     reasoning_effort = $8,
		     api_key = $9,
		     system_prompt = $10,
		     enabled = $11,
		     is_default = $12,
		     supports_vision = $13,
		     supports_files = $14,
		     supports_tools = $15,
		     updated_at = NOW()
		 WHERE id = $1
		 RETURNING `+aiAssistantSelectColumns,
		id,
		name,
		strings.TrimSpace(input.Description),
		provider,
		protocol,
		endpoint,
		modelName,
		reasoningEffort,
		apiKey,
		strings.TrimSpace(input.SystemPrompt),
		enabled,
		isDefault,
		input.SupportsVision,
		input.SupportsFiles,
		input.SupportsTools,
	)
	updated, err := scanActiveAIAssistant(row)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("AI 助手不存在")
	}
	if err != nil {
		return nil, fmt.Errorf("update AI assistant: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit AI assistant: %w", err)
	}
	result := publicAIAssistant(updated, true)
	return &result, nil
}

func (s *AIService) SetDefaultAIAssistant(id int64) (*model.AIAssistant, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, fmt.Errorf("begin AI assistant transaction: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`UPDATE ai_assistants SET is_default = FALSE, updated_at = NOW() WHERE is_default = TRUE`); err != nil {
		return nil, fmt.Errorf("clear default AI assistant: %w", err)
	}
	row := tx.QueryRow(
		`UPDATE ai_assistants
		 SET enabled = TRUE, is_default = TRUE, updated_at = NOW()
		 WHERE id = $1
		 RETURNING `+aiAssistantSelectColumns,
		id,
	)
	updated, err := scanActiveAIAssistant(row)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("AI 助手不存在")
	}
	if err != nil {
		return nil, fmt.Errorf("set default AI assistant: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit default AI assistant: %w", err)
	}
	result := publicAIAssistant(updated, true)
	return &result, nil
}

func (s *AIService) TestAIAssistant(id int64) (*AIAssistantTestResult, error) {
	assistant, err := s.getAIAssistantByID(id, false)
	if err != nil {
		return nil, err
	}
	started := time.Now()
	response, err := s.callAssistantCompletion(assistant, []ChatMessage{
		{Role: "system", Content: "You are a connectivity test. Reply with exactly YAERP_OK."},
		{Role: "user", Content: "Run the connectivity test."},
	})
	if err != nil {
		return nil, err
	}
	result := &AIAssistantTestResult{
		Provider: assistant.Provider, Protocol: assistant.APIProtocol,
		Model: firstNonEmpty(response.Model, assistant.Model), LatencyMS: time.Since(started).Milliseconds(),
		TextOK: isAIConnectionTestText(response.Reply),
	}
	if !assistant.SupportsTools {
		return result, nil
	}
	tool := buildToolDefinition("yaerp_connection_test", "Return a YaERP connectivity-test acknowledgement.", map[string]any{
		"type":                 "object",
		"properties":           map[string]any{"message": map[string]any{"type": "string"}},
		"required":             []string{"message"},
		"additionalProperties": false,
	})
	toolResponse, _, toolErr := s.callAssistantCompletionWithTools(assistant, []map[string]any{
		{"role": "system", "content": "This is a connection test. You must call yaerp_connection_test once with message YAERP_OK."},
		{"role": "user", "content": "Call the test function now."},
	}, []openAIToolDefinition{tool})
	if toolErr == nil && toolResponse != nil && len(toolResponse.Choices) > 0 {
		result.ToolCallOK = isAIConnectionTestToolCall(toolResponse.Choices[0].Message.ToolCalls)
	}
	result.LatencyMS = time.Since(started).Milliseconds()
	return result, nil
}

func isAIConnectionTestText(reply string) bool {
	return strings.TrimSpace(reply) == "YAERP_OK"
}

func isAIConnectionTestToolCall(calls []openAIToolCall) bool {
	if len(calls) != 1 || calls[0].Function.Name != "yaerp_connection_test" {
		return false
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal([]byte(calls[0].Function.Arguments), &args); err != nil || len(args) != 1 {
		return false
	}
	message, ok := args["message"]
	if !ok {
		return false
	}
	var value string
	if err := json.Unmarshal(message, &value); err != nil {
		return false
	}
	return value == "YAERP_OK"
}

func (s *AIService) DeleteAIAssistant(id int64) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin AI assistant transaction: %w", err)
	}
	defer tx.Rollback()

	var wasDefault bool
	if err := tx.QueryRow(`SELECT is_default FROM ai_assistants WHERE id = $1`, id).Scan(&wasDefault); err == sql.ErrNoRows {
		return fmt.Errorf("AI 助手不存在")
	} else if err != nil {
		return fmt.Errorf("load AI assistant: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM ai_assistants WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete AI assistant: %w", err)
	}
	if wasDefault {
		if _, err := tx.Exec(
			`UPDATE ai_assistants
			 SET is_default = TRUE, updated_at = NOW()
			 WHERE id = (
			     SELECT id FROM ai_assistants WHERE enabled = TRUE ORDER BY id LIMIT 1
			 )`,
		); err != nil {
			return fmt.Errorf("select replacement default AI assistant: %w", err)
		}
	}
	return tx.Commit()
}

func (s *AIService) getAIAssistantByID(id int64, enabledOnly bool) (*activeAIAssistant, error) {
	query := `SELECT ` + aiAssistantSelectColumns + ` FROM ai_assistants WHERE id = $1`
	if enabledOnly {
		query += ` AND enabled = TRUE`
	}
	assistant, err := scanActiveAIAssistant(s.db.QueryRow(query, id))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("AI 助手不存在或已停用")
	}
	if err != nil {
		return nil, fmt.Errorf("load AI assistant: %w", err)
	}
	return assistant, nil
}

func (s *AIService) resolveAIAssistant(id int64) (*activeAIAssistant, error) {
	if id > 0 {
		return s.getAIAssistantByID(id, true)
	}

	assistant, err := scanActiveAIAssistant(s.db.QueryRow(
		`SELECT ` + aiAssistantSelectColumns + `
		 FROM ai_assistants
		 WHERE enabled = TRUE
		 ORDER BY is_default DESC, id
		 LIMIT 1`,
	))
	if err == nil {
		return assistant, nil
	}
	if err != sql.ErrNoRows {
		return nil, fmt.Errorf("load default AI assistant: %w", err)
	}
	if s.aiAssistantsMigrated() {
		return nil, fmt.Errorf("AI 未配置，请先在管理后台添加助手")
	}

	endpoint, modelName := s.getActiveConfig()
	if strings.TrimSpace(endpoint) == "" || strings.TrimSpace(modelName) == "" {
		return nil, fmt.Errorf("AI 未配置，请先在管理后台添加助手")
	}
	return &activeAIAssistant{
		AIAssistant: model.AIAssistant{
			ID:              0,
			Name:            "默认助手",
			Description:     "系统默认 AI 助手",
			Provider:        "openai_compatible",
			APIProtocol:     "chat_completions",
			Endpoint:        endpoint,
			Model:           modelName,
			ReasoningEffort: "auto",
			HasAPIKey:       strings.TrimSpace(s.getAPIKey()) != "",
			Enabled:         true,
			IsDefault:       true,
			SupportsTools:   true,
		},
		APIKey: s.getAPIKey(),
	}, nil
}

func normalizeAIAssistantInput(input *model.AIAssistantInput) (name, provider, protocol, endpoint, modelName, reasoningEffort string, err error) {
	name = strings.TrimSpace(input.Name)
	provider = strings.ToLower(strings.TrimSpace(input.Provider))
	if provider == "" {
		provider = "openai_compatible"
	}
	if provider != "openai" && provider != "openai_compatible" {
		err = fmt.Errorf("不支持的 AI 提供商")
		return
	}
	protocol = strings.ToLower(strings.TrimSpace(input.APIProtocol))
	if protocol == "" {
		if provider == "openai" {
			protocol = "responses"
		} else {
			protocol = "chat_completions"
		}
	}
	if protocol != "responses" && protocol != "chat_completions" {
		err = fmt.Errorf("不支持的 AI API 协议")
		return
	}
	if provider == "openai" {
		endpoint = "https://api.openai.com/v1"
		protocol = "responses"
	} else {
		endpoint = strings.TrimRight(strings.TrimSpace(input.Endpoint), "/")
	}
	modelName = strings.TrimSpace(input.Model)
	if name == "" || endpoint == "" || modelName == "" {
		err = fmt.Errorf("助手名称、API 端点和模型名称不能为空")
		return
	}
	parsedURL, parseErr := url.Parse(endpoint)
	if parseErr != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") || parsedURL.User != nil {
		err = fmt.Errorf("API 端点必须是有效的 HTTP(S) 地址")
		return
	}
	reasoningEffort = strings.ToLower(strings.TrimSpace(input.ReasoningEffort))
	if reasoningEffort == "" {
		reasoningEffort = "auto"
	}
	switch reasoningEffort {
	case "auto", "none", "minimal", "low", "medium", "high", "xhigh", "max":
	default:
		err = fmt.Errorf("不支持的模型能力等级")
	}
	return
}

func updatedAIAssistantAPIKey(current *activeAIAssistant, provider, endpoint string, input *model.AIAssistantInput) (string, error) {
	if current == nil || input == nil {
		return "", fmt.Errorf("AI 助手配置不能为空")
	}
	if input.ClearAPIKey {
		if provider == "openai" {
			return "", fmt.Errorf("OpenAI 官方接口必须保留或填写 API 密钥")
		}
		return "", nil
	}
	if apiKey := strings.TrimSpace(input.APIKey); apiKey != "" {
		return apiKey, nil
	}

	// A saved bearer token belongs to its current trust boundary. Never send it
	// to a newly selected provider or endpoint unless the administrator enters
	// it again explicitly.
	sameCredentialBoundary := current.Provider == provider && strings.TrimRight(strings.TrimSpace(current.Endpoint), "/") == endpoint
	if sameCredentialBoundary {
		if provider == "openai" && strings.TrimSpace(current.APIKey) == "" {
			return "", fmt.Errorf("OpenAI 官方接口必须保留或填写 API 密钥")
		}
		return current.APIKey, nil
	}
	if provider == "openai" {
		return "", fmt.Errorf("切换到 OpenAI 官方接口时必须重新填写 API 密钥")
	}
	return "", nil
}

func (s *AIService) aiAssistantsMigrated() bool {
	return strings.EqualFold(strings.TrimSpace(s.getSetting("ai_assistants_migrated")), "true")
}
