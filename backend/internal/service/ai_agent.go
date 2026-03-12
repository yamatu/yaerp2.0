package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"yaerp/internal/model"
)

type ToolFunc func(userID int64, args map[string]any) (*toolExecutionResult, error)

type toolExecutionResult struct {
	Data              any
	TouchedSheetIDs   []int64
	Summary           string
	PendingOperations []SpreadsheetOperation
}

type openAIToolDefinition struct {
	Type     string             `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
	Strict      bool           `json:"strict,omitempty"`
}

type openAIToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type openAIChatToolResponse struct {
	Choices []struct {
		Message struct {
			Role      string           `json:"role"`
			Content   any              `json:"content"`
			ToolCalls []openAIToolCall `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Model string `json:"model"`
}

func (s *AIService) buildToolRegistry() map[string]ToolFunc {
	return map[string]ToolFunc{
		"get_user_context":         s.toolGetUserContext,
		"query_sheet":              s.toolQuerySheet,
		"update_cell":              s.toolUpdateCell,
		"insert_row":               s.toolInsertRow,
		"delete_row":               s.toolDeleteRow,
		"insert_column":            s.toolInsertColumn,
		"auto_fill_column":         s.toolAutoFillColumn,
		"generate_report":          s.toolGenerateReport,
		"schedule_daily_report":    s.toolScheduleDailyReport,
		"run_workflow":             s.toolRunWorkflow,
		"preview_spreadsheet_plan": s.toolPreviewSpreadsheetPlan,
		"apply_spreadsheet_plan":   s.toolApplySpreadsheetPlan,
	}
}

func (s *AIService) chatWithTools(userID int64, messages []ChatMessage) (*ChatResponse, error) {
	endpoint, model := s.getActiveConfig()
	apiKey := s.getAPIKey()

	if endpoint == "" || apiKey == "" {
		return nil, fmt.Errorf("AI is not configured. Please set the API endpoint and key in admin settings")
	}

	conversation := s.buildAgentMessages(userID, messages)
	toolDefs := s.buildToolDefinitions()
	touchedSheets := make(map[int64]struct{})
	lastModel := model
	toolTraces := make([]ChatToolTrace, 0)
	var pendingOperations []SpreadsheetOperation

	for round := 0; round < 5; round++ {
		resp, assistantMessage, err := s.callChatCompletionWithTools(endpoint, apiKey, model, conversation, toolDefs)
		if err != nil {
			return nil, err
		}
		lastModel = resp.Model
		conversation = append(conversation, assistantMessage)

		if len(resp.Choices) == 0 {
			break
		}

		toolCalls := resp.Choices[0].Message.ToolCalls
		if len(toolCalls) == 0 {
			reply := strings.TrimSpace(extractAIContent(resp.Choices[0].Message.Content))
			if reply == "" {
				reply = "已完成处理。"
			}
			return &ChatResponse{
				Reply:             reply,
				Model:             lastModel,
				TouchedSheetIDs:   sortedTouchedSheetIDs(touchedSheets),
				PendingOperations: pendingOperations,
				ToolTraces:        toolTraces,
			}, nil
		}

		for _, call := range toolCalls {
			tool := s.tools[call.Function.Name]
			if tool == nil {
				toolTraces = append(toolTraces, ChatToolTrace{Name: call.Function.Name, Status: "error", Summary: "工具不存在"})
				conversation = append(conversation, map[string]any{
					"role":         "tool",
					"tool_call_id": call.ID,
					"content":      `{"error":"unsupported tool"}`,
				})
				continue
			}

			args := make(map[string]any)
			if strings.TrimSpace(call.Function.Arguments) != "" {
				if err := json.Unmarshal([]byte(call.Function.Arguments), &args); err != nil {
					toolTraces = append(toolTraces, ChatToolTrace{Name: call.Function.Name, Status: "error", Summary: fmt.Sprintf("工具参数解析失败: %v", err)})
					conversation = append(conversation, map[string]any{
						"role":         "tool",
						"tool_call_id": call.ID,
						"content":      fmt.Sprintf(`{"error":%q}`, fmt.Sprintf("invalid tool arguments: %v", err)),
					})
					continue
				}
			}

			result, err := tool(userID, args)
			if err != nil {
				toolTraces = append(toolTraces, ChatToolTrace{Name: call.Function.Name, Status: "error", Summary: err.Error()})
				conversation = append(conversation, map[string]any{
					"role":         "tool",
					"tool_call_id": call.ID,
					"content":      fmt.Sprintf(`{"error":%q}`, err.Error()),
				})
				continue
			}

			for _, sheetID := range result.TouchedSheetIDs {
				touchedSheets[sheetID] = struct{}{}
			}
			if len(result.PendingOperations) > 0 {
				pendingOperations = result.PendingOperations
			}
			if call.Function.Name == "apply_spreadsheet_plan" {
				pendingOperations = nil
			}
			toolTraces = append(toolTraces, ChatToolTrace{
				Name:            call.Function.Name,
				Status:          "success",
				Summary:         result.Summary,
				Data:            result.Data,
				TouchedSheetIDs: result.TouchedSheetIDs,
			})

			encoded, err := json.Marshal(result.Data)
			if err != nil {
				encoded = []byte(`{"ok":true}`)
			}
			conversation = append(conversation, map[string]any{
				"role":         "tool",
				"tool_call_id": call.ID,
				"content":      string(encoded),
			})
		}
	}

	return &ChatResponse{
		Reply:             "已完成处理。",
		Model:             lastModel,
		TouchedSheetIDs:   sortedTouchedSheetIDs(touchedSheets),
		PendingOperations: pendingOperations,
		ToolTraces:        toolTraces,
	}, nil
}

