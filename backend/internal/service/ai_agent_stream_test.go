package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"yaerp/internal/model"
)

func TestParseChatCompletionChunkAssemblesContentAndToolCalls(t *testing.T) {
	delta, err := parseChatCompletionChunk(`{"choices":[{"delta":{"content":"你好"},"finish_reason":""}]}`)
	if err != nil {
		t.Fatalf("parse content chunk: %v", err)
	}
	if delta.content != "你好" {
		t.Fatalf("content = %q, want 你好", delta.content)
	}

	first, err := parseChatCompletionChunk(`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"query_sheet","arguments":"{\"sheet"}}]}}]}`)
	if err != nil {
		t.Fatalf("parse tool chunk: %v", err)
	}
	call, ok := first.toolCalls[0]
	if !ok {
		t.Fatalf("expected tool call at index 0")
	}
	if call.name != "query_sheet" {
		t.Fatalf("tool name = %q", call.name)
	}

	second, err := parseChatCompletionChunk(`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"_id\":1}"}}]}}]}`)
	if err != nil {
		t.Fatalf("parse second tool chunk: %v", err)
	}
	call.arguments.WriteString(second.toolCalls[0].arguments.String())
	if got := call.arguments.String(); got != `{"sheet_id":1}` {
		t.Fatalf("arguments = %q, want {\"sheet_id\":1}", got)
	}
}

func TestParseChatCompletionChunkIgnoresEmptyChoices(t *testing.T) {
	delta, err := parseChatCompletionChunk(`{"choices":[]}`)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if delta.content != "" || len(delta.toolCalls) != 0 {
		t.Fatalf("expected empty delta, got %+v", delta)
	}
}

func TestParseChatCompletionChunkRejectsInvalidJSON(t *testing.T) {
	if _, err := parseChatCompletionChunk("{not json"); err == nil {
		t.Fatal("expected an error for malformed payload")
	}
}

// buildOpenAIStreamServer returns a stub Chat Completions endpoint that streams
// a fixed SSE body.
func buildOpenAIStreamServer(t *testing.T, body string, status int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method = %s, want POST", r.Method)
		}
		if got := r.Header.Get("Accept"); got != "text/event-stream" {
			t.Errorf("Accept = %q, want text/event-stream", got)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode request: %v", err)
		}
		if stream, ok := payload["stream"].(bool); !ok || !stream {
			t.Errorf("stream flag missing or false: %v", payload["stream"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
}

func TestCallChatCompletionStreamCollectsDeltas(t *testing.T) {
	server := buildOpenAIStreamServer(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"库存"}}]}`,
		"",
		`data: {"choices":[{"delta":{"content":"充足"}}]}`,
		"",
		`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		"",
		"data: [DONE]",
		"",
	}, "\n"), http.StatusOK)
	defer server.Close()

	service := &AIService{}
	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test-model", APIProtocol: "chat"}}

	var (
		mu       sync.Mutex
		streamed strings.Builder
	)
	result, message, err := service.callChatCompletionStream(
		context.Background(),
		assistant,
		[]map[string]any{{"role": "user", "content": "hi"}},
		nil,
		func(text string) error {
			mu.Lock()
			defer mu.Unlock()
			streamed.WriteString(text)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("stream call failed: %v", err)
	}
	if got := streamed.String(); got != "库存充足" {
		t.Fatalf("streamed text = %q, want 库存充足", got)
	}
	if got := extractAIContent(result.Choices[0].Message.Content); got != "库存充足" {
		t.Fatalf("assembled content = %q", got)
	}
	if result.Choices[0].FinishReason != "stop" {
		t.Fatalf("finish reason = %q", result.Choices[0].FinishReason)
	}
	if got := extractAIContent(message["content"]); got != "库存充足" {
		t.Fatalf("assistant message content = %q", got)
	}
}

