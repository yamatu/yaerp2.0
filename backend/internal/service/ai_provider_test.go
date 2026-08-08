package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"yaerp/internal/model"
)

func TestResponsesOutputItemsRoundTripWithoutDroppingFields(t *testing.T) {
	raw := []byte(`{
		"id":"resp_test",
		"model":"gpt-5.6",
		"output":[
			{"type":"reasoning","id":"rs_test","status":"completed","encrypted_content":"encrypted-reasoning","summary":[{"type":"summary_text","text":"private summary"}]},
			{"type":"function_call","id":"fc_test","call_id":"call_test","name":"lookup","arguments":"{\"id\":1}","status":"completed"}
		]
	}`)
	result, err := decodeOpenAIResponses(raw)
	if err != nil {
		t.Fatalf("decodeOpenAIResponses() error = %v", err)
	}
	if len(result.Output) != 2 {
		t.Fatalf("output length = %d, want 2", len(result.Output))
	}

	_, input := buildResponsesInput([]map[string]any{
		{"role": "assistant", "_responses_output": result.Output},
		{"role": "tool", "tool_call_id": "call_test", "content": `{"ok":true}`},
	})
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatalf("marshal replay input: %v", err)
	}
	var replay []map[string]any
	if err := json.Unmarshal(encoded, &replay); err != nil {
		t.Fatalf("decode replay input: %v", err)
	}
	if replay[0]["encrypted_content"] != "encrypted-reasoning" {
		t.Fatalf("encrypted reasoning was dropped: %#v", replay[0])
	}
	if replay[0]["status"] != "completed" {
		t.Fatalf("reasoning status was dropped: %#v", replay[0])
	}
	if _, ok := replay[0]["summary"]; !ok {
		t.Fatalf("reasoning summary was dropped: %#v", replay[0])
	}
	if replay[1]["status"] != "completed" || replay[1]["call_id"] != "call_test" {
		t.Fatalf("function call fields were dropped: %#v", replay[1])
	}
	if replay[2]["type"] != "function_call_output" || replay[2]["call_id"] != "call_test" {
		t.Fatalf("tool output was not appended: %#v", replay[2])
	}
}

func TestResponsesTextReadsOutputTextFromRawItems(t *testing.T) {
	result, err := decodeOpenAIResponses([]byte(`{
		"model":"gpt-test",
		"output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"first"},{"type":"output_text","text":"second"}]}]
	}`))
	if err != nil {
		t.Fatalf("decodeOpenAIResponses() error = %v", err)
	}
	if got := responsesText(result); got != "first\nsecond" {
		t.Fatalf("responsesText() = %q, want %q", got, "first\nsecond")
	}
}