func (s *AIService) buildAgentMessages(userID int64, messages []ChatMessage) []map[string]any {
	context := s.buildUserContext(userID)
	result := []map[string]any{
		{
			"role": "system",
			"content": fmt.Sprintf(
				"你是 YaERP 智能表格助手。你必须优先使用工具来查询或修改表格，不要编造不存在的数据。"+
					"如果用户要查询、统计、修改、批量填充、生成报表，请调用合适的工具；完成后用中文总结结果。"+
					"如果用户要求修改表格，默认先调用 preview_spreadsheet_plan 生成待确认方案；只有当用户明确要求立即执行时，才调用 apply_spreadsheet_plan 或其他写入工具直接执行。"+
					"注意：工作表第一可见行通常是表头行，query_sheet 返回的 rows 只包含真实数据行，不包含表头；如果 total_rows=0 但 columns/header_row 有内容，表示该表只有表头结构，没有数据行。"+
					"当前用户可访问的数据摘要如下：\n\n%s",
				context,
			),
		},
	}

	for _, message := range messages {
		result = append(result, map[string]any{
			"role":    message.Role,
			"content": message.Content,
		})
	}

	return result
}

func (s *AIService) buildToolDefinitions() []openAIToolDefinition {
	return []openAIToolDefinition{
		buildToolDefinition("get_user_context", "获取当前用户可访问的工作簿和工作表摘要。", map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}),
		buildToolDefinition("query_sheet", "查询指定工作表的列定义和行数据。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":    map[string]any{"type": "integer"},
				"start_row":   map[string]any{"type": "integer"},
				"limit":       map[string]any{"type": "integer"},
				"column_keys": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"sheet_id"},
		}),
		buildToolDefinition("update_cell", "更新一个单元格的值。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":   map[string]any{"type": "integer"},
				"row":        map[string]any{"type": "integer"},
				"column_key": map[string]any{"type": "string"},
				"value":      map[string]any{},
			},
			"required": []string{"sheet_id", "row", "column_key", "value"},
		}),
		buildToolDefinition("insert_row", "在指定位置插入新行，并可写入多个字段值。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":   map[string]any{"type": "integer"},
				"row":        map[string]any{"type": "integer"},
				"row_values": map[string]any{"type": "object"},
			},
			"required": []string{"sheet_id", "row"},
		}),
		buildToolDefinition("delete_row", "删除指定数据行。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id": map[string]any{"type": "integer"},
				"row":      map[string]any{"type": "integer"},
			},
			"required": []string{"sheet_id", "row"},
		}),
		buildToolDefinition("insert_column", "新增一个字段列，可指定列名、列类型和插入位置。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":                map[string]any{"type": "integer"},
				"column_key":              map[string]any{"type": "string"},
				"column_name":             map[string]any{"type": "string"},
				"column_type":             map[string]any{"type": "string"},
				"insert_after_column_key": map[string]any{"type": "string"},
				"value":                   map[string]any{},
				"formula_template":        map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "column_key", "column_name"},
		}),
		buildToolDefinition("auto_fill_column", "按公式模板批量填充一列。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":         map[string]any{"type": "integer"},
				"column_key":       map[string]any{"type": "string"},
				"formula_template": map[string]any{"type": "string"},
				"start_row":        map[string]any{"type": "integer"},
				"end_row":          map[string]any{"type": "integer"},
			},
			"required": []string{"sheet_id", "column_key", "formula_template"},
		}),
		buildToolDefinition("generate_report", "把指定工作表导出为 Excel 报表并返回下载地址。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id": map[string]any{"type": "integer"},
				"filename": map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id"},
		}),
		buildToolDefinition("schedule_daily_report", "创建每日定时报表任务。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":          map[string]any{"type": "integer"},
				"time":              map[string]any{"type": "string"},
				"timezone":          map[string]any{"type": "string"},
				"filename_template": map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "time"},
		}),
		buildToolDefinition("run_workflow", "批量执行多条表格工作流操作。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operations": map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"operations"},
		}),
		buildToolDefinition("preview_spreadsheet_plan", "根据自然语言描述生成结构化表格操作方案。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workbook_id": map[string]any{"type": "integer"},
				"sheet_ids":   map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
				"prompt":      map[string]any{"type": "string"},
			},
			"required": []string{"workbook_id", "sheet_ids", "prompt"},
		}),
		buildToolDefinition("apply_spreadsheet_plan", "执行结构化表格操作方案并写入数据库。", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operations": map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"operations"},
		}),
	}
}