func TestCallChatCompletionStreamAssemblesSplitToolCall(t *testing.T) {
	server := buildOpenAIStreamServer(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","function":{"name":"query_sheet","arguments":"{\"sheet_id\":"}}]}}]}`,
		"",
		`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"7}"}}]}}]}`,
		"",
		`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
		"",
		"data: [DONE]",
		"",
	}, "\n"), http.StatusOK)
	defer server.Close()

	service := &AIService{}
	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test-model", APIProtocol: "chat"}}

	result, message, err := service.callChatCompletionStream(
		context.Background(), assistant,
		[]map[string]any{{"role": "user", "content": "hi"}},
		[]openAIToolDefinition{{Type: "function", Function: openAIToolFunction{Name: "query_sheet"}}},
		nil,
	)
	if err != nil {
		t.Fatalf("stream call failed: %v", err)
	}
	calls := result.Choices[0].Message.ToolCalls
	if len(calls) != 1 {
		t.Fatalf("expected 1 tool call, got %d", len(calls))
	}
	if calls[0].Function.Name != "query_sheet" {
		t.Fatalf("tool name = %q", calls[0].Function.Name)
	}
	if calls[0].ID != "call_a" {
		t.Fatalf("tool id = %q", calls[0].ID)
	}
	args := map[string]any{}
	if err := json.Unmarshal([]byte(calls[0].Function.Arguments), &args); err != nil {
		t.Fatalf("arguments are not valid JSON: %q", calls[0].Function.Arguments)
	}
	if args["sheet_id"] != float64(7) {
		t.Fatalf("sheet_id = %v, want 7", args["sheet_id"])
	}
	if _, ok := message["tool_calls"]; !ok {
		t.Fatal("assistant message must carry tool_calls")
	}
}

func TestCallChatCompletionStreamSurfacesHTTPErrors(t *testing.T) {
	server := buildOpenAIStreamServer(t, `{"error":"bad key"}`, http.StatusUnauthorized)
	defer server.Close()

	service := &AIService{}
	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test-model", APIProtocol: "chat"}}

	_, _, err := service.callChatCompletionStream(
		context.Background(), assistant,
		[]map[string]any{{"role": "user", "content": "hi"}}, nil, nil,
	)
	if err == nil {
		t.Fatal("expected an error for a 401 response")
	}
	if !strings.Contains(err.Error(), "401") {
		t.Fatalf("error should mention the status code, got %v", err)
	}
}

func TestCallChatCompletionStreamStopsWhenSinkFails(t *testing.T) {
	server := buildOpenAIStreamServer(t, strings.Join([]string{
		`data: {"choices":[{"delta":{"content":"a"}}]}`,
		"",
		`data: {"choices":[{"delta":{"content":"b"}}]}`,
		"",
		"data: [DONE]",
		"",
	}, "\n"), http.StatusOK)
	defer server.Close()

	service := &AIService{}
	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test-model", APIProtocol: "chat"}}

	calls := 0
	_, _, err := service.callChatCompletionStream(
		context.Background(), assistant,
		[]map[string]any{{"role": "user", "content": "hi"}}, nil,
		func(string) error {
			calls++
			return context.Canceled
		},
	)
	if err == nil {
		t.Fatal("expected the sink error to abort the call")
	}
	if calls != 1 {
		t.Fatalf("sink called %d times, want 1", calls)
	}
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

// stubAgentService builds an AIService whose model endpoint replays the given
// SSE bodies in order. The assistant is supplied by PreparedAgentStream, so the
// service itself only needs the HTTP plumbing and a tool registry.
func stubAgentService(t *testing.T, responses []string) (*AIService, *int, string) {
	t.Helper()
	var (
		mu      sync.Mutex
		callSeq int
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		index := callSeq
		callSeq++
		mu.Unlock()
		if index >= len(responses) {
			index = len(responses) - 1
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(responses[index]))
	}))
	t.Cleanup(server.Close)

	service := &AIService{tools: map[string]ToolFunc{}}
	return service, &callSeq, server.URL
}

func TestAgentEventTypesAreStable(t *testing.T) {
	// The frontend switches on these exact strings, so they must not drift.
	expected := map[AgentEventType]string{
		AgentEventStart:      "agent_start",
		AgentEventTurnStart:  "turn_start",
		AgentEventDelta:      "message_delta",
		AgentEventMessageEnd: "message_end",
		AgentEventToolStart:  "tool_start",
		AgentEventToolEnd:    "tool_end",
		AgentEventPlan:       "plan",
		AgentEventTurnEnd:    "turn_end",
		AgentEventError:      "error",
		AgentEventEnd:        "agent_end",
	}
	for event, want := range expected {
		if string(event) != want {
			t.Fatalf("event %v = %q, want %q", event, string(event), want)
		}
	}
}

func TestReadOnlyToolClassification(t *testing.T) {
	if !readOnlyAgentTools["query_sheet"] {
		t.Fatal("query_sheet must be classified as read-only")
	}
	if readOnlyAgentTools["batch_update_cells"] {
		t.Fatal("batch_update_cells must not be classified as read-only")
	}
	if readOnlyAgentTools["update_cell"] {
		t.Fatal("update_cell must not be classified as read-only")
	}
	// Every read-only tool must exist in the label table so the UI can show it.
	for name := range readOnlyAgentTools {
		if _, ok := agentToolLabels[name]; !ok {
			t.Fatalf("tool %q has no display label", name)
		}
	}
}

