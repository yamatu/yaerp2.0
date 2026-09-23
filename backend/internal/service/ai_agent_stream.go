package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

const (
	// agentMaxTurns bounds how many model requests a single run may make. When
	// the budget is exhausted the agent is asked for a final summary instead of
	// being cut off silently.
	agentMaxTurns = 12
	// agentSoftTurnBudget leaves room for the wrap-up turn.
	agentSoftTurnBudget = agentMaxTurns - 2
	// agentMaxToolErrorsInARow stops a loop where the model keeps calling the
	// same broken tool.
	agentMaxToolErrorsInARow = 3
	agentMaxToolCallsPerTurn = 32
	// agentTurnTimeout bounds one model request.
	agentTurnTimeout = 5 * time.Minute
)

// agentRunState accumulates everything the run learns, so the final
// ChatResponse can be assembled in one place.
type agentRunState struct {
	assistant         *activeAIAssistant
	userID            int64
	conversation      []map[string]any
	toolDefs          []openAIToolDefinition
	touched           map[int64]struct{}
	changed           map[int64]struct{}
	resourcesChanged  bool
	pendingOperations []SpreadsheetOperation
	pendingERPPlan    *ERPPendingPlan
	traces            []ChatToolTrace
	lastModel         string
	reply             strings.Builder
	consecutiveErrors int
	aborted           bool
}

func newAgentRunState(userID int64, assistant *activeAIAssistant, conversation []map[string]any, toolDefs []openAIToolDefinition) *agentRunState {
	return &agentRunState{
		assistant:    assistant,
		userID:       userID,
		conversation: conversation,
		toolDefs:     toolDefs,
		touched:      map[int64]struct{}{},
		changed:      map[int64]struct{}{},
		lastModel:    assistant.Model,
	}
}

func (state *agentRunState) recordToolResult(result *toolExecutionResult) {
	for _, sheetID := range result.TouchedSheetIDs {
		state.touched[sheetID] = struct{}{}
	}
	for _, sheetID := range result.ChangedSheetIDs {
		state.changed[sheetID] = struct{}{}
	}
	state.resourcesChanged = state.resourcesChanged || result.ResourcesChanged
	if len(result.PendingOperations) > 0 {
		state.pendingOperations = result.PendingOperations
	}
	if result.PendingERPPlan != nil {
		state.pendingERPPlan = result.PendingERPPlan
	}
}

func (state *agentRunState) toResponse(reply string) *ChatResponse {
	reply = strings.TrimSpace(reply)
	if reply == "" {
		reply = strings.TrimSpace(state.reply.String())
	}
	if reply == "" {
		if state.aborted {
			reply = "已停止本次处理。"
		} else {
			reply = "已完成处理。"
		}
	}
	return &ChatResponse{
		AssistantID:       state.assistant.ID,
		AssistantName:     state.assistant.Name,
		Reply:             reply,
		Model:             state.lastModel,
		TouchedSheetIDs:   sortedTouchedSheetIDs(state.touched),
		ChangedSheetIDs:   sortedTouchedSheetIDs(state.changed),
		ResourcesChanged:  state.resourcesChanged,
		PendingOperations: state.pendingOperations,
		PendingERPPlan:    state.pendingERPPlan,
		ToolTraces:        state.traces,
	}
}

// partialResponse reports already committed changes without claiming that the
// entire request completed. The handler needs it even if the client disconnects.
func (state *agentRunState) partialResponse() *ChatResponse {
	reply := strings.TrimSpace(state.reply.String())
	if reply == "" {
		reply = "任务未完成；已有的工具操作可能已经生效。"
	}
	return state.toResponse(reply)
}

// PreparedAgentStream is a validated agent run that has not started yet. It
// exists so the HTTP layer can return a normal JSON error (invalid workbook,
// missing assistant) before switching the response to text/event-stream.
type PreparedAgentStream struct {
	userID       int64
	assistant    *activeAIAssistant
	conversation []map[string]any
	toolDefs     []openAIToolDefinition
}

// PrepareStream validates a streaming request without contacting the model.
func (s *AIService) PrepareStream(userID, assistantID int64, messages []ChatMessage, chatContext *ChatContext) (*PreparedAgentStream, error) {
	assistant, err := s.resolveAIAssistant(assistantID)
	if err != nil {
		return nil, err
	}
	conversation, err := s.buildAgentConversation(userID, assistant, messages, chatContext)
	if err != nil {
		return nil, err
	}
	toolDefs := s.buildToolDefinitions()
	if !assistant.SupportsTools {
		toolDefs = nil
	}
	return &PreparedAgentStream{
		userID:       userID,
		assistant:    assistant,
		conversation: conversation,
		toolDefs:     toolDefs,
	}, nil
}

