package service

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

const (
	settingTranslationEndpoint = "translation_endpoint"
	settingTranslationModel    = "translation_model"
	translationEngineName      = "翻译引擎"
	// Dedicated translation models cap output well below their input window,
	// so long mails are split on line boundaries and translated in parallel.
	translationChunkChars       = 3000
	translationChunkConcurrency = 4
)

type TranslationEngineConfig struct {
	Enabled  bool   `json:"enabled"`
	Endpoint string `json:"endpoint,omitempty"`
	Model    string `json:"model,omitempty"`
}

type TranslationEngineTestResult struct {
	Model       string `json:"model"`
	LatencyMS   int64  `json:"latency_ms"`
	Sample      string `json:"sample"`
	Translation string `json:"translation"`
}

var translationLanguageNames = map[string]string{
	"zh-CN": "Simplified Chinese",
	"zh-TW": "Traditional Chinese",
	"en":    "English",
	"es":    "Spanish",
	"it":    "Italian",
	"de":    "German",
	"fr":    "French",
	"pt":    "Portuguese",
	"ja":    "Japanese",
	"ko":    "Korean",
	"ar":    "Arabic",
	"ru":    "Russian",
}

func translationLanguageName(code string) string {
	code = strings.TrimSpace(code)
	if name, ok := translationLanguageNames[code]; ok {
		return name
	}
	if code == "" {
		return translationLanguageNames["zh-CN"]
	}
	return code
}

func (s *AIService) GetTranslationEngine(admin bool) TranslationEngineConfig {
	endpoint := strings.TrimSpace(s.getSetting(settingTranslationEndpoint))
	modelName := strings.TrimSpace(s.getSetting(settingTranslationModel))
	config := TranslationEngineConfig{Enabled: endpoint != "" && modelName != "", Model: modelName}
	if admin {
		config.Endpoint = endpoint
	}
	return config
}

func (s *AIService) translationEngineEnabled() bool {
	return s.GetTranslationEngine(false).Enabled
}