func TestNewAdvancedToolsAreRegistered(t *testing.T) {
	service := &AIService{tools: map[string]ToolFunc{}}
	registry := service.buildToolRegistry()
	for _, name := range []string{
		"inspect_sheet_range",
		"batch_update_cells",
		"run_sheet_formulas",
		"sort_sheet_range",
		"filter_sheet_rows",
		"dedupe_sheet_rows",
		"run_spreadsheet_script",
	} {
		if _, ok := registry[name]; !ok {
			t.Fatalf("tool %q is not registered", name)
		}
	}

	defined := map[string]bool{}
	for _, definition := range service.buildToolDefinitions() {
		defined[definition.Function.Name] = true
	}
	for name := range registry {
		if !defined[name] {
			t.Fatalf("registered tool %q has no definition sent to the model", name)
		}
	}
}

func TestEncodeToolResultTruncatesOversizedPayloads(t *testing.T) {
	big := strings.Repeat("x", maxAIToolResultBytes+1)
	encoded := encodeToolResult(map[string]any{"data": big})
	if !strings.Contains(encoded, `"truncated":true`) {
		t.Fatalf("oversized payload was not truncated: %s", encoded[:80])
	}

	encoded = encodeToolResult(map[string]any{"ok": true})
	if encoded != `{"ok":true}` {
		t.Fatalf("small payloads must pass through, got %s", encoded)
	}
}