// RunPreparedStream executes a prepared run, reporting every step through emit.
func (s *AIService) RunPreparedStream(ctx context.Context, prepared *PreparedAgentStream, emit AgentEventSink) (*ChatResponse, error) {
	if prepared == nil {
		return nil, fmt.Errorf("流式请求未初始化")
	}
	return s.runAgentStream(ctx, prepared, emit)
}

// RunAgentStream validates and executes a streaming turn in one call.
func (s *AIService) RunAgentStream(
	ctx context.Context,
	userID, assistantID int64,
	messages []ChatMessage,
	chatContext *ChatContext,
	emit AgentEventSink,
) (*ChatResponse, error) {
	prepared, err := s.PrepareStream(userID, assistantID, messages, chatContext)
	if err != nil {
		return nil, err
	}
	return s.runAgentStream(ctx, prepared, emit)
}

// runAgentStream is the agent loop itself.
//
// The loop mirrors the pi agent loop: a turn is one streamed model request plus
// the tool calls it produced, the assistant text is streamed as it arrives, and
// every tool call is announced before it runs so the UI can show progress
// instead of a frozen spinner.
func (s *AIService) runAgentStream(
	ctx context.Context,
	prepared *PreparedAgentStream,
	emit AgentEventSink,
) (*ChatResponse, error) {
	assistant := prepared.assistant
	state := newAgentRunState(prepared.userID, assistant, prepared.conversation, prepared.toolDefs)

	if err := emit(AgentEvent{Type: AgentEventStart}); err != nil {
		return nil, err
	}

	for turn := 1; turn <= agentMaxTurns; turn++ {
		if err := ctx.Err(); err != nil {
			state.aborted = true
			break
		}
		if err := emit(AgentEvent{Type: AgentEventTurnStart, Turn: turn}); err != nil {
			return nil, err
		}

		// Nudge the model towards answering when the budget runs low.
		if turn == agentSoftTurnBudget {
			state.conversation = append(state.conversation, agentSystemNotice(
				"剩余步骤有限：请优先完成当前任务，并在本步骤或下一步给出最终中文总结。",
			))
		}
		if turn == agentMaxTurns {
			state.conversation = append(state.conversation, agentSystemNotice(
				"已达到本轮工具调用上限：请立即停止调用工具，直接根据已有结果给出最终中文总结。",
			))
			state.toolDefs = nil
		}

		messageID := fmt.Sprintf("m%d-%d", time.Now().UnixNano(), turn)
		streamed, assistantMessage, err := s.streamAssistantTurn(ctx, state, messageID, emit)
		if err != nil {
			if ctx.Err() != nil {
				state.aborted = true
			}
			return state.partialResponse(), err
		}
		state.lastModel = firstNonEmpty(streamed.Model, state.lastModel)
		state.conversation = append(state.conversation, assistantMessage)

		reply := strings.TrimSpace(extractAIContent(streamed.Choices[0].Message.Content))
		if reply != "" {
			state.reply.Reset()
			state.reply.WriteString(reply)
		}

		toolCalls := streamed.Choices[0].Message.ToolCalls
		if len(toolCalls) == 0 {
			if err := emit(AgentEvent{
				Type:      AgentEventMessageEnd,
				MessageID: messageID,
				Delta:     "",
				Turn:      turn,
			}); err != nil {
				return nil, err
			}
			if err := emit(AgentEvent{Type: AgentEventTurnEnd, Turn: turn}); err != nil {
				return nil, err
			}
			break
		}

		// A "length" finish means the arguments may be truncated, so running
		// them could corrupt data. Report them as failed instead.
		if streamed.Choices[0].FinishReason == "length" {
			if err := s.appendTruncatedToolResults(state, toolCalls, emit); err != nil {
				return state.partialResponse(), err
			}
			if err := emit(AgentEvent{Type: AgentEventTurnEnd, Turn: turn}); err != nil {
				return state.partialResponse(), err
			}
			continue
		}

		if len(state.toolDefs) == 0 {
			return state.partialResponse(), fmt.Errorf("当前回合未向模型提供工具，拒绝执行模型返回的工具调用")
		}
		if len(toolCalls) > agentMaxToolCallsPerTurn {
			return state.partialResponse(), fmt.Errorf("一次最多调用 %d 个工具，请拆成更小的批次", agentMaxToolCallsPerTurn)
		}
		if err := s.runToolBatch(ctx, state, toolCalls, turn, emit); err != nil {
			if ctx.Err() != nil {
				state.aborted = true
			}
			return state.partialResponse(), err
		}
		if err := emit(AgentEvent{Type: AgentEventTurnEnd, Turn: turn}); err != nil {
			return state.partialResponse(), err
		}

		if state.consecutiveErrors >= agentMaxToolErrorsInARow {
			state.conversation = append(state.conversation, agentSystemNotice(
				fmt.Sprintf("连续 %d 次工具调用失败：请停止重试，向用户说明失败原因并给出可行的替代方案。", state.consecutiveErrors),
			))
		}
	}

	result := state.toResponse("")
	if state.pendingOperations != nil || state.pendingERPPlan != nil {
		if err := emit(AgentEvent{Type: AgentEventPlan, Result: result}); err != nil {
			return result, err
		}
	}
	if err := emit(AgentEvent{Type: AgentEventEnd, Result: result}); err != nil {
		return result, err
	}
	return result, nil
}