func (s *AIService) callChatCompletionWithTools(endpoint, apiKey, model string, messages []map[string]any, tools []openAIToolDefinition) (*openAIChatToolResponse, map[string]any, error) {
	requestBody := map[string]any{
		"model":       model,
		"messages":    messages,
		"tools":       tools,
		"tool_choice": "auto",
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal request: %w", err)
	}

	chatURL := strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(chatURL, "/chat/completions") {
		chatURL += "/chat/completions"
	}

	resp, err := doAIRequest(chatURL, apiKey, body)
	if err != nil {
		return nil, nil, err
	}

	var apiResp openAIChatToolResponse
	if err := json.Unmarshal(resp, &apiResp); err != nil {
		return nil, nil, fmt.Errorf("parse response: %w", err)
	}
	if len(apiResp.Choices) == 0 {
		return nil, nil, fmt.Errorf("no response from AI model")
	}

	assistantMessage := map[string]any{
		"role":    "assistant",
		"content": extractAIContent(apiResp.Choices[0].Message.Content),
	}
	if len(apiResp.Choices[0].Message.ToolCalls) > 0 {
		assistantMessage["tool_calls"] = apiResp.Choices[0].Message.ToolCalls
	}

	return &apiResp, assistantMessage, nil
}

func doAIRequest(chatURL, apiKey string, body []byte) ([]byte, error) {
	request, err := http.NewRequest("POST", chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 60 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer response.Body.Close()

	respBody, err := io.ReadAll(response.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d: %s", response.StatusCode, string(respBody))
	}

	return respBody, nil
}

func buildToolDefinition(name, description string, parameters map[string]any) openAIToolDefinition {
	return openAIToolDefinition{
		Type: "function",
		Function: openAIToolFunction{
			Name:        name,
			Description: description,
			Parameters:  parameters,
		},
	}
}

func extractAIContent(content any) string {
	switch value := content.(type) {
	case string:
		return value
	case []any:
		parts := make([]string, 0, len(value))
		for _, item := range value {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if text, ok := entry["text"].(string); ok {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n")
	default:
		return ""
	}
}

func sortedTouchedSheetIDs(items map[int64]struct{}) []int64 {
	result := make([]int64, 0, len(items))
	for sheetID := range items {
		result = append(result, sheetID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func buildQuerySheetSummary(sheetName string, rowCount, columnCount int) string {
	if rowCount == 0 && columnCount > 0 {
		return fmt.Sprintf("已查询工作表 %s：当前只有表头/列定义，共 %d 列，没有数据行", sheetName, columnCount)
	}
	return fmt.Sprintf("已查询工作表 %s，返回 %d 行数据", sheetName, rowCount)
}

func (s *AIService) toolGetUserContext(userID int64, _ map[string]any) (*toolExecutionResult, error) {
	context, err := s.buildUserContextSnapshot(userID, 20)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{Data: context, Summary: "已获取当前用户的工作簿上下文"}, nil
}

func (s *AIService) toolQuerySheet(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}

	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	rowBase := getSheetRowBase(rows)

	startRow, _ := intArgWithDefault(args, "start_row", 0)
	limit, _ := intArgWithDefault(args, "limit", 50)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	columnKeys := stringSliceArg(args, "column_keys")
	columnFilter := make(map[string]struct{}, len(columnKeys))
	for _, key := range columnKeys {
		columnFilter[key] = struct{}{}
	}

	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}

	filteredRows := make([]map[string]any, 0, limit)
	for _, row := range rows {
		normalizedRowIndex := row.RowIndex - rowBase
		if normalizedRowIndex < startRow {
			continue
		}
		data := map[string]any{}
		_ = json.Unmarshal(row.Data, &data)
		visibleData := make(map[string]any)
		for key, value := range data {
			allowed, err := s.permService.CheckCellPermission(sheetID, userID, key, row.RowIndex, "read")
			if err != nil {
				return nil, err
			}
			if allowed {
				visibleData[key] = value
			}
		}
		data = visibleData
		if len(columnFilter) > 0 {
			nextData := make(map[string]any, len(columnFilter))
			for key := range columnFilter {
				if value, ok := data[key]; ok {
					nextData[key] = value
				}
			}
			data = nextData
		}
		filteredRows = append(filteredRows, map[string]any{
			"row":         normalizedRowIndex,
			"source_row":  row.RowIndex,
			"display_row": normalizedRowIndex + 2,
			"data":        data,
		})
		if len(filteredRows) >= limit {
			break
		}
	}

	return &toolExecutionResult{Data: map[string]any{
		"sheet_id":    sheet.ID,
		"sheet_name":  sheet.Name,
		"columns":     columns,
		"header_row":  columns,
		"rows":        filteredRows,
		"total_rows":  len(rows),
		"header_only": len(rows) == 0 && len(columns) > 0,
	}, Summary: buildQuerySheetSummary(sheet.Name, len(filteredRows), len(columns))}, nil
}

func (s *AIService) toolUpdateCell(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	row, err := intArg(args, "row")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	value, ok := args["value"]
	if !ok {
		return nil, fmt.Errorf("value is required")
	}

	operation, err := s.resolveSpreadsheetOperationForExecution(SpreadsheetOperation{
		Kind:      "update_cell",
		SheetID:   sheetID,
		Row:       row,
		ColumnKey: columnKey,
		Value:     value,
	})
	if err != nil {
		return nil, err
	}
	sheetID = operation.SheetID
	row = operation.Row
	columnKey = operation.ColumnKey

	if err := s.validateCellWriteAccess(userID, sheetID, row, columnKey); err != nil {
		return nil, err
	}

	raw, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal cell value: %w", err)
	}

	if err := s.sheetService.UpdateCells(userID, []model.CellUpdate{{SheetID: sheetID, Row: row, Col: columnKey, Value: raw}}); err != nil {
		return nil, err
	}

	if err := s.invalidateSheetByID(sheetID); err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data:            map[string]any{"ok": true, "sheet_id": sheetID, "row": row, "column_key": columnKey, "value": value},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已更新第 %d 行的 %s", row+1, columnKey),
	}, nil
}

func (s *AIService) toolInsertRow(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	row, err := intArg(args, "row")
	if err != nil {
		return nil, err
	}
	rowValues := mapArg(args, "row_values")

	operation, err := s.resolveSpreadsheetOperationForExecution(SpreadsheetOperation{
		Kind:      "insert_row",
		SheetID:   sheetID,
		Row:       row,
		RowValues: rowValues,
	})
	if err != nil {
		return nil, err
	}
	sheetID = operation.SheetID
	row = operation.Row
	rowValues = operation.RowValues

	afterRow := row - 1
	if err := s.validateRowWriteAccess(userID, sheetID, afterRow); err != nil {
		return nil, err
	}
	for key := range rowValues {
		if err := s.validateCellWriteAccess(userID, sheetID, row, key); err != nil {
			return nil, err
		}
	}

	if err := s.sheetService.InsertRow(userID, sheetID, afterRow); err != nil {
		return nil, err
	}

	if len(rowValues) > 0 {
		changes := make([]model.CellUpdate, 0, len(rowValues))
		for key, value := range rowValues {
			raw, err := json.Marshal(value)
			if err != nil {
				return nil, fmt.Errorf("marshal inserted row value: %w", err)
			}
			changes = append(changes, model.CellUpdate{SheetID: sheetID, Row: row, Col: key, Value: raw})
		}
		if err := s.sheetService.UpdateCells(userID, changes); err != nil {
			return nil, err
		}
	}

	if err := s.invalidateSheetByID(sheetID); err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data:            map[string]any{"ok": true, "sheet_id": sheetID, "row": row, "row_values": rowValues},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已插入第 %d 行", row+1),
	}, nil
}

func (s *AIService) toolDeleteRow(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	row, err := intArg(args, "row")
	if err != nil {
		return nil, err
	}

	operation, err := s.resolveSpreadsheetOperationForExecution(SpreadsheetOperation{
		Kind:    "delete_row",
		SheetID: sheetID,
		Row:     row,
	})
	if err != nil {
		return nil, err
	}
	sheetID = operation.SheetID
	row = operation.Row

	if err := s.validateRowWriteAccess(userID, sheetID, row); err != nil {
		return nil, err
	}
	if err := s.sheetService.DeleteRow(userID, sheetID, row); err != nil {
		return nil, err
	}
	if err := s.invalidateSheetByID(sheetID); err != nil {
		return nil, err
	}

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "row": row}, TouchedSheetIDs: []int64{sheetID}, Summary: fmt.Sprintf("已删除第 %d 行", row+1)}, nil
}

