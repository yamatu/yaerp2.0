package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"math"
	"net/http"
	"sort"
	"strconv"
	"strings"

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
		"search_spreadsheets":      s.toolSearchSpreadsheets,
		"search_sheet_rows":        s.toolSearchSheetRows,
		"lookup_sheet_records":     s.toolLookupSheetRecords,
		"calculate_sheet_metrics":  s.toolCalculateSheetMetrics,
		"calculate_expression":     s.toolCalculateExpression,
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
		"create_workbook":          s.toolCreateWorkbook,
		"create_sheet":             s.toolCreateSheet,
		"update_workbook":          s.toolUpdateWorkbook,
		"update_sheet_name":        s.toolUpdateSheetName,
		"set_cell_format":          s.toolSetCellFormat,
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
	roleHint := s.getUserRoleHint(userID)
	result := []map[string]any{
		{
			"role": "system",
			"content": fmt.Sprintf(
				"你是 YaERP 智能表格助手。你必须优先使用工具来查询或修改表格，不要编造不存在的数据。"+
					"如果用户要查询、统计、修改、批量填充、生成报表，请调用合适的工具；完成后用中文总结结果。"+
					"如果用户要求修改表格，默认先调用 preview_spreadsheet_plan 生成待确认方案；只有当用户明确要求立即执行时，才调用 apply_spreadsheet_plan 或其他写入工具直接执行。"+
					"注意：工作表第一可见行通常是表头行，query_sheet 返回的 rows 只包含真实数据行，不包含表头；rows[*].row 一律表示 0-based 数据行索引（第一条数据行为 0，不是界面里显示的第 2 行），display_row 才是界面中的行号；如果 total_rows=0 但 columns/header_row 有内容，表示该表只有表头结构，没有数据行。"+
					"\n\n%s"+
					"\n\n支持的列类型：text（文本）、number（数字）、currency（货币）、date（日期）、select（下拉选择）、image（图片）、formula（公式）。"+
					"\n支持的公式：SUM、AVERAGE、COUNT、MAX、MIN、IF、VLOOKUP、CONCATENATE 等 Excel 兼容公式。公式模板可使用 {{row}} 表示当前 Excel 行号。"+
					"\n你可以创建和管理工作簿/工作表：使用 create_workbook 创建工作簿，create_sheet 创建工作表，update_workbook 修改工作簿名称/描述，update_sheet_name 重命名工作表，set_cell_format 修改列格式。"+
					"\n\n当前用户可访问的数据摘要如下：\n\n%s",
				roleHint,
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

func (s *AIService) getUserRoleHint(userID int64) string {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return "你只能查看和修改自己有权限的工作簿和工作表。"
	}
	if isAdmin {
		return "你是管理员，可以查看和管理所有用户的工作簿和工作表。"
	}
	return "你只能查看和修改自己有权限的工作簿和工作表。"
}

func (s *AIService) buildToolDefinitions() []openAIToolDefinition {
	return []openAIToolDefinition{
		buildToolDefinition("get_user_context", "Get accessible workbook and sheet summary.", map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}),
		buildToolDefinition("query_sheet", "Query sheet columns and rows.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":    map[string]any{"type": "integer"},
				"start_row":   map[string]any{"type": "integer"},
				"limit":       map[string]any{"type": "integer"},
				"column_keys": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"sheet_id"},
		}),
		buildToolDefinition("search_spreadsheets", "Search all accessible spreadsheets by keywords.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"keywords":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"mode":           map[string]any{"type": "string", "description": "any or all"},
				"limit":          map[string]any{"type": "integer"},
				"return_columns": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"keywords"},
		}),
		buildToolDefinition("search_sheet_rows", "Search rows in one sheet by keywords.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":       map[string]any{"type": "integer"},
				"keywords":       map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"mode":           map[string]any{"type": "string", "description": "any or all"},
				"limit":          map[string]any{"type": "integer"},
				"start_row":      map[string]any{"type": "integer"},
				"return_columns": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"sheet_id", "keywords"},
		}),
		buildToolDefinition("lookup_sheet_records", "Lookup rows in one sheet by field criteria.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":       map[string]any{"type": "integer"},
				"criteria":       map[string]any{"type": "object"},
				"match_mode":     map[string]any{"type": "string", "description": "contains or exact"},
				"limit":          map[string]any{"type": "integer"},
				"return_columns": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			},
			"required": []string{"sheet_id", "criteria"},
		}),
		buildToolDefinition("calculate_sheet_metrics", "Calculate metrics for numeric columns in a sheet.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":    map[string]any{"type": "integer"},
				"column_keys": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"metrics":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"keywords":    map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"mode":        map[string]any{"type": "string", "description": "any or all"},
			},
			"required": []string{"sheet_id", "column_keys", "metrics"},
		}),
		buildToolDefinition("calculate_expression", "Evaluate a basic math expression.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"expression": map[string]any{"type": "string"},
				"scale":      map[string]any{"type": "integer"},
			},
			"required": []string{"expression"},
		}),
		buildToolDefinition("update_cell", "Update one cell value.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":   map[string]any{"type": "integer"},
				"row":        map[string]any{"type": "integer"},
				"column_key": map[string]any{"type": "string"},
				"value":      map[string]any{},
			},
			"required": []string{"sheet_id", "row", "column_key", "value"},
		}),
		buildToolDefinition("insert_row", "Insert a row at target position.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":   map[string]any{"type": "integer"},
				"row":        map[string]any{"type": "integer"},
				"row_values": map[string]any{"type": "object"},
			},
			"required": []string{"sheet_id", "row"},
		}),
		buildToolDefinition("delete_row", "Delete one row.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id": map[string]any{"type": "integer"},
				"row":      map[string]any{"type": "integer"},
			},
			"required": []string{"sheet_id", "row"},
		}),
		buildToolDefinition("insert_column", "Insert a new column.", map[string]any{
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
		buildToolDefinition("auto_fill_column", "Fill a column with formula template.", map[string]any{
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
		buildToolDefinition("generate_report", "Generate an Excel report for a sheet.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id": map[string]any{"type": "integer"},
				"filename": map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id"},
		}),
		buildToolDefinition("schedule_daily_report", "Create a daily report schedule.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":          map[string]any{"type": "integer"},
				"time":              map[string]any{"type": "string"},
				"timezone":          map[string]any{"type": "string"},
				"filename_template": map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "time"},
		}),
		buildToolDefinition("run_workflow", "Execute multiple spreadsheet operations.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operations": map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"operations"},
		}),
		buildToolDefinition("preview_spreadsheet_plan", "Preview spreadsheet operations from a prompt.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workbook_id": map[string]any{"type": "integer"},
				"sheet_ids":   map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
				"prompt":      map[string]any{"type": "string"},
			},
			"required": []string{"workbook_id", "sheet_ids", "prompt"},
		}),
		buildToolDefinition("apply_spreadsheet_plan", "Apply structured spreadsheet operations.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operations": map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"operations"},
		}),
		buildToolDefinition("create_workbook", "Create a workbook.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":        map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
			},
			"required": []string{"name"},
		}),
		buildToolDefinition("create_sheet", "Create a sheet in a workbook.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workbook_id": map[string]any{"type": "integer"},
				"name":        map[string]any{"type": "string"},
				"columns":     map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"workbook_id", "name"},
		}),
		buildToolDefinition("update_workbook", "Update workbook name or description.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workbook_id": map[string]any{"type": "integer"},
				"name":        map[string]any{"type": "string"},
				"description": map[string]any{"type": "string"},
			},
			"required": []string{"workbook_id"},
		}),
		buildToolDefinition("update_sheet_name", "Rename a sheet.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id": map[string]any{"type": "integer"},
				"name":     map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "name"},
		}),
		buildToolDefinition("set_cell_format", "Set column format.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":   map[string]any{"type": "integer"},
				"column_key": map[string]any{"type": "string"},
				"format":     map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "column_key", "format"},
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

	client := &http.Client{Timeout: aiRequestTimeout}
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

	if len(rows) == 0 {
		// Fallback: extract data from Univer.js snapshot if rows table is empty.
		// In cellData, row 0 is the header; data rows start from row 1.
		// API responses still expose rows[*].row as a 0-based data-row index,
		// while source_row/display_row keep the worksheet coordinates for the UI.
		snapRows := extractRowsFromSnapshot(sheet.Config, columns)
		for _, sr := range snapRows {
			dataRowIndex := sr.RowIndex - 1
			// display_row = worksheet row + 1 (matches the 1-based row number in the UI)
			displayRow := sr.RowIndex + 1
			if dataRowIndex < startRow {
				continue
			}
			data := sr.Data
			// Apply column filter
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
				"row":         dataRowIndex,
				"source_row":  sr.RowIndex,
				"display_row": displayRow,
				"data":        data,
			})
			if len(filteredRows) >= limit {
				break
			}
		}

		totalRows := len(snapRows)
		return &toolExecutionResult{Data: map[string]any{
			"sheet_id":    sheet.ID,
			"sheet_name":  sheet.Name,
			"columns":     columns,
			"header_row":  columns,
			"rows":        filteredRows,
			"total_rows":  totalRows,
			"header_only": totalRows == 0 && len(columns) > 0,
			"data_source": "snapshot",
		}, Summary: buildQuerySheetSummary(sheet.Name, len(filteredRows), len(columns))}, nil
	}

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