// streamAssistantTurn performs one streamed model request.
func (s *AIService) streamAssistantTurn(
	ctx context.Context,
	state *agentRunState,
	messageID string,
	emit AgentEventSink,
) (*openAIChatToolResponse, map[string]any, error) {
	onDelta := func(text string) error {
		return emit(AgentEvent{
			Type:      AgentEventDelta,
			MessageID: messageID,
			Delta:     text,
		})
	}

	turnCtx, cancel := context.WithTimeout(ctx, agentTurnTimeout)
	defer cancel()

	if state.assistant.APIProtocol == "responses" {
		return s.callResponsesStream(turnCtx, state.assistant, state.conversation, state.toolDefs, onDelta)
	}
	return s.callChatCompletionStream(turnCtx, state.assistant, state.conversation, state.toolDefs, onDelta)
}

// runToolBatch executes the tool calls of one turn.
//
// Read-only tools are executed concurrently, mutations stay sequential so the
// ordering guarantees of the write path are preserved.
func (s *AIService) runToolBatch(
	ctx context.Context,
	state *agentRunState,
	toolCalls []openAIToolCall,
	turn int,
	emit AgentEventSink,
) error {
	// Show the model's requested calls before execution, without preparing them
	// against stale state. A write may create a pending ERP plan that must block
	// the next preview in the SAME batch.
	for _, call := range toolCalls {
		if err := emit(AgentEvent{Type: AgentEventToolStart, Turn: turn, Tool: &AgentToolEvent{
			ID: call.ID, Name: call.Function.Name, Label: toolDisplayLabel(call.Function.Name), Status: "running",
		}}); err != nil {
			return err
		}
	}

	execute := func(call preparedToolCall) (*toolExecutionResult, error) {
		if call.invalid != nil {
			return nil, call.invalid
		}
		if call.tool == nil {
			return nil, fmt.Errorf("工具不存在")
		}
		return call.tool(state.userID, call.args)
	}

	// Only adjacent reads run together: a read-before-write must see the old
	// data, while a read-after-write must see the new data. Emit and record each
	// group's results before moving to the next call.
	for index := 0; index < len(toolCalls); {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !readOnlyAgentTools[toolCalls[index].Function.Name] {
			call := s.prepareToolCall(state, toolCalls[index])
			result, runErr := execute(call)
			if err := s.recordToolOutcome(state, call, result, runErr, emit); err != nil {
				return err
			}
			index++
			continue
		}

		end := index + 1
		for end < len(toolCalls) && readOnlyAgentTools[toolCalls[end].Function.Name] {
			end++
		}
		calls := make([]preparedToolCall, end-index)
		results := make([]*toolExecutionResult, len(calls))
		errors := make([]error, len(calls))
		for offset := range calls {
			calls[offset] = s.prepareToolCall(state, toolCalls[index+offset])
		}
		semaphore := make(chan struct{}, agentMaxParallelTools)
		var waitGroup sync.WaitGroup
		for offset := range calls {
			waitGroup.Add(1)
			go func(offset int) {
				defer waitGroup.Done()
				select {
				case semaphore <- struct{}{}:
					defer func() { <-semaphore }()
				case <-ctx.Done():
					errors[offset] = ctx.Err()
					return
				}
				results[offset], errors[offset] = execute(calls[offset])
			}(offset)
		}
		waitGroup.Wait()
		for offset, call := range calls {
			if err := s.recordToolOutcome(state, call, results[offset], errors[offset], emit); err != nil {
				return err
			}
		}
		index = end
	}
	return nil
}