func (s *AIService) toolInsertColumn(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	columnName, err := stringArg(args, "column_name")
	if err != nil {
		return nil, err
	}
	columnType, _ := stringArgWithDefault(args, "column_type", "text")
	insertAfter, _ := stringArgWithDefault(args, "insert_after_column_key", "")
	formulaTemplate, _ := stringArgWithDefault(args, "formula_template", "")
	value, hasValue := args["value"]

	operation := SpreadsheetOperation{
		Kind:                 "insert_column",
		SheetID:              sheetID,
		ColumnKey:            columnKey,
		ColumnName:           columnName,
		ColumnType:           columnType,
		InsertAfterColumnKey: insertAfter,
		FormulaTemplate:      formulaTemplate,
	}
	if hasValue {
		operation.Value = value
	}

	touched, err := s.executeSpreadsheetOperations(userID, []SpreadsheetOperation{operation})
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey}, TouchedSheetIDs: touched, Summary: fmt.Sprintf("已新增列 %s", columnKey)}, nil
}

func (s *AIService) toolAutoFillColumn(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	formulaTemplate, err := stringArg(args, "formula_template")
	if err != nil {
		return nil, err
	}
	startRow, hasStart := intPtrArg(args, "start_row")
	endRow, hasEnd := intPtrArg(args, "end_row")

	operation := SpreadsheetOperation{Kind: "fill_formula", SheetID: sheetID, ColumnKey: columnKey, FormulaTemplate: formulaTemplate}
	if hasStart {
		operation.StartRow = startRow
	}
	if hasEnd {
		operation.EndRow = endRow
	}

	touched, err := s.executeSpreadsheetOperations(userID, []SpreadsheetOperation{operation})
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey}, TouchedSheetIDs: touched, Summary: fmt.Sprintf("已批量填充列 %s", columnKey)}, nil
}