// UpdateTranslationEngine saves the engine endpoint and auto-detects its model.
// An empty endpoint disables the engine so translations fall back to AI assistants.
func (s *AIService) UpdateTranslationEngine(rawEndpoint string) (*TranslationEngineConfig, error) {
	endpoint := normalizeTranslationEndpoint(rawEndpoint)
	modelName := ""
	if endpoint != "" {
		parsed, err := url.Parse(endpoint)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil {
			return nil, fmt.Errorf("翻译接口地址必须是有效的 HTTP(S) 地址")
		}
		modelName, err = s.detectTranslationModel(endpoint)
		if err != nil {
			return nil, err
		}
	}
	for key, value := range map[string]string{settingTranslationEndpoint: endpoint, settingTranslationModel: modelName} {
		if _, err := s.db.Exec(
			`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
			 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
			key, value,
		); err != nil {
			return nil, fmt.Errorf("save setting %s: %w", key, err)
		}
	}
	config := s.GetTranslationEngine(true)
	return &config, nil
}

func normalizeTranslationEndpoint(value string) string {
	endpoint := strings.TrimRight(strings.TrimSpace(value), "/")
	endpoint = strings.TrimSuffix(endpoint, "/chat/completions")
	endpoint = strings.TrimSuffix(endpoint, "/models")
	return strings.TrimRight(endpoint, "/")
}

func (s *AIService) detectTranslationModel(endpoint string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, endpoint+"/models", nil)
	if err != nil {
		return "", fmt.Errorf("create request: %w", err)
	}
	resp, err := s.aiHTTPClient().Do(req)
	if err != nil {
		return "", fmt.Errorf("无法连接翻译接口: %w", err)
	}
	defer resp.Body.Close()
	body, err := readAIResponseBody(resp.Body)
	if err != nil {
		return "", fmt.Errorf("读取模型列表失败: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("翻译接口 /models 返回 HTTP %d", resp.StatusCode)
	}
	var parsed struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("翻译接口不是 OpenAI 兼容格式: %w", err)
	}
	first := ""
	for _, item := range parsed.Data {
		id := strings.TrimSpace(item.ID)
		if id == "" {
			continue
		}
		if strings.Contains(strings.ToLower(id), "translat") {
			return id, nil
		}
		if first == "" {
			first = id
		}
	}
	if first == "" {
		return "", fmt.Errorf("翻译接口没有返回可用模型")
	}
	return first, nil
}

func (s *AIService) TestTranslationEngine() (*TranslationEngineTestResult, error) {
	config := s.GetTranslationEngine(true)
	if !config.Enabled {
		return nil, fmt.Errorf("请先保存翻译接口地址")
	}
	sample := "Please confirm the proforma invoice.\nWhat is your lead time for 5,000 pcs?"
	started := time.Now()
	translated, err := s.callTranslationEngine(config, sample, "zh-CN")
	if err != nil {
		return nil, err
	}
	return &TranslationEngineTestResult{
		Model: config.Model, LatencyMS: time.Since(started).Milliseconds(), Sample: sample, Translation: translated,
	}, nil
}

func (s *AIService) callTranslationEngine(config TranslationEngineConfig, text, targetLanguage string) (string, error) {
	prompt := fmt.Sprintf(
		"Translate the following text into %s. Keep every line break exactly as in the source and output only the translation.\n\n%s",
		translationLanguageName(targetLanguage), text,
	)
	response, err := s.callChatCompletion(config.Endpoint, "", config.Model, []ChatMessage{{Role: "user", Content: prompt}})
	if err != nil {
		return "", fmt.Errorf("翻译引擎请求失败: %w", err)
	}
	translated := strings.TrimSpace(response.Reply)
	if translated == "" {
		return "", fmt.Errorf("翻译引擎未返回译文")
	}
	return translated, nil
}

func (s *AIService) translateWithEngine(config TranslationEngineConfig, sourceText, targetLanguage string, aligned bool) (*AITranslationResult, error) {
	chunks := chunkTranslationText(sourceText, translationChunkChars)
	if len(chunks) == 0 {
		return nil, fmt.Errorf("翻译内容不能为空")
	}

	translations := make([]string, len(chunks))
	errs := make([]error, len(chunks))
	sem := make(chan struct{}, translationChunkConcurrency)
	var wg sync.WaitGroup
	for index, chunk := range chunks {
		wg.Add(1)
		go func(index int, chunk string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			translations[index], errs[index] = s.callTranslationEngine(config, chunk, targetLanguage)
		}(index, chunk)
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return nil, err
		}
	}

	result := &AITranslationResult{AssistantName: translationEngineName, Model: config.Model, Content: strings.Join(translations, "\n\n")}
	if aligned {
		for index, chunk := range chunks {
			result.Segments = append(result.Segments, alignTranslationSegments(splitTranslationSegments(chunk), translations[index])...)
		}
		parts := make([]string, 0, len(result.Segments))
		for _, segment := range result.Segments {
			parts = append(parts, segment.Translation)
		}
		result.Content = strings.Join(parts, "\n")
	}
	return result, nil
}

// chunkTranslationText splits on line boundaries so each chunk stays under
// limit bytes; a single oversized line becomes its own chunk.
func chunkTranslationText(value string, limit int) []string {
	normalized := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n"))
	if normalized == "" {
		return nil
	}
	chunks := make([]string, 0, 1)
	var current strings.Builder
	for _, line := range strings.Split(normalized, "\n") {
		if current.Len() > 0 && current.Len()+len(line)+1 > limit {
			if chunk := strings.TrimSpace(current.String()); chunk != "" {
				chunks = append(chunks, chunk)
			}
			current.Reset()
		}
		if current.Len() > 0 {
			current.WriteByte('\n')
		}
		current.WriteString(line)
	}
	if chunk := strings.TrimSpace(current.String()); chunk != "" {
		chunks = append(chunks, chunk)
	}
	return chunks
}