func (s *AIService) toolSearchSpreadsheets(userID int64, args map[string]any) (*toolExecutionResult, error) {
	keywords := normalizeSearchKeywords(stringSliceArg(args, "keywords"))
	if len(keywords) == 0 {
		return nil, fmt.Errorf("keywords is required")
	}
	mode, _ := stringArgWithDefault(args, "mode", "any")
	returnColumns := stringSliceArg(args, "return_columns")
	limit, _ := intArgWithDefault(args, "limit", 20)
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	snapshot, err := s.buildUserContextSnapshot(userID, 100)
	if err != nil {
		return nil, err
	}
	workbooks, _ := snapshot["workbooks"].([]map[string]any)

	matches := make([]map[string]any, 0, limit)
	touched := make(map[int64]struct{})
	for _, workbookItem := range workbooks {
		workbookID, _ := toInt64(workbookItem["workbook_id"])
		workbookName, _ := workbookItem["workbook_name"].(string)
		sheetItems, _ := workbookItem["sheets"].([]map[string]any)
		for _, sheetItem := range sheetItems {
			sheetID, _ := toInt64(sheetItem["sheet_id"])
			sheetName, _ := sheetItem["sheet_name"].(string)
			sheet, err := s.sheetRepo.GetSheet(sheetID)
			if err != nil {
				continue
			}
			rows, err := s.sheetRepo.GetRows(sheetID)
			if err != nil {
				continue
			}
			columns, err := parseSheetColumns(sheet.Columns)
			if err != nil {
				continue
			}
			previewRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
			if err != nil {
				continue
			}
			for _, row := range previewRows {
				rowMatches := collectRowKeywordMatches(row.Data, columns, keywords, mode)
				if len(rowMatches) == 0 {
					continue
				}
				matches = append(matches, map[string]any{
					"workbook_id":   workbookID,
					"workbook_name": workbookName,
					"sheet_id":      sheetID,
					"sheet_name":    sheetName,
					"row":           row.Row,
					"display_row":   row.DisplayRow,
					"matches":       rowMatches,
					"data":          filterRowDataByColumns(row.Data, columns, returnColumns),
				})
				touched[sheetID] = struct{}{}
				if len(matches) >= limit {
					return &toolExecutionResult{
						Data: map[string]any{
							"keywords": keywords,
							"mode":     normalizeSearchMode(mode),
							"limit":    limit,
							"matches":  matches,
						},
						TouchedSheetIDs: sortedTouchedSheetIDs(touched),
						Summary:         fmt.Sprintf("已在 %d 个位置找到关键字", len(matches)),
					}, nil
				}
			}
		}
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"keywords": keywords,
			"mode":     normalizeSearchMode(mode),
			"limit":    limit,
			"matches":  matches,
		},
		TouchedSheetIDs: sortedTouchedSheetIDs(touched),
		Summary:         fmt.Sprintf("已在 %d 个位置找到关键字", len(matches)),
	}, nil
}