func (s *AIService) toolGenerateReport(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}

	filename, _ := stringArgWithDefault(args, "filename", fmt.Sprintf("sheet-%d-report.xlsx", sheetID))
	attachment, url, err := s.GenerateSheetReport(userID, sheetID, filename)
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{Data: map[string]any{
		"attachment_id": attachment.ID,
		"filename":      attachment.Filename,
		"download_url":  url,
	}, Summary: fmt.Sprintf("已生成报表 %s", attachment.Filename)}, nil
}

func (s *AIService) toolScheduleDailyReport(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.scheduleService == nil {
		return nil, fmt.Errorf("schedule service is not available")
	}
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetExportAccess(userID, sheetID); err != nil {
		return nil, err
	}
	timeOfDay, err := stringArg(args, "time")
	if err != nil {
		return nil, err
	}
	timezone, _ := stringArgWithDefault(args, "timezone", "Asia/Shanghai")
	filenameTemplate, _ := stringArgWithDefault(args, "filename_template", fmt.Sprintf("sheet-%d-daily-report", sheetID))

	schedule, err := s.scheduleService.CreateDailyReportSchedule(userID, sheetID, timeOfDay, timezone, filenameTemplate)
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{Data: map[string]any{
		"schedule_id":       schedule.ID,
		"sheet_id":          schedule.SheetID,
		"cron_expr":         schedule.CronExpr,
		"timezone":          schedule.Timezone,
		"filename_template": schedule.FilenameTemplate,
	}, Summary: fmt.Sprintf("已创建每日 %s (%s) 的定时报表任务", timeOfDay, timezone)}, nil
}

