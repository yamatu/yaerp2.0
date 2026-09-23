package service

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// ---------------------------------------------------------------------------
// Streaming agent events
//
// The design follows the event model of the pi agent loop
// (https://github.com/earendil-works/pi): a turn is a single model request plus
// the tool calls it produced, and every observable step is published as an
// event instead of being buffered until the end. The transport is
// Server-Sent Events so a plain HTTP client can consume it.
// ---------------------------------------------------------------------------

// AgentEventType enumerates the events of one agent run.
type AgentEventType string

const (
	AgentEventStart       AgentEventType = "agent_start"
	AgentEventTurnStart   AgentEventType = "turn_start"
	AgentEventDelta       AgentEventType = "message_delta"
	AgentEventMessageEnd  AgentEventType = "message_end"
	AgentEventToolStart   AgentEventType = "tool_start"
	AgentEventToolEnd     AgentEventType = "tool_end"
	AgentEventPlan        AgentEventType = "plan"
	AgentEventTurnEnd     AgentEventType = "turn_end"
	AgentEventError       AgentEventType = "error"
	AgentEventEnd         AgentEventType = "agent_end"
	agentMaxParallelTools                = 4
)

// AgentEvent is one step of the agent loop.
type AgentEvent struct {
	Type AgentEventType `json:"type"`
	// Turn counts model requests, starting at 1.
	Turn int `json:"turn,omitempty"`
	// Delta carries incremental assistant text.
	Delta string `json:"delta,omitempty"`
	// MessageID identifies the assistant message the deltas belong to.
	MessageID string `json:"message_id,omitempty"`
	// Tool describes the tool a tool_start/tool_end event refers to.
	Tool *AgentToolEvent `json:"tool,omitempty"`
	// Result is sent with agent_end and, when available, with error events to
	// report changes committed before a later turn failed.
	Result *ChatResponse `json:"result,omitempty"`
	// Error is only sent with error events.
	Error string `json:"error,omitempty"`
}

// AgentToolEvent reports one tool call.
type AgentToolEvent struct {
	ID               string  `json:"id"`
	Name             string  `json:"name"`
	Label            string  `json:"label,omitempty"`
	Status           string  `json:"status,omitempty"`
	Summary          string  `json:"summary,omitempty"`
	Data             any     `json:"data,omitempty"`
	TouchedSheetIDs  []int64 `json:"touched_sheet_ids,omitempty"`
	ChangedSheetIDs  []int64 `json:"changed_sheet_ids,omitempty"`
	ResourcesChanged bool    `json:"resources_changed,omitempty"`
}

// AgentEventSink receives every event. Returning an error aborts the run, which
// is how a closed SSE connection stops the agent.
type AgentEventSink func(event AgentEvent) error

// ---------------------------------------------------------------------------
// Streaming provider calls
// ---------------------------------------------------------------------------

// streamDelta is a single incremental chunk from a Chat Completions stream.
type streamDelta struct {
	content   string
	toolCalls map[int]*streamToolCall
	finish    string
}

type streamToolCall struct {
	id        string
	name      string
	arguments strings.Builder
}