func TestRunAgentStreamStopsAfterFinalAnswer(t *testing.T) {
	service, calls, endpoint := stubAgentService(t, []string{
		strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"完成"}}]}`,
			"",
			`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
	})

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{ID: 3, Name: "测试助手", Endpoint: endpoint, Model: "test-model", APIProtocol: "chat"}}
	prepared := &PreparedAgentStream{
		userID:       1,
		assistant:    assistant,
		conversation: []map[string]any{{"role": "user", "content": "你好"}},
	}

	var events []AgentEvent
	var mu sync.Mutex
	result, err := service.runAgentStream(context.Background(), prepared, func(event AgentEvent) error {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if result == nil || result.Reply != "完成" {
		t.Fatalf("reply = %+v", result)
	}
	if result.AssistantID != 3 || result.AssistantName != "测试助手" {
		t.Fatalf("assistant identity lost: %+v", result)
	}
	if *calls != 1 {
		t.Fatalf("model called %d times, want 1", *calls)
	}

	if len(events) == 0 || events[0].Type != AgentEventStart {
		t.Fatalf("first event must be agent_start, got %+v", events)
	}
	last := events[len(events)-1]
	if last.Type != AgentEventEnd || last.Result == nil {
		t.Fatalf("last event must be agent_end with a result, got %+v", last)
	}
	var sawDelta, sawTurnEnd bool
	for _, event := range events {
		if event.Type == AgentEventDelta && event.Delta == "完成" {
			sawDelta = true
		}
		if event.Type == AgentEventTurnEnd {
			sawTurnEnd = true
		}
	}
	if !sawDelta {
		t.Fatal("streamed text delta was not reported")
	}
	if !sawTurnEnd {
		t.Fatal("turn_end was not reported")
	}
}

func TestRunAgentStreamExecutesToolsThenAnswers(t *testing.T) {
	service, calls, endpoint := stubAgentService(t, []string{
		// Turn 1: ask for a tool.
		strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"先查询"}}]}`,
			"",
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"inspect_sheet_range","arguments":"{\"sheet_id\":5}"}}]}}]}`,
			"",
			`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
		// Turn 2: final answer.
		strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"共 3 行"}}]}`,
			"",
			`data: {"choices":[{"delta":{},"finish_reason":"stop"}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
	})

	var (
		toolMu     sync.Mutex
		toolArgs   map[string]any
		toolUserID int64
	)
	service.tools = map[string]ToolFunc{
		"inspect_sheet_range": func(userID int64, args map[string]any) (*toolExecutionResult, error) {
			toolMu.Lock()
			defer toolMu.Unlock()
			toolUserID = userID
			toolArgs = args
			return &toolExecutionResult{
				Data:            map[string]any{"row_count": 3},
				TouchedSheetIDs: []int64{5},
				Summary:         "工作表共 3 行",
			}, nil
		},
	}

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{ID: 1, Name: "助手", Endpoint: endpoint, Model: "test-model", APIProtocol: "chat"}}
	prepared := &PreparedAgentStream{
		userID:       42,
		assistant:    assistant,
		conversation: []map[string]any{{"role": "user", "content": "有多少行"}},
		toolDefs:     []openAIToolDefinition{{Type: "function", Function: openAIToolFunction{Name: "inspect_sheet_range"}}},
	}

	var (
		events   []AgentEvent
		eventsMu sync.Mutex
	)
	result, err := service.runAgentStream(context.Background(), prepared, func(event AgentEvent) error {
		eventsMu.Lock()
		defer eventsMu.Unlock()
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("run failed: %v", err)
	}
	if *calls != 2 {
		t.Fatalf("model called %d times, want 2", *calls)
	}
	if result.Reply != "共 3 行" {
		t.Fatalf("reply = %q", result.Reply)
	}
	if len(result.ToolTraces) != 1 || result.ToolTraces[0].Status != "success" {
		t.Fatalf("tool traces = %+v", result.ToolTraces)
	}
	if len(result.TouchedSheetIDs) != 1 || result.TouchedSheetIDs[0] != 5 {
		t.Fatalf("touched sheets = %v", result.TouchedSheetIDs)
	}
	toolMu.Lock()
	if toolUserID != 42 {
		t.Fatalf("tool user id = %d, want 42", toolUserID)
	}
	if toolArgs["_assistant_id"] != int64(1) {
		t.Fatalf("assistant id not injected: %v", toolArgs["_assistant_id"])
	}
	toolMu.Unlock()

	var toolStarts, toolEnds int
	for _, event := range events {
		switch event.Type {
		case AgentEventToolStart:
			toolStarts++
			if event.Tool == nil || event.Tool.Label == "" {
				t.Fatalf("tool_start must carry a label: %+v", event.Tool)
			}
		case AgentEventToolEnd:
			toolEnds++
			if event.Tool == nil || event.Tool.Status != "success" {
				t.Fatalf("tool_end must carry a success status: %+v", event.Tool)
			}
		}
	}
	if toolStarts != 1 || toolEnds != 1 {
		t.Fatalf("tool events: starts=%d ends=%d, want 1/1", toolStarts, toolEnds)
	}
}

func TestRunAgentStreamReportsToolErrors(t *testing.T) {
	service, _, endpoint := stubAgentService(t, []string{
		strings.Join([]string{
			`data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"query_sheet","arguments":"{}"}}]}}]}`,
			"",
			`data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
		strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"查询失败"}}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
	})
	service.tools = map[string]ToolFunc{
		"query_sheet": func(int64, map[string]any) (*toolExecutionResult, error) {
			return nil, context.DeadlineExceeded
		},
	}

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{ID: 1, Name: "助手", Endpoint: endpoint, Model: "test-model", APIProtocol: "chat"}}
	prepared := &PreparedAgentStream{
		userID:       1,
		assistant:    assistant,
		conversation: []map[string]any{{"role": "user", "content": "查询"}},
		toolDefs:     []openAIToolDefinition{{Type: "function", Function: openAIToolFunction{Name: "query_sheet"}}},
	}

	var events []AgentEvent
	result, err := service.runAgentStream(context.Background(), prepared, func(event AgentEvent) error {
		events = append(events, event)
		return nil
	})
	if err != nil {
		t.Fatalf("a failing tool must not fail the whole run: %v", err)
	}
	if len(result.ToolTraces) != 1 || result.ToolTraces[0].Status != "error" {
		t.Fatalf("tool traces = %+v", result.ToolTraces)
	}
	var sawErrorEnd bool
	for _, event := range events {
		if event.Type == AgentEventToolEnd && event.Tool != nil && event.Tool.Status == "error" {
			sawErrorEnd = true
		}
	}
	if !sawErrorEnd {
		t.Fatal("tool_end with an error status was not emitted")
	}
}

func TestRunAgentStreamAbortsOnSinkError(t *testing.T) {
	service, _, endpoint := stubAgentService(t, []string{
		strings.Join([]string{
			`data: {"choices":[{"delta":{"content":"a"}}]}`,
			"",
			"data: [DONE]",
			"",
		}, "\n"),
	})

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{ID: 1, Name: "助手", Endpoint: endpoint, Model: "test-model", APIProtocol: "chat"}}
	prepared := &PreparedAgentStream{
		userID:       1,
		assistant:    assistant,
		conversation: []map[string]any{{"role": "user", "content": "hi"}},
	}

	if _, err := service.runAgentStream(context.Background(), prepared, func(AgentEvent) error {
		return context.Canceled
	}); err == nil {
		t.Fatal("expected the sink error to abort the run")
	}
}

func TestRunAgentStreamRejectsNilPreparedStream(t *testing.T) {
	service := &AIService{}
	if _, err := service.RunPreparedStream(context.Background(), nil, func(AgentEvent) error { return nil }); err == nil {
		t.Fatal("expected an error for a nil prepared stream")
	}
}