func (s *AIService) GenerateSheetReport(userID, sheetID int64, filename string) (*model.Attachment, string, error) {
	exportFile, err := s.sheetService.BuildSheetExportFile(userID, sheetID, filename)
	if err != nil {
		return nil, "", err
	}

	attachment, url, err := s.uploadService.UploadBytes(exportFile.Filename, exportFile.ContentType, exportFile.Data, userID)
	if err != nil {
		return nil, "", err
	}

	return attachment, url, nil
}

func (s *AIService) toolRunWorkflow(userID int64, args map[string]any) (*toolExecutionResult, error) {
	operations, err := spreadsheetOperationsArg(args, "operations")
	if err != nil {
		return nil, err
	}
	touched, err := s.executeSpreadsheetOperations(userID, operations)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{Data: map[string]any{"ok": true, "applied": len(operations)}, TouchedSheetIDs: touched, Summary: fmt.Sprintf("已执行 %d 条工作流操作", len(operations))}, nil
}

func (s *AIService) toolPreviewSpreadsheetPlan(userID int64, args map[string]any) (*toolExecutionResult, error) {
	workbookID, err := int64Arg(args, "workbook_id")
	if err != nil {
		return nil, err
	}
	sheetIDs, err := int64SliceArg(args, "sheet_ids")
	if err != nil {
		return nil, err
	}
	prompt, err := stringArg(args, "prompt")
	if err != nil {
		return nil, err
	}

	workbook, err := s.sheetService.GetWorkbook(workbookID, userID)
	if err != nil {
		return nil, err
	}
	visibleSheets := make(map[int64]struct{}, len(workbook.Sheets))
	for _, sheet := range workbook.Sheets {
		visibleSheets[sheet.ID] = struct{}{}
	}
	for _, sheetID := range sheetIDs {
		if _, ok := visibleSheets[sheetID]; !ok {
			return nil, fmt.Errorf("sheet %d is not accessible", sheetID)
		}
	}

	result, err := s.PreviewSpreadsheetPlan(&SpreadsheetPlanRequest{WorkbookID: workbookID, SheetIDs: sheetIDs, Prompt: prompt})
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{Data: result, Summary: fmt.Sprintf("已生成 %d 条待确认修改", len(result.Operations)), PendingOperations: result.Operations}, nil
}

func (s *AIService) toolApplySpreadsheetPlan(userID int64, args map[string]any) (*toolExecutionResult, error) {
	operations, err := spreadsheetOperationsArg(args, "operations")
	if err != nil {
		return nil, err
	}
	touched, err := s.executeSpreadsheetOperations(userID, operations)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{Data: map[string]any{"ok": true, "applied": len(operations)}, TouchedSheetIDs: touched, Summary: fmt.Sprintf("已写入 %d 条表格修改", len(operations))}, nil
}

func (s *AIService) buildUserContextSnapshot(userID int64, limit int) (map[string]any, error) {
	workbooks, _, err := s.sheetService.ListWorkbooks(userID, 1, limit)
	if err != nil {
		return nil, err
	}

	items := make([]map[string]any, 0, len(workbooks))
	for _, workbook := range workbooks {
		detail, err := s.sheetService.GetWorkbook(workbook.ID, userID)
		if err != nil {
			continue
		}

		sheets := make([]map[string]any, 0, len(detail.Sheets))
		for _, sheet := range detail.Sheets {
			columns, _ := parseSheetColumns(sheet.Columns)
			sheets = append(sheets, map[string]any{
				"sheet_id":   sheet.ID,
				"sheet_name": sheet.Name,
				"columns":    columns,
			})
		}

		items = append(items, map[string]any{
			"workbook_id":   detail.ID,
			"workbook_name": detail.Name,
			"owner_name":    detail.OwnerName,
			"sheets":        sheets,
		})
	}

	return map[string]any{"workbooks": items}, nil
}