func TestChatCompletionDisablesToolsWhenAssistantDoesNotSupportThem(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		if _, exists := request["tools"]; exists {
			t.Errorf("tools must be omitted when capability is disabled: %#v", request)
		}
		if _, exists := request["tool_choice"]; exists {
			t.Errorf("tool_choice must be omitted when capability is disabled: %#v", request)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"model":"test-model","choices":[{"message":{"role":"assistant","content":"plain reply"}}]}`))
	}))
	defer server.Close()

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{
		APIProtocol: "chat_completions", Endpoint: server.URL, Model: "test-model", SupportsTools: false,
	}}
	response, _, err := (&AIService{}).callAssistantCompletionWithTools(assistant, []map[string]any{
		{"role": "user", "content": "hello"},
	}, []openAIToolDefinition{buildToolDefinition("should_not_be_sent", "", map[string]any{"type": "object"})})
	if err != nil {
		t.Fatalf("callAssistantCompletionWithTools() error = %v", err)
	}
	if len(response.Choices) != 1 || response.Choices[0].Message.Content != "plain reply" {
		t.Fatalf("response = %#v", response)
	}
}

func TestResponsesRequestIncludesEncryptedReasoningOnlyForOfficialProvider(t *testing.T) {
	tests := []struct {
		name        string
		provider    string
		wantInclude bool
	}{
		{name: "official", provider: "openai", wantInclude: true},
		{name: "compatible", provider: "openai_compatible", wantInclude: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var request map[string]any
				if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
					t.Errorf("decode request: %v", err)
					return
				}
				include, exists := request["include"]
				if exists != tc.wantInclude {
					t.Errorf("include presence = %v, want %v (%#v)", exists, tc.wantInclude, request)
				}
				if tc.wantInclude {
					values, ok := include.([]any)
					if !ok || len(values) != 1 || values[0] != "reasoning.encrypted_content" {
						t.Errorf("include = %#v, want reasoning.encrypted_content", include)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(`{"id":"resp_test","model":"test-model","output_text":"ok","output":[]}`))
			}))
			defer server.Close()

			assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{
				Provider: tc.provider, APIProtocol: "responses", Endpoint: server.URL, Model: "test-model",
			}}
			if _, _, err := (&AIService{}).callResponsesAPI(assistant, []map[string]any{{"role": "user", "content": "hello"}}, nil); err != nil {
				t.Fatalf("callResponsesAPI() error = %v", err)
			}
		})
	}
}

func TestResponsesRequestUsesStructuredOutputAndFlatTools(t *testing.T) {
	var captured map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/responses" {
			t.Errorf("request path = %q, want /responses", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&captured); err != nil {
			t.Errorf("decode request: %v", err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp_test","model":"test-model","output_text":"ok","output":[]}`))
	}))
	defer server.Close()

	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{
		Provider: "openai", APIProtocol: "responses", Endpoint: server.URL,
		Model: "test-model", ReasoningEffort: "high", SupportsTools: true,
	}}
	format := map[string]any{
		"type": "json_schema", "name": "test_schema", "strict": true,
		"schema": map[string]any{
			"type": "object", "properties": map[string]any{},
			"required": []string{}, "additionalProperties": false,
		},
	}
	tool := buildToolDefinition("lookup_order", "Lookup one order.", map[string]any{
		"type": "object", "properties": map[string]any{
			"order_id": map[string]any{"type": "integer"},
		}, "required": []string{"order_id"}, "additionalProperties": false,
	})
	if _, _, err := (&AIService{}).callResponsesAPI(assistant, []map[string]any{
		{"role": "system", "content": "Return JSON."},
		{"role": "user", "content": "Find order 1."},
	}, []openAIToolDefinition{tool}, format); err != nil {
		t.Fatalf("callResponsesAPI() error = %v", err)
	}

	textConfig, ok := captured["text"].(map[string]any)
	if !ok {
		t.Fatalf("text config = %#v", captured["text"])
	}
	gotFormat, ok := textConfig["format"].(map[string]any)
	if !ok || gotFormat["type"] != "json_schema" || gotFormat["name"] != "test_schema" || gotFormat["strict"] != true {
		t.Fatalf("structured format = %#v", textConfig["format"])
	}
	reasoning, ok := captured["reasoning"].(map[string]any)
	if !ok || reasoning["effort"] != "high" {
		t.Fatalf("reasoning = %#v", captured["reasoning"])
	}
	tools, ok := captured["tools"].([]any)
	if !ok || len(tools) != 1 {
		t.Fatalf("tools = %#v", captured["tools"])
	}
	flatTool, ok := tools[0].(map[string]any)
	if !ok || flatTool["type"] != "function" || flatTool["name"] != "lookup_order" {
		t.Fatalf("flat tool = %#v", tools[0])
	}
	if _, nested := flatTool["function"]; nested {
		t.Fatalf("Responses tool must not use Chat Completions nesting: %#v", flatTool)
	}
}