func (s *AIService) toolSearchSheetRows(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}
	keywords := normalizeSearchKeywords(stringSliceArg(args, "keywords"))
	if len(keywords) == 0 {
		return nil, fmt.Errorf("keywords is required")
	}
	mode, _ := stringArgWithDefault(args, "mode", "any")
	returnColumns := stringSliceArg(args, "return_columns")
	limit, _ := intArgWithDefault(args, "limit", 20)
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	startRow, _ := intArgWithDefault(args, "start_row", 0)

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	previewRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	results := make([]map[string]any, 0, limit)
	for _, row := range previewRows {
		if row.Row < startRow {
			continue
		}
		rowMatches := collectRowKeywordMatches(row.Data, columns, keywords, mode)
		if len(rowMatches) == 0 {
			continue
		}
		results = append(results, map[string]any{
			"sheet_id":    sheetID,
			"sheet_name":  sheet.Name,
			"row":         row.Row,
			"display_row": row.DisplayRow,
			"matches":     rowMatches,
			"data":        filterRowDataByColumns(row.Data, columns, returnColumns),
		})
		if len(results) >= limit {
			break
		}
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"sheet_id":   sheetID,
			"sheet_name": sheet.Name,
			"keywords":   keywords,
			"mode":       normalizeSearchMode(mode),
			"limit":      limit,
			"rows":       results,
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("在工作表 %s 中找到 %d 条匹配记录", sheet.Name, len(results)),
	}, nil
}

