package service

import (
	"database/sql"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

type activeAIAssistant struct {
	model.AIAssistant
	APIKey string
}

type aiRowScanner interface {
	Scan(dest ...any) error
}

const aiAssistantSelectColumns = `
	id, name, description, endpoint, model, api_key, system_prompt,
	enabled, is_default, supports_vision, supports_files, created_by, created_at, updated_at`

func scanActiveAIAssistant(scanner aiRowScanner) (*activeAIAssistant, error) {
	var assistant activeAIAssistant
	err := scanner.Scan(
		&assistant.ID,
		&assistant.Name,
		&assistant.Description,
		&assistant.Endpoint,
		&assistant.Model,
		&assistant.APIKey,
		&assistant.SystemPrompt,
		&assistant.Enabled,
		&assistant.IsDefault,
		&assistant.SupportsVision,
		&assistant.SupportsFiles,
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
				ID:          0,
				Name:        "默认助手",
				Description: "系统默认 AI 助手",
				Model:       modelName,
				HasAPIKey:   strings.TrimSpace(s.getAPIKey()) != "",
				Enabled:     true,
				IsDefault:   true,
			})
		}
	}

	return items, nil
}

func (s *AIService) CreateAIAssistant(userID int64, input *model.AIAssistantInput) (*model.AIAssistant, error) {
	name := strings.TrimSpace(input.Name)
	endpoint := strings.TrimRight(strings.TrimSpace(input.Endpoint), "/")
	modelName := strings.TrimSpace(input.Model)
	if name == "" || endpoint == "" || modelName == "" {
		return nil, fmt.Errorf("助手名称、API 端点和模型名称不能为空")
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
		 (name, description, endpoint, model, api_key, system_prompt, enabled, is_default, supports_vision, supports_files, created_by)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		 RETURNING `+aiAssistantSelectColumns,
		name,
		strings.TrimSpace(input.Description),
		endpoint,
		modelName,
		strings.TrimSpace(input.APIKey),
		strings.TrimSpace(input.SystemPrompt),
		enabled,
		isDefault,
		input.SupportsVision,
		input.SupportsFiles,
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
	current, err := s.getAIAssistantByID(id, false)
	if err != nil {
		return nil, err
	}

	name := strings.TrimSpace(input.Name)
	endpoint := strings.TrimRight(strings.TrimSpace(input.Endpoint), "/")
	modelName := strings.TrimSpace(input.Model)
	if name == "" || endpoint == "" || modelName == "" {
		return nil, fmt.Errorf("助手名称、API 端点和模型名称不能为空")
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

	apiKey := current.APIKey
	if strings.TrimSpace(input.APIKey) != "" {
		apiKey = strings.TrimSpace(input.APIKey)
	}

	row := tx.QueryRow(
		`UPDATE ai_assistants
		 SET name = $2,
		     description = $3,
		     endpoint = $4,
		     model = $5,
		     api_key = $6,
		     system_prompt = $7,
		     enabled = $8,
		     is_default = $9,
		     supports_vision = $10,
		     supports_files = $11,
		     updated_at = NOW()
		 WHERE id = $1
		 RETURNING `+aiAssistantSelectColumns,
		id,
		name,
		strings.TrimSpace(input.Description),
		endpoint,
		modelName,
		apiKey,
		strings.TrimSpace(input.SystemPrompt),
		enabled,
		isDefault,
		input.SupportsVision,
		input.SupportsFiles,
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
			ID:          0,
			Name:        "默认助手",
			Description: "系统默认 AI 助手",
			Endpoint:    endpoint,
			Model:       modelName,
			HasAPIKey:   strings.TrimSpace(s.getAPIKey()) != "",
			Enabled:     true,
			IsDefault:   true,
		},
		APIKey: s.getAPIKey(),
	}, nil
}

func (s *AIService) aiAssistantsMigrated() bool {
	return strings.EqualFold(strings.TrimSpace(s.getSetting("ai_assistants_migrated")), "true")
}
