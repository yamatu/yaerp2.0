package service

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"yaerp/internal/model"
)

func TestChatStreamRefusesUnfinishedToolCalls(t *testing.T) {
	cases := []struct {
		name, stream string
	}{
		{"premature EOF", `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"update_cell","arguments":"{}"}}]}}]}` + "\n\n"},
		{"DONE without finish", `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"update_cell","arguments":"{}"}}]}}]}` + "\n\ndata: [DONE]\n\n"},
		{"finish without DONE", `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"update_cell","arguments":"{}"}}]}}]}` + "\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\n"},
		{"malformed chunk", `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"update_cell","arguments":"{}"}}]}}]}` + "\n\ndata: {bad json\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := buildOpenAIStreamServer(t, tc.stream, http.StatusOK)
			defer server.Close()
			svc := &AIService{}
			assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test"}}
			if _, _, err := svc.callChatCompletionStream(context.Background(), assistant, []map[string]any{{"role": "user", "content": "hi"}}, nil, nil); err == nil {
				t.Fatal("unfinished tool call must not be executed")
			}
		})
	}
}

func TestResponsesStreamRequiresCompletedResponse(t *testing.T) {
	for _, stream := range []string{
		"data: {\"type\":\"response.output_item.done\",\"item\":{\"type\":\"function_call\",\"name\":\"update_cell\",\"call_id\":\"c1\",\"arguments\":\"{}\"}}\n\n",
		"data: {\"type\":\"response.failed\"}\n\n",
		"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"incomplete\",\"output\":[]}}\n\n",
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/event-stream")
			_, _ = w.Write([]byte(stream))
		}))
		assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test", APIProtocol: "responses"}}
		_, _, err := (&AIService{}).callResponsesStream(context.Background(), assistant, []map[string]any{{"role": "user", "content": "hi"}}, nil, nil)
		server.Close()
		if err == nil {
			t.Fatalf("unfinished Responses stream must fail: %s", stream)
		}
	}
}

func TestResponsesStreamReplaysCompletedToolCall(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("data: {\"type\":\"response.output_text.delta\",\"delta\":\"checking\"}\n\n" +
			"data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"model\":\"test\",\"output\":[{\"type\":\"function_call\",\"name\":\"query_sheet\",\"call_id\":\"c1\",\"arguments\":\"{}\"}]}}\n\n"))
	}))
	defer server.Close()
	assistant := &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: server.URL, Model: "test", APIProtocol: "responses"}}
	var delta string
	result, message, err := (&AIService{}).callResponsesStream(context.Background(), assistant, []map[string]any{{"role": "user", "content": "hi"}}, nil, func(text string) error {
		delta += text
		return nil
	})
	if err != nil || delta != "checking" || len(result.Choices[0].Message.ToolCalls) != 1 || result.Choices[0].Message.ToolCalls[0].ID != "c1" {
		t.Fatalf("completed tool stream failed: delta=%q result=%+v err=%v", delta, result, err)
	}
	if _, ok := message["_responses_output"]; !ok {
		t.Fatalf("stateless Responses continuation lost output: %+v", message)
	}
}

func TestPlanSheetSortClearsMissingSourceCells(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "score"}, {Key: "note"}}
	rows := []aiPreviewRow{
		{Row: 0, Data: map[string]any{"score": 2, "note": "A"}},
		{Row: 1, Data: map[string]any{"score": 1}},
	}
	updates, err := planSheetSort(8, rows, rows, columns, 0, 1, "score", false)
	if err != nil {
		t.Fatal(err)
	}
	result := map[string]string{}
	for _, update := range updates {
		result[fmt.Sprintf("%d:%s", update.Row, update.Col)] = string(update.Value)
	}
	if result["0:note"] != "null" || result["1:note"] != `"A"` {
		t.Fatalf("sort must clear the missing note and move A: %v", result)
	}
	if result["0:score"] != "1" || result["1:score"] != "2" {
		t.Fatalf("score order did not change: %v", result)
	}
}

func TestPlanSheetSortRefusesSparseAndUnreadableRows(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "score"}, {Key: "secret"}}
	original := []aiPreviewRow{
		{Row: 0, Data: map[string]any{"score": 2, "secret": "A"}},
		{Row: 2, Data: map[string]any{"score": 1, "secret": "B"}},
	}
	if _, err := planSheetSort(8, original, original, columns, 0, 2, "score", false); err == nil {
		t.Fatal("sparse range must not be sorted as if it contained two adjacent rows")
	}
	original[1].Row = 1
	visible := []aiPreviewRow{
		{Row: 0, Data: map[string]any{"score": 2}},
		{Row: 1, Data: map[string]any{"score": 1, "secret": "B"}},
	}
	if _, err := planSheetSort(8, original, visible, columns, 0, 1, "score", false); err == nil {
		t.Fatal("hidden source value must not stay attached to the wrong row")
	}
}