// preparedToolCall is a tool call with its arguments already decoded.
type preparedToolCall struct {
	id      string
	name    string
	args    map[string]any
	tool    ToolFunc
	invalid error
}

func (s *AIService) prepareToolCall(state *agentRunState, call openAIToolCall) preparedToolCall {
	prepared := preparedToolCall{id: call.ID, name: call.Function.Name}
	allowed := false
	for _, definition := range state.toolDefs {
		if definition.Function.Name == call.Function.Name {
			allowed = true
			break
		}
	}
	if !allowed {
		prepared.invalid = fmt.Errorf("本轮未授权工具: %s", call.Function.Name)
		return prepared
	}
	if state.pendingERPPlan != nil && call.Function.Name == "preview_erp_action" {
		prepared.invalid = fmt.Errorf("本轮对话已经生成一个 ERP 待确认步骤；请先让员工确认、修改或放弃当前步骤，再准备下一步。")
		return prepared
	}
	prepared.tool = s.tools[call.Function.Name]
	if prepared.tool == nil {
		prepared.invalid = fmt.Errorf("工具不存在: %s", call.Function.Name)
		return prepared
	}
	args := map[string]any{}
	if len(call.Function.Arguments) > maxAIToolResultBytes {
		prepared.invalid = fmt.Errorf("工具参数过大；请缩小批次")
		return prepared
	}
	if strings.TrimSpace(call.Function.Arguments) != "" {
		if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
			prepared.invalid = fmt.Errorf("工具参数解析失败: %v", err)
			return prepared
		}
	}
	args["_assistant_id"] = state.assistant.ID
	prepared.args = args
	return prepared
}

// recordToolOutcome writes the tool result into the conversation, the trace list
// and the event stream.
func (s *AIService) recordToolOutcome(
	state *agentRunState,
	call preparedToolCall,
	result *toolExecutionResult,
	runErr error,
	emit AgentEventSink,
) error {
	if runErr == nil && result == nil {
		runErr = fmt.Errorf("工具返回空结果")
	}
	if runErr != nil {
		message := runErr.Error()
		state.consecutiveErrors++
		state.traces = append(state.traces, ChatToolTrace{Name: call.name, Status: "error", Summary: message})
		state.conversation = append(state.conversation, map[string]any{
			"role":         "tool",
			"tool_call_id": call.id,
			"content":      mustJSON(map[string]any{"error": message}, runErr),
		})
		return emit(AgentEvent{Type: AgentEventToolEnd, Tool: &AgentToolEvent{
			ID: call.id, Name: call.name, Label: toolDisplayLabel(call.name),
			Status: "error", Summary: message,
		}})
	}

	state.consecutiveErrors = 0
	state.recordToolResult(result)
	if call.name == "apply_spreadsheet_plan" {
		state.pendingOperations = nil
	}
	state.traces = append(state.traces, ChatToolTrace{
		Name:            call.name,
		Status:          "success",
		Summary:         result.Summary,
		Data:            compactAITraceData(result.Data),
		TouchedSheetIDs: result.TouchedSheetIDs,
	})

	encoded := encodeToolResult(result.Data)
	state.conversation = append(state.conversation, map[string]any{
		"role":         "tool",
		"tool_call_id": call.id,
		"content":      encoded,
	})

	return emit(AgentEvent{Type: AgentEventToolEnd, Tool: &AgentToolEvent{
		ID:               call.id,
		Name:             call.name,
		Label:            toolDisplayLabel(call.name),
		Status:           "success",
		Summary:          result.Summary,
		Data:             compactAITraceData(result.Data),
		TouchedSheetIDs:  result.TouchedSheetIDs,
		ChangedSheetIDs:  result.ChangedSheetIDs,
		ResourcesChanged: result.ResourcesChanged,
	}})
}

// appendTruncatedToolResults fails every call of a message that was cut off by
// the token limit, because truncated JSON arguments cannot be trusted.
func (s *AIService) appendTruncatedToolResults(state *agentRunState, toolCalls []openAIToolCall, emit AgentEventSink) error {
	for _, call := range toolCalls {
		message := "模型输出被长度限制截断，本次工具调用未执行以免写入不完整数据。请缩小单次操作的规模后重试。"
		state.traces = append(state.traces, ChatToolTrace{Name: call.Function.Name, Status: "error", Summary: message})
		state.conversation = append(state.conversation, map[string]any{
			"role":         "tool",
			"tool_call_id": call.ID,
			"content":      mustJSON(map[string]any{"error": message}, nil),
		})
		if err := emit(AgentEvent{Type: AgentEventToolEnd, Tool: &AgentToolEvent{
			ID: call.ID, Name: call.Function.Name, Label: toolDisplayLabel(call.Function.Name),
			Status: "error", Summary: message,
		}}); err != nil {
			return err
		}
	}
	state.conversation = append(state.conversation, agentSystemNotice(
		"上一条回复因长度限制被截断。请改用更小的批次，一次只处理少量数据行。",
	))
	return nil
}