func (s *AIService) toolLookupSheetRecords(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}

	criteria := mapArg(args, "criteria")
	if len(criteria) == 0 {
		return nil, fmt.Errorf("criteria is required")
	}
	matchMode, _ := stringArgWithDefault(args, "match_mode", "contains")
	returnColumns := stringSliceArg(args, "return_columns")
	limit, _ := intArgWithDefault(args, "limit", 20)
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	previewRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}

	results := make([]map[string]any, 0, limit)
	for _, row := range previewRows {
		matchedFields := collectCriteriaMatches(row.Data, columns, criteria, matchMode)
		if len(matchedFields) == 0 {
			continue
		}

		results = append(results, map[string]any{
			"sheet_id":       sheetID,
			"sheet_name":     sheet.Name,
			"row":            row.Row,
			"display_row":    row.DisplayRow,
			"matched_fields": matchedFields,
			"data":           filterRowDataByColumns(row.Data, columns, returnColumns),
		})
		if len(results) >= limit {
			break
		}
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"sheet_id":     sheetID,
			"sheet_name":   sheet.Name,
			"criteria":     criteria,
			"match_mode":   normalizeLookupMode(matchMode),
			"limit":        limit,
			"matched_rows": len(results),
			"rows":         results,
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("matched %d records in %s", len(results), sheet.Name),
	}, nil
}

func (s *AIService) toolCalculateSheetMetrics(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}
	columnKeys := normalizeSearchKeywords(stringSliceArg(args, "column_keys"))
	if len(columnKeys) == 0 {
		return nil, fmt.Errorf("column_keys is required")
	}
	metrics := normalizeSearchKeywords(stringSliceArg(args, "metrics"))
	if len(metrics) == 0 {
		return nil, fmt.Errorf("metrics is required")
	}
	keywords := normalizeSearchKeywords(stringSliceArg(args, "keywords"))
	mode, _ := stringArgWithDefault(args, "mode", "any")

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	previewRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	filteredRows := make([]aiPreviewRow, 0, len(previewRows))
	for _, row := range previewRows {
		if len(keywords) == 0 || len(collectRowKeywordMatches(row.Data, columns, keywords, mode)) > 0 {
			filteredRows = append(filteredRows, row)
		}
	}

	calculations := make(map[string]map[string]any, len(columnKeys))
	for _, columnKey := range columnKeys {
		values := make([]float64, 0, len(filteredRows))
		nonEmptyCount := 0
		for _, row := range filteredRows {
			value, ok := row.Data[columnKey]
			if !ok || value == nil || strings.TrimSpace(fmt.Sprintf("%v", value)) == "" {
				continue
			}
			nonEmptyCount++
			if numeric, ok := toFloat64(value); ok {
				values = append(values, numeric)
			}
		}

		columnMetrics := make(map[string]any)
		for _, metric := range metrics {
			switch metric {
			case "sum":
				columnMetrics[metric] = sumFloat64(values)
			case "avg":
				if len(values) == 0 {
					columnMetrics[metric] = nil
				} else {
					columnMetrics[metric] = sumFloat64(values) / float64(len(values))
				}
			case "min":
				columnMetrics[metric] = minFloat64(values)
			case "max":
				columnMetrics[metric] = maxFloat64(values)
			case "count":
				columnMetrics[metric] = len(values)
			case "count_non_empty":
				columnMetrics[metric] = nonEmptyCount
			}
		}
		calculations[columnKey] = columnMetrics
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"sheet_id":        sheetID,
			"sheet_name":      sheet.Name,
			"keywords":        keywords,
			"mode":            normalizeSearchMode(mode),
			"matched_rows":    len(filteredRows),
			"column_metrics":  calculations,
			"requested_stats": metrics,
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已完成工作表 %s 的快速计算，共统计 %d 行", sheet.Name, len(filteredRows)),
	}, nil
}