func TestRunToolBatchPreservesReadWriteOrder(t *testing.T) {
	var actual int
	var snapshots []int
	svc := &AIService{tools: map[string]ToolFunc{
		"query_sheet": func(int64, map[string]any) (*toolExecutionResult, error) {
			snapshots = append(snapshots, actual)
			return &toolExecutionResult{Data: map[string]any{"value": actual}}, nil
		},
		"update_cell": func(int64, map[string]any) (*toolExecutionResult, error) {
			actual++
			return &toolExecutionResult{Data: map[string]any{"value": actual}}, nil
		},
	}}
	state := newAgentRunState(1, &activeAIAssistant{}, nil, []openAIToolDefinition{
		{Function: openAIToolFunction{Name: "query_sheet"}},
		{Function: openAIToolFunction{Name: "update_cell"}},
	})
	makeCall := func(id, name string) openAIToolCall {
		return openAIToolCall{ID: id, Function: openAIToolFunctionCall{Name: name, Arguments: "{}"}}
	}
	calls := []openAIToolCall{makeCall("before", "query_sheet"), makeCall("change", "update_cell"), makeCall("after", "query_sheet")}
	if err := svc.runToolBatch(context.Background(), state, calls, 1, func(AgentEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if len(snapshots) != 2 || snapshots[0] != 0 || snapshots[1] != 1 {
		t.Fatalf("read-before-write and read-after-write must see different values: %v", snapshots)
	}
	if len(state.traces) != 3 || len(state.conversation) != 3 {
		t.Fatalf("all three results must be reported: %v", state.traces)
	}
}

func TestRunToolBatchBlocksSecondERPPreviewInSameTurn(t *testing.T) {
	calls := 0
	svc := &AIService{tools: map[string]ToolFunc{
		"preview_erp_action": func(int64, map[string]any) (*toolExecutionResult, error) {
			calls++
			return &toolExecutionResult{Data: map[string]any{"ok": true}, PendingERPPlan: &ERPPendingPlan{}}, nil
		},
	}}
	state := newAgentRunState(1, &activeAIAssistant{}, nil, []openAIToolDefinition{{Function: openAIToolFunction{Name: "preview_erp_action"}}})
	callsFromModel := []openAIToolCall{
		{ID: "a", Function: openAIToolFunctionCall{Name: "preview_erp_action", Arguments: "{}"}},
		{ID: "b", Function: openAIToolFunctionCall{Name: "preview_erp_action", Arguments: "{}"}},
	}
	if err := svc.runToolBatch(context.Background(), state, callsFromModel, 1, func(AgentEvent) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if calls != 1 || state.traces[1].Status != "error" {
		t.Fatalf("only first preview should execute: calls=%d traces=%+v", calls, state.traces)
	}
}

func TestToolResultIsRecordedBeforeStreamWriteFails(t *testing.T) {
	svc := &AIService{tools: map[string]ToolFunc{
		"update_cell": func(int64, map[string]any) (*toolExecutionResult, error) {
			return &toolExecutionResult{Data: map[string]any{"ok": true}, ChangedSheetIDs: []int64{17}}, nil
		},
	}}
	state := newAgentRunState(1, &activeAIAssistant{}, nil, []openAIToolDefinition{{Function: openAIToolFunction{Name: "update_cell"}}})
	call := openAIToolCall{ID: "write", Function: openAIToolFunctionCall{Name: "update_cell", Arguments: "{}"}}
	err := svc.runToolBatch(context.Background(), state, []openAIToolCall{call}, 1, func(event AgentEvent) error {
		if event.Type == AgentEventToolEnd {
			return context.Canceled
		}
		return nil
	})
	if err == nil || len(state.partialResponse().ChangedSheetIDs) != 1 || state.partialResponse().ChangedSheetIDs[0] != 17 {
		t.Fatalf("committed sheet change must survive a broken client stream: %+v, %v", state.partialResponse(), err)
	}
}

func TestRunAgentStreamRefusesToolsWhenAssistantDisablesThem(t *testing.T) {
	stream := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"update_cell\",\"arguments\":\"{}\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"
	svc, _, endpoint := stubAgentService(t, []string{stream})
	called := false
	svc.tools["update_cell"] = func(int64, map[string]any) (*toolExecutionResult, error) {
		called = true
		return &toolExecutionResult{}, nil
	}
	prepared := &PreparedAgentStream{
		userID: 1, assistant: &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: endpoint, Model: "test"}},
		conversation: []map[string]any{{"role": "user", "content": "hi"}},
	}
	if _, err := svc.runAgentStream(context.Background(), prepared, func(AgentEvent) error { return nil }); err == nil || called {
		t.Fatalf("unoffered tool must never execute: called=%v err=%v", called, err)
	}
}

func TestRunAgentStreamReturnsPartialResultOnModelFailure(t *testing.T) {
	responses := []string{
		"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"update_cell\",\"arguments\":\"{}\"}}]}}]}\n\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n",
		"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", // no terminal marker
	}
	svc, _, endpoint := stubAgentService(t, responses)
	svc.tools["update_cell"] = func(int64, map[string]any) (*toolExecutionResult, error) {
		return &toolExecutionResult{Data: map[string]any{"ok": true}, ChangedSheetIDs: []int64{7}}, nil
	}
	state := &PreparedAgentStream{
		userID: 1, assistant: &activeAIAssistant{AIAssistant: model.AIAssistant{Endpoint: endpoint, Model: "test"}},
		conversation: []map[string]any{{"role": "user", "content": "write"}},
		toolDefs:     []openAIToolDefinition{{Function: openAIToolFunction{Name: "update_cell"}}},
	}
	partial, err := svc.runAgentStream(context.Background(), state, func(AgentEvent) error { return nil })
	if err == nil || partial == nil || len(partial.ChangedSheetIDs) != 1 || partial.ChangedSheetIDs[0] != 7 {
		t.Fatalf("committed change must be returned even when next turn fails: result=%+v error=%v", partial, err)
	}
}

func TestFormulaTemplateRejectsUnknownPlaceholders(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "quantity", Type: "number"}, {Key: "price", Type: "currency"}}
	if err := validateFormulaTemplateReferences("={{quantity}}*{{price}}", columns); err != nil {
		t.Fatalf("known placeholders should pass: %v", err)
	}
	if err := validateFormulaTemplateReferences("={{qunatity}}*{{price}}", columns); err == nil {
		t.Fatal("typo must be rejected before writing hundreds of formulas")
	}
}

