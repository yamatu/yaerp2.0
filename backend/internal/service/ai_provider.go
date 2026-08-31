package service

import (
	"encoding/json"
	"fmt"
	"strings"
)

type openAIResponsesResult struct {
	ID         string            `json:"id"`
	Model      string            `json:"model"`
	OutputText string            `json:"output_text"`
	Output     []json.RawMessage `json:"output"`
}

type openAIResponsesOutput struct {
	ID        string                   `json:"id,omitempty"`
	Type      string                   `json:"type"`
	Role      string                   `json:"role,omitempty"`
	CallID    string                   `json:"call_id,omitempty"`
	Name      string                   `json:"name,omitempty"`
	Arguments string                   `json:"arguments,omitempty"`
	Content   []openAIResponsesContent `json:"content,omitempty"`
}

type openAIResponsesContent struct {
	Type string `json:"type"`
	Text string `json:"text,omitempty"`
}

func (s *AIService) callAssistantCompletion(assistant *activeAIAssistant, messages []ChatMessage) (*ChatResponse, error) {
	if assistant == nil {
		return nil, fmt.Errorf("AI 助手配置不能为空")
	}
	if assistant.APIProtocol != "responses" {
		return s.callChatCompletion(assistant.Endpoint, assistant.APIKey, assistant.Model, messages)
	}

	conversation := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		conversation = append(conversation, map[string]any{"role": message.Role, "content": message.Content})
	}
	result, _, err := s.callResponsesAPI(assistant, conversation, nil)
	if err != nil {
		return nil, err
	}
	return &ChatResponse{Reply: responsesText(result), Model: firstNonEmpty(result.Model, assistant.Model)}, nil
}

// callAssistantCompletionJSON uses Responses Structured Outputs when the
// configured endpoint supports it. Compatible Chat Completions endpoints keep
// the existing prompt-only behavior so older providers remain usable.
func (s *AIService) callAssistantCompletionJSON(assistant *activeAIAssistant, messages []ChatMessage, schema map[string]any) (*ChatResponse, error) {
	if assistant == nil || assistant.APIProtocol != "responses" {
		return s.callAssistantCompletion(assistant, messages)
	}
	conversation := make([]map[string]any, 0, len(messages))
	for _, message := range messages {
		conversation = append(conversation, map[string]any{"role": message.Role, "content": message.Content})
	}
	result, _, err := s.callResponsesAPI(assistant, conversation, nil, schema)
	if err != nil {
		return nil, err
	}
	return &ChatResponse{Reply: responsesText(result), Model: firstNonEmpty(result.Model, assistant.Model)}, nil
}

func (s *AIService) callAssistantCompletionWithTools(assistant *activeAIAssistant, messages []map[string]any, tools []openAIToolDefinition) (*openAIChatToolResponse, map[string]any, error) {
	if assistant == nil {
		return nil, nil, fmt.Errorf("AI 助手配置不能为空")
	}
	if !assistant.SupportsTools {
		tools = nil
	}
	if assistant.APIProtocol != "responses" {
		return s.callChatCompletionWithTools(assistant.Endpoint, assistant.APIKey, assistant.Model, messages, tools)
	}

	result, rawOutput, err := s.callResponsesAPI(assistant, messages, tools)
	if err != nil {
		return nil, nil, err
	}
	toolCalls := make([]openAIToolCall, 0)
	for _, rawOutput := range result.Output {
		output, err := decodeResponsesOutputItem(rawOutput)
		if err != nil {
			continue
		}
		if output.Type != "function_call" {
			continue
		}
		callID := strings.TrimSpace(output.CallID)
		if callID == "" {
			callID = output.ID
		}
		var call openAIToolCall
		call.ID = callID
		call.Type = "function"
		call.Function.Name = output.Name
		call.Function.Arguments = output.Arguments
		toolCalls = append(toolCalls, call)
	}

	synthetic, _ := json.Marshal(map[string]any{
		"model": result.Model,
		"choices": []any{map[string]any{"message": map[string]any{
			"role": "assistant", "content": responsesText(result), "tool_calls": toolCalls,
		}}},
	})
	var response openAIChatToolResponse
	if err := json.Unmarshal(synthetic, &response); err != nil {
		return nil, nil, fmt.Errorf("解析 Responses 工具调用失败: %w", err)
	}
	assistantMessage := map[string]any{
		"role":              "assistant",
		"content":           responsesText(result),
		"_responses_output": rawOutput,
	}
	return &response, assistantMessage, nil
}