func (s *AIService) ensureSheetViewAccess(userID, sheetID int64) error {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return err
	}
	if !matrix.Sheet.CanView {
		return fmt.Errorf("sheet view permission denied")
	}
	return nil
}

func (s *AIService) ensureSheetExportAccess(userID, sheetID int64) error {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return err
	}
	if !matrix.Sheet.CanExport {
		return fmt.Errorf("%w: 当前账号没有导出这个工作表的权限", ErrSheetExportDenied)
	}
	return nil
}

func (s *AIService) validateCellWriteAccess(userID, sheetID int64, row int, columnKey string) error {
	allowed, err := s.permService.CheckCellPermission(sheetID, userID, columnKey, row, "write")
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("cell write permission denied")
	}

	protected, reason, err := s.sheetService.CheckProtection(sheetID, row, columnKey, userID)
	if err != nil {
		return err
	}
	if protected {
		return fmt.Errorf(reason)
	}
	return nil
}

func (s *AIService) validateRowWriteAccess(userID, sheetID int64, row int) error {
	allowed, err := s.permService.CheckCellPermission(sheetID, userID, "", row, "write")
	if err != nil {
		return err
	}
	if !allowed {
		return fmt.Errorf("row write permission denied")
	}

	protected, reason, err := s.sheetService.CheckProtection(sheetID, row, "", userID)
	if err != nil {
		return err
	}
	if protected {
		return fmt.Errorf(reason)
	}
	return nil
}

func (s *AIService) executeSpreadsheetOperations(userID int64, operations []SpreadsheetOperation) ([]int64, error) {
	touchedSheets := make(map[int64]struct{})

	for _, operation := range operations {
		normalized, err := s.resolveSpreadsheetOperationForExecution(operation)
		if err != nil {
			return nil, err
		}
		if normalized.SheetID == 0 {
			return nil, fmt.Errorf("invalid spreadsheet operation")
		}
		if err := s.validateSpreadsheetOperationAccess(userID, normalized); err != nil {
			return nil, err
		}
		if err := s.applySpreadsheetOperation(userID, normalized); err != nil {
			return nil, err
		}
		touchedSheets[normalized.SheetID] = struct{}{}
	}

	for sheetID := range touchedSheets {
		if err := s.invalidateSheetByID(sheetID); err != nil {
			return nil, err
		}
	}

	return sortedTouchedSheetIDs(touchedSheets), nil
}

func (s *AIService) validateSpreadsheetOperationAccess(userID int64, operation SpreadsheetOperation) error {
	switch operation.Kind {
	case "insert_row":
		return s.validateRowWriteAccess(userID, operation.SheetID, operation.Row-1)
	case "delete_row":
		return s.validateRowWriteAccess(userID, operation.SheetID, operation.Row)
	case "insert_column":
		matrix, err := s.permService.GetPermissionMatrix(operation.SheetID, userID)
		if err != nil {
			return err
		}
		if !matrix.Sheet.CanEdit {
			return fmt.Errorf("sheet edit permission denied")
		}
	case "fill_formula":
		startRow := 0
		if operation.StartRow != nil {
			startRow = *operation.StartRow
		}
		endRow := startRow
		if operation.EndRow != nil {
			endRow = *operation.EndRow
		}
		for row := startRow; row <= endRow; row++ {
			if err := s.validateCellWriteAccess(userID, operation.SheetID, row, operation.ColumnKey); err != nil {
				return err
			}
		}
	default:
		return s.validateCellWriteAccess(userID, operation.SheetID, operation.Row, operation.ColumnKey)
	}

	return nil
}