func (s *AIService) toolCalculateExpression(_ int64, args map[string]any) (*toolExecutionResult, error) {
	expression, err := stringArg(args, "expression")
	if err != nil {
		return nil, err
	}
	scale, _ := intArgWithDefault(args, "scale", 4)
	if scale < 0 {
		scale = 0
	}
	if scale > 8 {
		scale = 8
	}

	result, err := evaluateMathExpression(expression)
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"expression":       expression,
			"result":           result,
			"formatted_result": formatComputedNumber(result, scale),
			"scale":            scale,
		},
		Summary: fmt.Sprintf("%s = %s", expression, formatComputedNumber(result, scale)),
	}, nil
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

	existingRows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	isEmptySheet := len(existingRows) == 0

	if !isEmptySheet {
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

func (s *AIService) toolCreateWorkbook(userID int64, args map[string]any) (*toolExecutionResult, error) {
	name, err := stringArg(args, "name")
	if err != nil {
		return nil, err
	}
	description, _ := stringArgWithDefault(args, "description", "")

	workbook := &model.Workbook{
		Name:    name,
		OwnerID: userID,
	}
	if description != "" {
		workbook.Description = &description
	}

	if err := s.sheetService.CreateWorkbookForUser(userID, workbook); err != nil {
		return nil, fmt.Errorf("创建工作簿失败: %w", err)
	}

	return &toolExecutionResult{
		Data:    map[string]any{"ok": true, "workbook_id": workbook.ID, "name": workbook.Name},
		Summary: fmt.Sprintf("已创建工作簿「%s」(ID:%d)", workbook.Name, workbook.ID),
	}, nil
}

func (s *AIService) toolCreateSheet(userID int64, args map[string]any) (*toolExecutionResult, error) {
	workbookID, err := int64Arg(args, "workbook_id")
	if err != nil {
		return nil, err
	}
	name, err := stringArg(args, "name")
	if err != nil {
		return nil, err
	}

	sheet := &model.Sheet{
		WorkbookID: workbookID,
		Name:       name,
	}

	columnsRaw, hasColumns := args["columns"]
	if hasColumns {
		columnsJSON, err := json.Marshal(columnsRaw)
		if err != nil {
			return nil, fmt.Errorf("列定义序列化失败: %w", err)
		}
		var columns []sheetColumnPayload
		if err := json.Unmarshal(columnsJSON, &columns); err != nil {
			return nil, fmt.Errorf("列定义格式错误: %w", err)
		}
		for i := range columns {
			if columns[i].Key == "" {
				columns[i].Key = columns[i].Name
			}
			if columns[i].Type == "" {
				columns[i].Type = "text"
			}
			if columns[i].Width == 0 {
				columns[i].Width = 140.0
			}
		}
		finalJSON, err := json.Marshal(columns)
		if err != nil {
			return nil, fmt.Errorf("列定义序列化失败: %w", err)
		}
		sheet.Columns = finalJSON
	}

	if err := s.sheetService.CreateSheetForUser(userID, sheet); err != nil {
		return nil, fmt.Errorf("创建工作表失败: %w", err)
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":          true,
			"sheet_id":    sheet.ID,
			"workbook_id": workbookID,
			"name":        sheet.Name,
			"hint":        fmt.Sprintf("Use sheet_id=%d (NOT workbook_id=%d) for insert_row, update_cell, query_sheet, etc.", sheet.ID, workbookID),
		},
		Summary: fmt.Sprintf("已在工作簿(ID:%d)中创建工作表「%s」(ID:%d)", workbookID, sheet.Name, sheet.ID),
	}, nil
}

func (s *AIService) toolUpdateWorkbook(userID int64, args map[string]any) (*toolExecutionResult, error) {
	workbookID, err := int64Arg(args, "workbook_id")
	if err != nil {
		return nil, err
	}

	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return nil, fmt.Errorf("工作簿不存在: %w", err)
	}

	if name, _ := stringArgWithDefault(args, "name", ""); name != "" {
		workbook.Name = name
	}
	if description, _ := stringArgWithDefault(args, "description", ""); description != "" {
		workbook.Description = &description
	}

	if err := s.sheetService.UpdateWorkbookForUser(userID, workbook); err != nil {
		return nil, fmt.Errorf("更新工作簿失败: %w", err)
	}

	return &toolExecutionResult{
		Data:    map[string]any{"ok": true, "workbook_id": workbook.ID, "name": workbook.Name},
		Summary: fmt.Sprintf("已更新工作簿「%s」(ID:%d)", workbook.Name, workbook.ID),
	}, nil
}