func (s *AIService) callResponsesAPI(assistant *activeAIAssistant, messages []map[string]any, tools []openAIToolDefinition, formats ...map[string]any) (*openAIResponsesResult, []json.RawMessage, error) {
	instructions, input := buildResponsesInput(messages)
	requestBody := map[string]any{
		"model": assistant.Model,
		"input": input,
		"store": false,
	}
	// Stateless reasoning tool turns need the encrypted reasoning item echoed
	// by the Responses API so it can be replayed on the next request.
	if assistant.Provider == "openai" {
		requestBody["include"] = []string{"reasoning.encrypted_content"}
	}
	if strings.TrimSpace(instructions) != "" {
		requestBody["instructions"] = instructions
	}
	if assistant.ReasoningEffort != "" && assistant.ReasoningEffort != "auto" {
		requestBody["reasoning"] = map[string]any{"effort": assistant.ReasoningEffort}
	}
	if len(formats) > 0 && formats[0] != nil {
		requestBody["text"] = map[string]any{"format": formats[0]}
	}
	if len(tools) > 0 {
		requestBody["tools"] = responsesToolDefinitions(tools)
		requestBody["tool_choice"] = "auto"
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("编码 Responses 请求失败: %w", err)
	}
	endpoint := strings.TrimRight(assistant.Endpoint, "/")
	if !strings.HasSuffix(endpoint, "/responses") {
		endpoint += "/responses"
	}
	raw, err := doAIRequest(endpoint, assistant.APIKey, body)
	if err != nil {
		return nil, nil, err
	}
	result, err := decodeOpenAIResponses(raw)
	if err != nil {
		return nil, nil, fmt.Errorf("解析 OpenAI Responses 返回失败: %w", err)
	}
	rawOutput := append([]json.RawMessage(nil), result.Output...)
	if len(result.Output) == 0 && strings.TrimSpace(result.OutputText) == "" {
		return nil, nil, fmt.Errorf("OpenAI Responses 未返回内容")
	}
	return result, rawOutput, nil
}

func decodeOpenAIResponses(raw []byte) (*openAIResponsesResult, error) {
	var result openAIResponsesResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func decodeResponsesOutputItem(raw json.RawMessage) (*openAIResponsesOutput, error) {
	var output openAIResponsesOutput
	if err := json.Unmarshal(raw, &output); err != nil {
		return nil, err
	}
	return &output, nil
}

func buildResponsesInput(messages []map[string]any) (string, []any) {
	systemMessages := make([]string, 0)
	input := make([]any, 0, len(messages))
	for _, message := range messages {
		role := strings.TrimSpace(fmt.Sprint(message["role"]))
		if role == "system" {
			systemMessages = append(systemMessages, extractAIContent(message["content"]))
			continue
		}
		if outputs, ok := message["_responses_output"].([]json.RawMessage); ok {
			for _, output := range outputs {
				input = append(input, output)
			}
			continue
		}
		if outputs, ok := message["_responses_output"].([]map[string]any); ok {
			for _, output := range outputs {
				input = append(input, output)
			}
			continue
		}
		if role == "tool" {
			input = append(input, map[string]any{
				"type":    "function_call_output",
				"call_id": strings.TrimSpace(fmt.Sprint(message["tool_call_id"])),
				"output":  extractAIContent(message["content"]),
			})
			continue
		}
		if role != "user" && role != "assistant" {
			continue
		}
		input = append(input, map[string]any{"role": role, "content": responsesMessageContent(message["content"], role)})
	}
	return strings.Join(systemMessages, "\n\n"), input
}

func responsesMessageContent(value any, role string) any {
	parts, ok := value.([]map[string]any)
	if !ok {
		return extractAIContent(value)
	}
	result := make([]map[string]any, 0, len(parts))
	for _, part := range parts {
		switch strings.TrimSpace(fmt.Sprint(part["type"])) {
		case "text", "input_text", "output_text":
			partType := "input_text"
			if role == "assistant" {
				partType = "output_text"
			}
			result = append(result, map[string]any{"type": partType, "text": fmt.Sprint(part["text"])})
		case "image_url", "input_image":
			imageURL := ""
			if image, ok := part["image_url"].(map[string]any); ok {
				imageURL = fmt.Sprint(image["url"])
			} else {
				imageURL = fmt.Sprint(part["image_url"])
			}
			if imageURL != "" {
				result = append(result, map[string]any{"type": "input_image", "image_url": imageURL})
			}
		}
	}
	return result
}

func responsesToolDefinitions(tools []openAIToolDefinition) []map[string]any {
	result := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		item := map[string]any{
			"type": "function", "name": tool.Function.Name,
			"description": tool.Function.Description, "parameters": tool.Function.Parameters,
		}
		if tool.Function.Strict {
			item["strict"] = true
		}
		result = append(result, item)
	}
	return result
}

func responsesText(result *openAIResponsesResult) string {
	if result == nil {
		return ""
	}
	if strings.TrimSpace(result.OutputText) != "" {
		return strings.TrimSpace(result.OutputText)
	}
	parts := make([]string, 0)
	for _, rawOutput := range result.Output {
		output, err := decodeResponsesOutputItem(rawOutput)
		if err != nil {
			continue
		}
		if output.Type != "message" {
			continue
		}
		for _, content := range output.Content {
			if content.Type == "output_text" && strings.TrimSpace(content.Text) != "" {
				parts = append(parts, strings.TrimSpace(content.Text))
			}
		}
	}
	return strings.Join(parts, "\n")
}