func TestParseAggregateFormulaPreservesColumnCaseAndRejectsInvalid(t *testing.T) {
	op, key, err := parseAggregateFormula("SUM({{OrderAmount}})")
	if err != nil || op != "SUM" || key != "OrderAmount" {
		t.Fatalf("parsed: %s %s %v", op, key, err)
	}
	for _, formula := range []string{"MEDIAN(amount)", "SUM(amount", "UNKNOWN"} {
		if _, _, err := parseAggregateFormula(formula); err == nil {
			t.Errorf("should reject malformed aggregate: %q", formula)
		}
	}
}

func TestAdvancedWritersRejectNonzeroRowBase(t *testing.T) {
	if err := ensureZeroBasedSheetRows([]model.Row{{RowIndex: 1}, {RowIndex: 2}}); err == nil {
		t.Fatal("normalizing the displayed index would otherwise write into a different stored row")
	}
	if err := ensureZeroBasedSheetRows([]model.Row{{RowIndex: 0}, {RowIndex: 2}}); err != nil {
		t.Fatalf("sparse but zero-based rows are valid for targeted writes: %v", err)
	}
}

func TestHiddenCellsCannotBeTreatedAsEmptyInFilters(t *testing.T) {
	original := []aiPreviewRow{{Row: 0, Data: map[string]any{"secret": "hidden"}}, {Row: 3, Data: map[string]any{"secret": "visible"}}}
	visible := []aiPreviewRow{{Row: 0, Data: map[string]any{}}, {Row: 3, Data: map[string]any{"secret": "visible"}}}
	if err := ensureReadColumnsVisible(original, visible, []string{"secret"}); err == nil {
		t.Fatal("hidden values must not be counted as blank cells")
	}
	if err := ensureReadColumnsVisible(original, visible, []string{"other"}); err != nil {
		t.Fatalf("unrelated column is visible: %v", err)
	}
}

func TestSortRejectsFormulaReferencesAndSnapshotCache(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "price"}, {Key: "total"}}
	rows := []aiPreviewRow{
		{Row: 0, Data: map[string]any{"price": 20, "total": "=A2*2"}},
		{Row: 1, Data: map[string]any{"price": 10, "total": "=A3*2"}},
	}
	if _, err := planSheetSort(1, rows, rows, columns, 0, 1, "price", false); err == nil {
		t.Fatal("relative cell formulas cannot be permuted as plain values")
	}
	config := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":20,"f":"=A2*2"}}}}}`)
	if !hasSheetSnapshotFormulas(config) || hasSheetSnapshotFormulas(nil) {
		t.Fatal("formula cache must be detected without flagging an empty snapshot")
	}
}

func TestSortUpdatesContainValidJSON(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "value"}}
	rows := []aiPreviewRow{{Row: 0, Data: map[string]any{"value": "B"}}, {Row: 1, Data: map[string]any{"value": "A"}}}
	updates, err := planSheetSort(1, rows, rows, columns, 0, 1, "value", false)
	if err != nil {
		t.Fatal(err)
	}
	for _, update := range updates {
		if !json.Valid(update.Value) {
			t.Fatalf("not valid JSON: %s", update.Value)
		}
	}
}