func TestNormalizeOfficialAssistantEndpointIsOptional(t *testing.T) {
	_, provider, protocol, endpoint, _, _, err := normalizeAIAssistantInput(&model.AIAssistantInput{
		Name: "OpenAI", Provider: "openai", Model: "gpt-5.6", APIKey: "secret",
	})
	if err != nil {
		t.Fatalf("normalize official assistant: %v", err)
	}
	if provider != "openai" || protocol != "responses" || endpoint != "https://api.openai.com/v1" {
		t.Fatalf("normalized official config = provider %q protocol %q endpoint %q", provider, protocol, endpoint)
	}

	if _, _, _, _, _, _, err := normalizeAIAssistantInput(&model.AIAssistantInput{
		Name: "Compatible", Provider: "openai_compatible", Model: "custom",
	}); err == nil {
		t.Fatal("expected a missing endpoint error for a compatible provider")
	}
}

func TestUpdatedAIAssistantAPIKeyDoesNotCrossProviderOrEndpointBoundary(t *testing.T) {
	current := &activeAIAssistant{
		AIAssistant: model.AIAssistant{Provider: "openai", Endpoint: "https://api.openai.com/v1"},
		APIKey:      "official-secret",
	}

	if _, err := updatedAIAssistantAPIKey(current, "openai", "https://api.openai.com/v1", &model.AIAssistantInput{}); err != nil {
		t.Fatalf("retain key on unchanged endpoint: %v", err)
	}
	if _, err := updatedAIAssistantAPIKey(current, "openai_compatible", "https://provider.example/v1", &model.AIAssistantInput{}); err != nil {
		t.Fatalf("keyless compatible endpoint should be allowed: %v", err)
	}
	key, err := updatedAIAssistantAPIKey(current, "openai_compatible", "https://provider.example/v1", &model.AIAssistantInput{})
	if err != nil || key != "" {
		t.Fatalf("old key crossed provider boundary: key=%q err=%v", key, err)
	}
	if _, err := updatedAIAssistantAPIKey(current, "openai", "https://different.example/v1", &model.AIAssistantInput{}); err == nil {
		t.Fatal("expected a new key requirement when the official credential boundary changes")
	}
	key, err = updatedAIAssistantAPIKey(current, "openai_compatible", "https://provider.example/v1", &model.AIAssistantInput{APIKey: " new-secret "})
	if err != nil || key != "new-secret" {
		t.Fatalf("explicit replacement key = %q, err = %v", key, err)
	}
}

func TestNormalizeAIAssistantAcceptsMinimalReasoningEffort(t *testing.T) {
	_, _, _, _, _, effort, err := normalizeAIAssistantInput(&model.AIAssistantInput{
		Name: "OpenAI", Provider: "openai", Model: "gpt-test", ReasoningEffort: "minimal",
	})
	if err != nil || effort != "minimal" {
		t.Fatalf("minimal reasoning effort = %q, err = %v", effort, err)
	}
}

func TestAIConnectionTestValidationIsExact(t *testing.T) {
	if !isAIConnectionTestText(" YAERP_OK\n") {
		t.Fatal("expected exact test text to pass")
	}
	if isAIConnectionTestText("YAERP_OK: connected") {
		t.Fatal("expected embellished test text to fail")
	}

	valid := openAIToolCall{}
	valid.Function.Name = "yaerp_connection_test"
	valid.Function.Arguments = `{"message":"YAERP_OK"}`
	if !isAIConnectionTestToolCall([]openAIToolCall{valid}) {
		t.Fatal("expected valid tool call to pass")
	}

	for _, arguments := range []string{`{"message":"wrong"}`, `{"message":"YAERP_OK","extra":true}`, `not-json`} {
		invalid := valid
		invalid.Function.Arguments = arguments
		if isAIConnectionTestToolCall([]openAIToolCall{invalid}) {
			t.Fatalf("expected invalid arguments %q to fail", arguments)
		}
	}
	if isAIConnectionTestToolCall([]openAIToolCall{valid, valid}) {
		t.Fatal("expected multiple tool calls to fail")
	}
}