func (s *AIService) resolveSpreadsheetOperationForExecution(operation SpreadsheetOperation) (SpreadsheetOperation, error) {
	operation = normalizeSpreadsheetOperation(operation)
	if operation.SheetID == 0 {
		return operation, nil
	}

	sheet, err := s.sheetRepo.GetSheet(operation.SheetID)
	if err != nil {
		return operation, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return operation, err
	}
	if strings.TrimSpace(operation.ColumnKey) == "" && strings.TrimSpace(operation.ColumnName) != "" {
		columnName := strings.TrimSpace(operation.ColumnName)
		for _, column := range columns {
			if strings.EqualFold(strings.TrimSpace(column.Key), columnName) || strings.EqualFold(strings.TrimSpace(column.Name), columnName) {
				operation.ColumnKey = column.Key
				break
			}
		}
	}

	rows, err := s.sheetRepo.GetRows(operation.SheetID)
	if err != nil {
		return operation, err
	}
	rowBase := getSheetRowBase(rows)
	rowCount := len(rows)

	adjust := func(value int) int {
		if rowCount == 0 {
			if value > 0 {
				return value - 1
			}
			return value
		}
		if rowBase > 0 && value >= 0 {
			return value + rowBase
		}
		return value
	}

	switch operation.Kind {
	case "update_cell", "insert_row", "delete_row":
		operation.Row = adjust(operation.Row)
	case "fill_formula":
		if operation.StartRow != nil {
			value := adjust(*operation.StartRow)
			operation.StartRow = &value
		}
		if operation.EndRow != nil {
			value := adjust(*operation.EndRow)
			operation.EndRow = &value
		}
	}

	if operation.Kind == "update_cell" && strings.TrimSpace(operation.ColumnKey) == "" && len(columns) > 0 {
		operation.ColumnKey = columns[0].Key
	}

	return operation, nil
}

func (s *AIService) invalidateSheetByID(sheetID int64) error {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return fmt.Errorf("reload touched sheet: %w", err)
	}
	return s.invalidateSheetSnapshot(sheet)
}

func int64Arg(args map[string]any, key string) (int64, error) {
	value, ok := args[key]
	if !ok {
		return 0, fmt.Errorf("%s is required", key)
	}
	switch v := value.(type) {
	case float64:
		return int64(v), nil
	case int64:
		return v, nil
	case int:
		return int64(v), nil
	default:
		return 0, fmt.Errorf("%s must be an integer", key)
	}
}

func intArg(args map[string]any, key string) (int, error) {
	value, err := int64Arg(args, key)
	if err != nil {
		return 0, err
	}
	return int(value), nil
}

func intArgWithDefault(args map[string]any, key string, fallback int) (int, error) {
	if _, ok := args[key]; !ok {
		return fallback, nil
	}
	return intArg(args, key)
}

func intPtrArg(args map[string]any, key string) (*int, bool) {
	value, ok := args[key]
	if !ok {
		return nil, false
	}
	intValue, ok := value.(float64)
	if !ok {
		return nil, false
	}
	parsed := int(intValue)
	return &parsed, true
}

func stringArg(args map[string]any, key string) (string, error) {
	value, ok := args[key]
	if !ok {
		return "", fmt.Errorf("%s is required", key)
	}
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("%s must be a non-empty string", key)
	}
	return strings.TrimSpace(text), nil
}

func stringArgWithDefault(args map[string]any, key, fallback string) (string, error) {
	value, ok := args[key]
	if !ok {
		return fallback, nil
	}
	text, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("%s must be a string", key)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return fallback, nil
	}
	return text, nil
}

func stringSliceArg(args map[string]any, key string) []string {
	items, ok := args[key].([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		text, ok := item.(string)
		if ok && strings.TrimSpace(text) != "" {
			result = append(result, strings.TrimSpace(text))
		}
	}
	return result
}

func int64SliceArg(args map[string]any, key string) ([]int64, error) {
	items, ok := args[key].([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	result := make([]int64, 0, len(items))
	for _, item := range items {
		number, ok := item.(float64)
		if !ok {
			return nil, fmt.Errorf("%s must contain integers", key)
		}
		result = append(result, int64(number))
	}
	return result, nil
}

func mapArg(args map[string]any, key string) map[string]any {
	value, ok := args[key]
	if !ok {
		return map[string]any{}
	}
	parsed, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	return parsed
}

func spreadsheetOperationsArg(args map[string]any, key string) ([]SpreadsheetOperation, error) {
	value, ok := args[key]
	if !ok {
		return nil, fmt.Errorf("%s is required", key)
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, fmt.Errorf("marshal %s: %w", key, err)
	}
	var operations []SpreadsheetOperation
	if err := json.Unmarshal(encoded, &operations); err != nil {
		return nil, fmt.Errorf("parse %s: %w", key, err)
	}
	return operations, nil
}