// callChatCompletionStream performs one streaming Chat Completions request and
// feeds every delta to the sink. It returns the fully assembled assistant
// message so the caller can keep the conversation going exactly like the
// non-streaming path.
func (s *AIService) callChatCompletionStream(
	ctx context.Context,
	assistant *activeAIAssistant,
	messages []map[string]any,
	tools []openAIToolDefinition,
	onDelta func(text string) error,
) (*openAIChatToolResponse, map[string]any, error) {
	requestBody := map[string]any{
		"model":    assistant.Model,
		"messages": messages,
		"stream":   true,
	}
	if len(tools) > 0 {
		requestBody["tools"] = tools
		requestBody["tool_choice"] = "auto"
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal request: %w", err)
	}

	chatURL := strings.TrimRight(assistant.Endpoint, "/")
	if !strings.HasSuffix(chatURL, "/chat/completions") {
		chatURL += "/chat/completions"
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if strings.TrimSpace(assistant.APIKey) != "" {
		request.Header.Set("Authorization", "Bearer "+assistant.APIKey)
	}

	response, err := s.aiStreamHTTPClient().Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("API request failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, nil, fmt.Errorf("API returned status %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}

	var (
		content   strings.Builder
		toolCalls = map[int]*streamToolCall{}
		order     []int
		finish    string
		complete  bool
		malformed bool
		model     = assistant.Model
	)

	reader := bufio.NewReaderSize(response.Body, 64*1024)
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return nil, nil, fmt.Errorf("read stream: %w", readErr)
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if payload == "[DONE]" {
				complete = true
				break
			}
			if payload != "" {
				delta, deltaErr := parseChatCompletionChunk(payload)
				if deltaErr != nil {
					// Text may still be displayed, but tool arguments from a stream
					// with missing chunks must never be trusted for mutations.
					malformed = true
					continue
				}
				if delta.finish != "" {
					finish = delta.finish
				}
				if delta.content != "" {
					content.WriteString(delta.content)
					if content.Len() > maxAIToolResultBytes {
						return nil, nil, fmt.Errorf("模型回答超过安全长度")
					}
					if onDelta != nil {
						if err := onDelta(delta.content); err != nil {
							return nil, nil, err
						}
					}
				}
				for index, call := range delta.toolCalls {
					if index < 0 || index >= agentMaxToolCallsPerTurn {
						return nil, nil, fmt.Errorf("一次工具调用超过安全上限")
					}
					existing, ok := toolCalls[index]
					if !ok {
						existing = &streamToolCall{}
						toolCalls[index] = existing
						order = append(order, index)
					}
					if call.id != "" {
						existing.id = call.id
					}
					if call.name != "" {
						existing.name = call.name
					}
					if existing.arguments.Len()+call.arguments.Len() > maxAIToolResultBytes {
						return nil, nil, fmt.Errorf("工具参数超过安全长度")
					}
					existing.arguments.WriteString(call.arguments.String())
				}
			}
		}
		if readErr == io.EOF {
			break
		}
	}

	// EOF is not a success signal: a dropped connection can leave a syntactically
	// valid but incomplete write call. Never execute tools without BOTH the
	// provider's finish reason and the terminal SSE marker.
	if !complete && finish == "" {
		return nil, nil, fmt.Errorf("模型流意外中断，未收到完成标记")
	}
	if len(order) > 0 && (malformed || !complete || (finish != "tool_calls" && finish != "length")) {
		return nil, nil, fmt.Errorf("工具调用未完整结束，已拒绝执行")
	}
	if finish == "length" && len(order) == 0 {
		return nil, nil, fmt.Errorf("模型回答被长度限制截断，请缩小请求后重试")
	}

	sort.Ints(order)
	assembled := make([]openAIToolCall, 0, len(order))
	for _, index := range order {
		call := toolCalls[index]
		if strings.TrimSpace(call.name) == "" {
			continue
		}
		id := call.id
		if id == "" {
			id = fmt.Sprintf("call_%d_%d", time.Now().UnixNano(), index)
		}
		assembled = append(assembled, openAIToolCall{
			ID:   id,
			Type: "function",
			Function: openAIToolFunctionCall{
				Name:      call.name,
				Arguments: call.arguments.String(),
			},
		})
	}

	result := &openAIChatToolResponse{Model: model}
	result.Choices = append(result.Choices, openAIChoice{})
	result.Choices[0].Message.Role = "assistant"
	result.Choices[0].Message.Content = content.String()
	result.Choices[0].Message.ToolCalls = assembled
	result.Choices[0].FinishReason = finish

	assistantMessage := map[string]any{
		"role":    "assistant",
		"content": content.String(),
	}
	if len(assembled) > 0 {
		assistantMessage["tool_calls"] = assembled
	}

	return result, assistantMessage, nil
}