func agentSystemNotice(text string) map[string]any {
	return map[string]any{"role": "system", "content": text}
}

// mustJSON marshals a tool payload, falling back to a minimal error object.
func mustJSON(value any, err error) string {
	encoded, marshalErr := json.Marshal(value)
	if marshalErr != nil {
		if err != nil {
			return fmt.Sprintf(`{"error":%q}`, err.Error())
		}
		return `{"ok":true}`
	}
	return string(encoded)
}

// encodeToolResult serialises a tool payload for the model, truncating anything
// that would blow up the context window.
func encodeToolResult(data any) string {
	encoded, err := json.Marshal(data)
	if err != nil {
		return `{"ok":true}`
	}
	if len(encoded) > maxAIToolResultBytes {
		return fmt.Sprintf(`{"truncated":true,"message":"tool result exceeded %d bytes","hint":"Narrow the query (fewer rows or columns) instead of retrying the same call."}`, maxAIToolResultBytes)
	}
	return string(encoded)
}

// readOnlyAgentTools lists the tools that only read data. They are safe to run
// concurrently and in any order.
var readOnlyAgentTools = map[string]bool{
	"get_user_context":        true,
	"get_my_permissions":      true,
	"get_erp_context":         true,
	"search_erp_customers":    true,
	"search_erp_orders":       true,
	"get_erp_order":           true,
	"search_erp_suppliers":    true,
	"query_sheet":             true,
	"inspect_sheet_range":     true,
	"filter_sheet_rows":       true,
	"search_spreadsheets":     true,
	"search_sheet_rows":       true,
	"lookup_sheet_records":    true,
	"calculate_sheet_metrics": true,
	"calculate_expression":    true,
	"list_summary_pages":      true,
}

// toolDisplayLabel returns the short Chinese label shown while a tool runs.
func toolDisplayLabel(name string) string {
	if label, ok := agentToolLabels[name]; ok {
		return label
	}
	return name
}

var agentToolLabels = map[string]string{
	"get_user_context":         "读取可访问表格",
	"get_my_permissions":       "核对权限",
	"get_erp_context":          "读取 ERP 概览",
	"search_erp_customers":     "搜索客户",
	"search_erp_orders":        "搜索业务单",
	"get_erp_order":            "读取业务单",
	"search_erp_suppliers":     "搜索供应商",
	"preview_erp_action":       "准备 ERP 操作",
	"query_sheet":              "读取工作表",
	"search_spreadsheets":      "搜索表格",
	"search_sheet_rows":        "检索数据行",
	"lookup_sheet_records":     "按条件查记录",
	"calculate_sheet_metrics":  "计算统计指标",
	"calculate_expression":     "计算表达式",
	"update_cell":              "更新单元格",
	"insert_row":               "插入行",
	"delete_row":               "删除行",
	"insert_column":            "插入列",
	"auto_fill_column":         "自动填充列",
	"generate_report":          "生成报表",
	"schedule_daily_report":    "创建日报计划",
	"run_workflow":             "执行批量操作",
	"preview_spreadsheet_plan": "生成表格方案",
	"apply_spreadsheet_plan":   "应用表格方案",
	"create_workbook":          "创建工作簿",
	"create_sheet":             "创建工作表",
	"update_workbook":          "修改工作簿",
	"update_sheet_name":        "重命名工作表",
	"set_cell_format":          "设置列类型",
	"format_cell_range":        "设置单元格格式",
	"configure_approval_flow":  "配置审批流程",
	"create_financial_report":  "生成财务分析",
	"list_summary_pages":       "列出总结页",
	"create_summary_page":      "创建总结页",
	"update_summary_page":      "更新总结页",
	"batch_update_cells":       "批量写单元格",
	"run_sheet_formulas":       "写入公式",
	"sort_sheet_range":         "排序数据",
	"filter_sheet_rows":        "筛选数据",
	"dedupe_sheet_rows":        "去重合并",
	"run_spreadsheet_script":   "执行表格脚本",
	"inspect_sheet_range":      "查看区域结构",
	"describe_sheet_columns":   "查看列结构",
}