func (s *AIService) toolUpdateSheetName(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	name, err := stringArg(args, "name")
	if err != nil {
		return nil, err
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, fmt.Errorf("工作表不存在: %w", err)
	}

	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return nil, fmt.Errorf("工作簿不存在: %w", err)
	}
	canManage, err := s.permService.CanManageWorkbook(workbook, userID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, fmt.Errorf("没有权限修改该工作表")
	}

	sheet.Name = name
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, fmt.Errorf("重命名工作表失败: %w", err)
	}

	return &toolExecutionResult{
		Data:    map[string]any{"ok": true, "sheet_id": sheet.ID, "name": sheet.Name},
		Summary: fmt.Sprintf("已重命名工作表为「%s」(ID:%d)", sheet.Name, sheet.ID),
	}, nil
}

func (s *AIService) toolSetCellFormat(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	format, err := stringArg(args, "format")
	if err != nil {
		return nil, err
	}

	validFormats := map[string]bool{
		"text": true, "number": true, "currency": true,
		"date": true, "percentage": true, "formula": true,
		"select": true, "image": true,
	}
	if !validFormats[format] {
		return nil, fmt.Errorf("不支持的格式类型: %s（支持 text/number/currency/date/percentage/formula/select/image）", format)
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, fmt.Errorf("工作表不存在: %w", err)
	}

	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return nil, fmt.Errorf("工作簿不存在: %w", err)
	}
	canManage, err := s.permService.CanManageWorkbook(workbook, userID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, fmt.Errorf("没有权限修改该工作表")
	}

	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}

	found := false
	for i, col := range columns {
		if col.Key == columnKey {
			columns[i].Type = format
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("列 %s 不存在", columnKey)
	}

	nextColumns, err := json.Marshal(columns)
	if err != nil {
		return nil, fmt.Errorf("序列化列定义失败: %w", err)
	}
	sheet.Columns = nextColumns
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, fmt.Errorf("更新列格式失败: %w", err)
	}

	if err := s.invalidateSheetByID(sheetID); err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data:            map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey, "format": format},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已将列 %s 的格式设为 %s", columnKey, format),
	}, nil
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
			return value
		}
		if rowBase > 0 && value >= 0 {
			return value + rowBase
		}
		return value
	}

	switch operation.Kind {
	case "insert_row":
		if operation.Row < 0 {
			operation.Row = 0
		}
		if operation.Row > rowCount {
			operation.Row = rowCount
		}
		operation.Row = adjust(operation.Row)
	case "update_cell", "delete_row":
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

type snapshotRow struct {
	RowIndex int
	Data     map[string]any
}

// extractRowsFromSnapshot reads row data from univerSheetData.cellData in the
// sheet config. This is needed because when users edit via the Univer.js UI,
// data is saved into the config snapshot rather than the rows table.
// Row 0 is the header row and is skipped. Column numeric indexes are mapped
// to column keys using the provided columns definition.
func extractRowsFromSnapshot(config json.RawMessage, columns []sheetColumnPayload) []snapshotRow {
	if len(config) == 0 || len(columns) == 0 {
		return nil
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil
	}

	rawSheet, ok := payload["univerSheetData"]
	if !ok {
		return nil
	}
	sheetData, ok := rawSheet.(map[string]interface{})
	if !ok {
		return nil
	}
	rawCellData, ok := sheetData["cellData"].(map[string]interface{})
	if !ok {
		return nil
	}

	// Build column index -> key mapping
	colIndexToKey := make(map[int]string, len(columns))
	for i, col := range columns {
		colIndexToKey[i] = col.Key
	}

	var rows []snapshotRow
	for rowKeyStr, rowValue := range rawCellData {
		rowIdx, err := strconv.Atoi(rowKeyStr)
		if err != nil || rowIdx == 0 {
			// skip header row (0) and non-numeric keys
			continue
		}
		rowMap, ok := rowValue.(map[string]interface{})
		if !ok {
			continue
		}
		data := make(map[string]any, len(rowMap))
		for colKeyStr, cellValue := range rowMap {
			colIdx, err := strconv.Atoi(colKeyStr)
			if err != nil {
				continue
			}
			colKey, ok := colIndexToKey[colIdx]
			if !ok {
				continue
			}
			// Extract the actual value from the cell object {v: ..., f: ...}
			cellMap, ok := cellValue.(map[string]interface{})
			if !ok {
				continue
			}
			if v, exists := cellMap["v"]; exists {
				data[colKey] = v
			}
		}
		if len(data) > 0 {
			rows = append(rows, snapshotRow{RowIndex: rowIdx, Data: data})
		}
	}

	// Sort by row index for consistent ordering
	sort.Slice(rows, func(i, j int) bool {
		return rows[i].RowIndex < rows[j].RowIndex
	})

	return rows
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

func (s *AIService) buildVisiblePreviewRows(userID int64, sheet *model.Sheet, columns []sheetColumnPayload, rows []model.Row) ([]aiPreviewRow, error) {
	previewRows := buildAIPreviewRows(sheet, columns, rows)
	result := make([]aiPreviewRow, 0, len(previewRows))
	for _, row := range previewRows {
		filtered := make(map[string]interface{}, len(row.Data))
		for key, value := range row.Data {
			allowed, err := s.permService.CheckCellPermission(sheet.ID, userID, key, row.SourceRow, "read")
			if err != nil {
				return nil, err
			}
			if allowed {
				filtered[key] = value
			}
		}
		row.Data = filtered
		result = append(result, row)
	}
	return result, nil
}

func normalizeSearchKeywords(items []string) []string {
	result := make([]string, 0, len(items))
	seen := make(map[string]struct{}, len(items))
	for _, item := range items {
		trimmed := strings.TrimSpace(item)
		if trimmed == "" {
			continue
		}
		key := strings.ToLower(trimmed)
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func normalizeSearchMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "all":
		return "all"
	default:
		return "any"
	}
}

func normalizeLookupMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "exact":
		return "exact"
	default:
		return "contains"
	}
}