// parseChatCompletionChunk decodes one `data:` payload of an SSE stream.
func parseChatCompletionChunk(payload string) (*streamDelta, error) {
	var chunk struct {
		Choices []struct {
			Delta struct {
				Content   any `json:"content"`
				ToolCalls []struct {
					Index    int    `json:"index"`
					ID       string `json:"id"`
					Function struct {
						Name      string `json:"name"`
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"delta"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
		return nil, err
	}
	delta := &streamDelta{toolCalls: map[int]*streamToolCall{}}
	if len(chunk.Choices) == 0 {
		return delta, nil
	}
	choice := chunk.Choices[0]
	delta.content = extractAIContent(choice.Delta.Content)
	delta.finish = choice.FinishReason
	for _, call := range choice.Delta.ToolCalls {
		entry := delta.toolCalls[call.Index]
		if entry == nil {
			entry = &streamToolCall{}
			delta.toolCalls[call.Index] = entry
		}
		if call.ID != "" {
			entry.id = call.ID
		}
		if call.Function.Name != "" {
			entry.name = call.Function.Name
		}
		entry.arguments.WriteString(call.Function.Arguments)
	}
	return delta, nil
}

// callResponsesStream streams a Responses API request and returns the same
// shape as the non-streaming helper so the loop stays protocol agnostic.
func (s *AIService) callResponsesStream(
	ctx context.Context,
	assistant *activeAIAssistant,
	messages []map[string]any,
	tools []openAIToolDefinition,
	onDelta func(text string) error,
) (*openAIChatToolResponse, map[string]any, error) {
	instructions, input := buildResponsesInput(messages)
	requestBody := map[string]any{
		"model":  assistant.Model,
		"input":  input,
		"store":  false,
		"stream": true,
	}
	if assistant.Provider == "openai" {
		requestBody["include"] = []string{"reasoning.encrypted_content"}
	}
	if strings.TrimSpace(instructions) != "" {
		requestBody["instructions"] = instructions
	}
	if assistant.ReasoningEffort != "" && assistant.ReasoningEffort != "auto" {
		requestBody["reasoning"] = map[string]any{"effort": assistant.ReasoningEffort}
	}
	if len(tools) > 0 {
		requestBody["tools"] = responsesToolDefinitions(tools)
		requestBody["tool_choice"] = "auto"
	}
	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal request: %w", err)
	}

	chatURL := strings.TrimRight(assistant.Endpoint, "/")
	if !strings.HasSuffix(chatURL, "/responses") {
		chatURL += "/responses"
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodPost, chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, nil, fmt.Errorf("create request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream")
	if strings.TrimSpace(assistant.APIKey) != "" {
		request.Header.Set("Authorization", "Bearer "+assistant.APIKey)
	}

	response, err := s.aiStreamHTTPClient().Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("API request failed: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
		return nil, nil, fmt.Errorf("API returned status %d: %s", response.StatusCode, strings.TrimSpace(string(message)))
	}

	var (
		text      strings.Builder
		output    []json.RawMessage
		completed *openAIResponsesResult
		failed    bool
	)

	reader := bufio.NewReaderSize(response.Body, 64*1024)
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil && readErr != io.EOF {
			return nil, nil, fmt.Errorf("read stream: %w", readErr)
		}
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "data:") {
			payload := strings.TrimSpace(strings.TrimPrefix(trimmed, "data:"))
			if payload != "" && payload != "[DONE]" {
				var event struct {
					Type     string          `json:"type"`
					Delta    string          `json:"delta"`
					Response json.RawMessage `json:"response"`
					Item     json.RawMessage `json:"item"`
				}
				if err := json.Unmarshal([]byte(payload), &event); err == nil {
					switch event.Type {
					case "response.output_text.delta":
						if event.Delta != "" {
							text.WriteString(event.Delta)
							if text.Len() > maxAIToolResultBytes {
								return nil, nil, fmt.Errorf("模型回答超过安全长度")
							}
							if onDelta != nil {
								if err := onDelta(event.Delta); err != nil {
									return nil, nil, err
								}
							}
						}
					case "response.output_item.done":
						if len(event.Item) > 0 {
							output = append(output, event.Item)
						}
					case "response.completed":
						if len(event.Response) > 0 {
							parsed := &openAIResponsesResult{}
							if err := json.Unmarshal(event.Response, parsed); err == nil {
								completed = parsed
							}
						}
					case "response.failed", "response.incomplete", "error":
						failed = true
					}
				}
			}
		}
		if readErr == io.EOF {
			break
		}
	}

	if failed || completed == nil || (completed.Status != "" && completed.Status != "completed") {
		return nil, nil, fmt.Errorf("模型流意外中断或未完成，工具调用未执行")
	}
	if len(completed.Output) == 0 && len(output) > 0 {
		completed.Output = output
	}
	if completed.OutputText == "" {
		completed.OutputText = text.String()
	}

	toolCalls := make([]openAIToolCall, 0)
	for _, rawOutput := range completed.Output {
		item, err := decodeResponsesOutputItem(rawOutput)
		if err != nil || item.Type != "function_call" {
			continue
		}
		callID := strings.TrimSpace(item.CallID)
		if callID == "" {
			callID = item.ID
		}
		if callID == "" || strings.TrimSpace(item.Name) == "" {
			return nil, nil, fmt.Errorf("Responses 工具调用缺少名称或 call_id，已拒绝执行")
		}
		toolCalls = append(toolCalls, openAIToolCall{
			ID:   callID,
			Type: "function",
			Function: openAIToolFunctionCall{
				Name:      item.Name,
				Arguments: item.Arguments,
			},
		})
	}

	reply := responsesText(completed)
	if reply == "" {
		reply = text.String()
	}

	result := &openAIChatToolResponse{Model: completed.Model}
	result.Choices = append(result.Choices, openAIChoice{})
	result.Choices[0].Message.Role = "assistant"
	result.Choices[0].Message.Content = reply
	result.Choices[0].Message.ToolCalls = toolCalls

	assistantMessage := map[string]any{
		"role":              "assistant",
		"content":           reply,
		"_responses_output": completed.Output,
	}
	return result, assistantMessage, nil
}