func collectRowKeywordMatches(data map[string]interface{}, columns []sheetColumnPayload, keywords []string, mode string) []map[string]any {
	if len(keywords) == 0 || len(data) == 0 {
		return nil
	}
	columnMeta := make(map[string]sheetColumnPayload, len(columns))
	for _, column := range columns {
		columnMeta[column.Key] = column
	}
	matches := make([]map[string]any, 0)
	matchedKeywords := make(map[string]struct{}, len(keywords))
	for key, value := range data {
		text := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", value)))
		if text == "" {
			continue
		}
		column := columnMeta[key]
		for _, keyword := range keywords {
			needle := strings.ToLower(strings.TrimSpace(keyword))
			if needle == "" || !strings.Contains(text, needle) {
				continue
			}
			matchedKeywords[needle] = struct{}{}
			matches = append(matches, map[string]any{
				"keyword":     keyword,
				"column_key":  key,
				"column_name": firstNonEmpty(column.Name, key),
				"value":       value,
			})
		}
	}
	if normalizeSearchMode(mode) == "all" {
		for _, keyword := range keywords {
			if _, ok := matchedKeywords[strings.ToLower(strings.TrimSpace(keyword))]; !ok {
				return nil
			}
		}
	}
	if len(matches) == 0 {
		return nil
	}
	return matches
}

func collectCriteriaMatches(data map[string]interface{}, columns []sheetColumnPayload, criteria map[string]any, matchMode string) []map[string]any {
	if len(criteria) == 0 || len(data) == 0 {
		return nil
	}
	mode := normalizeLookupMode(matchMode)
	matches := make([]map[string]any, 0, len(criteria))
	for rawKey, expected := range criteria {
		columnKey, columnName := resolveColumnReference(rawKey, columns)
		if columnKey == "" {
			return nil
		}
		actual, ok := data[columnKey]
		if !ok {
			return nil
		}
		actualText := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", actual)))
		expectedText := strings.ToLower(strings.TrimSpace(fmt.Sprintf("%v", expected)))
		if actualText == "" || expectedText == "" {
			return nil
		}
		matched := actualText == expectedText
		if mode == "contains" {
			matched = strings.Contains(actualText, expectedText)
		}
		if !matched {
			return nil
		}
		matches = append(matches, map[string]any{
			"column_key":  columnKey,
			"column_name": firstNonEmpty(columnName, columnKey),
			"expected":    expected,
			"value":       actual,
		})
	}
	return matches
}

func resolveColumnReference(reference string, columns []sheetColumnPayload) (string, string) {
	normalized := strings.ToLower(strings.TrimSpace(reference))
	for _, column := range columns {
		if strings.ToLower(strings.TrimSpace(column.Key)) == normalized || strings.ToLower(strings.TrimSpace(column.Name)) == normalized {
			return column.Key, column.Name
		}
	}
	return "", ""
}

func filterRowDataByColumns(data map[string]interface{}, columns []sheetColumnPayload, requested []string) map[string]any {
	if len(requested) == 0 {
		result := make(map[string]any, len(data))
		for key, value := range data {
			result[key] = value
		}
		return result
	}
	result := make(map[string]any, len(requested))
	for _, item := range requested {
		columnKey, _ := resolveColumnReference(item, columns)
		if columnKey == "" {
			columnKey = strings.TrimSpace(item)
		}
		if value, ok := data[columnKey]; ok {
			result[columnKey] = value
		}
	}
	return result
}

func toFloat64(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case int32:
		return float64(v), true
	case json.Number:
		parsed, err := v.Float64()
		return parsed, err == nil
	case string:
		replacer := strings.NewReplacer(",", "", " ", "", "?", "", "?", "", "$", "")
		parsed, err := strconv.ParseFloat(replacer.Replace(strings.TrimSpace(v)), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func sumFloat64(values []float64) float64 {
	total := 0.0
	for _, value := range values {
		total += value
	}
	return total
}

func minFloat64(values []float64) any {
	if len(values) == 0 {
		return nil
	}
	minimum := values[0]
	for _, value := range values[1:] {
		if value < minimum {
			minimum = value
		}
	}
	return minimum
}

func maxFloat64(values []float64) any {
	if len(values) == 0 {
		return nil
	}
	maximum := values[0]
	for _, value := range values[1:] {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

func evaluateMathExpression(expression string) (float64, error) {
	parsed, err := parser.ParseExpr(strings.TrimSpace(expression))
	if err != nil {
		return 0, fmt.Errorf("invalid expression: %w", err)
	}
	return evalMathAST(parsed)
}

func evalMathAST(expr ast.Expr) (float64, error) {
	switch node := expr.(type) {
	case *ast.BasicLit:
		if node.Kind != token.INT && node.Kind != token.FLOAT {
			return 0, fmt.Errorf("unsupported literal")
		}
		return strconv.ParseFloat(node.Value, 64)
	case *ast.BinaryExpr:
		left, err := evalMathAST(node.X)
		if err != nil {
			return 0, err
		}
		right, err := evalMathAST(node.Y)
		if err != nil {
			return 0, err
		}
		switch node.Op {
		case token.ADD:
			return left + right, nil
		case token.SUB:
			return left - right, nil
		case token.MUL:
			return left * right, nil
		case token.QUO:
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			return left / right, nil
		case token.REM:
			if right == 0 {
				return 0, fmt.Errorf("division by zero")
			}
			return math.Mod(left, right), nil
		default:
			return 0, fmt.Errorf("unsupported operator")
		}
	case *ast.UnaryExpr:
		value, err := evalMathAST(node.X)
		if err != nil {
			return 0, err
		}
		switch node.Op {
		case token.ADD:
			return value, nil
		case token.SUB:
			return -value, nil
		default:
			return 0, fmt.Errorf("unsupported unary operator")
		}
	case *ast.ParenExpr:
		return evalMathAST(node.X)
	default:
		return 0, fmt.Errorf("unsupported expression")
	}
}

func formatComputedNumber(value float64, scale int) string {
	if math.Abs(value-math.Round(value)) < 1e-9 {
		return strconv.FormatInt(int64(math.Round(value)), 10)
	}
	formatted := strconv.FormatFloat(value, 'f', scale, 64)
	formatted = strings.TrimRight(formatted, "0")
	formatted = strings.TrimRight(formatted, ".")
	return formatted
}

func toInt64(value any) (int64, bool) {
	switch v := value.(type) {
	case int64:
		return v, true
	case int:
		return int64(v), true
	case float64:
		return int64(v), true
	case float32:
		return int64(v), true
	case json.Number:
		parsed, err := v.Int64()
		return parsed, err == nil
	default:
		return 0, false
	}
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
