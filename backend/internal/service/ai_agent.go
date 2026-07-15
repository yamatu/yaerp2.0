package service

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"math"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"

	"github.com/xuri/excelize/v2"
)

type ToolFunc func(userID int64, args map[string]any) (*toolExecutionResult, error)

type toolExecutionResult struct {
	Data              any
	TouchedSheetIDs   []int64
	ChangedSheetIDs   []int64
	ResourcesChanged  bool
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

var formulaArithmeticReferencePattern = regexp.MustCompile(`(?i)([A-Z]{1,3})(?:\{\{row\}\}|[0-9]+)\s*([*/+\-])\s*([A-Z]{1,3})(?:\{\{row\}\}|[0-9]+)`)
var formulaKeyArithmeticPattern = regexp.MustCompile(`\{\{([a-zA-Z0-9_]+)\}\}\s*([*/+\-])\s*\{\{([a-zA-Z0-9_]+)\}\}`)

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
		"format_cell_range":        s.toolFormatCellRange,
		"create_financial_report":  s.toolCreateFinancialReport,
		"list_summary_pages":       s.toolListSummaryPages,
		"create_summary_page":      s.toolCreateSummaryPage,
		"update_summary_page":      s.toolUpdateSummaryPage,
	}
}

func (s *AIService) chatWithTools(userID, assistantID int64, messages []ChatMessage, chatContext *ChatContext) (*ChatResponse, error) {
	assistant, err := s.resolveAIAssistant(assistantID)
	if err != nil {
		return nil, err
	}

	conversation := s.buildAgentMessages(userID, assistant, messages)
	if chatContext != nil && chatContext.WorkbookID != nil && *chatContext.WorkbookID > 0 {
		workbook, err := s.sheetService.GetWorkbook(*chatContext.WorkbookID, userID)
		if err != nil {
			return nil, fmt.Errorf("选中的工作簿不可访问: %w", err)
		}
		sheetIDs := uniquePositiveInt64s(chatContext.SheetIDs, 48)
		if len(sheetIDs) == 0 {
			for _, sheet := range workbook.Sheets {
				sheetIDs = append(sheetIDs, sheet.ID)
			}
		}
		if len(sheetIDs) == 0 {
			return nil, fmt.Errorf("选中的工作簿没有可读取的工作表")
		}
		payload, _, err := s.buildSpreadsheetContext(userID, workbook.ID, sheetIDs)
		if err != nil {
			return nil, fmt.Errorf("读取选中的表格上下文失败: %w", err)
		}
		contextMessage := map[string]any{
			"role": "system",
			"content": fmt.Sprintf(
				"用户已在界面中明确选择工作簿「%s」作为本轮上下文。优先依据以下真实数据回答；需要查看更多或执行操作时仍必须调用工具并遵守当前账号权限。\n\n%s",
				workbook.Name,
				payload,
			),
		}
		conversation = append(append([]map[string]any{}, conversation[:1]...), append([]map[string]any{contextMessage}, conversation[1:]...)...)
	}
	if chatContext != nil && len(chatContext.AttachmentIDs) > 0 {
		conversation, err = s.addAttachmentContext(userID, assistant, conversation, chatContext.AttachmentIDs)
		if err != nil {
			return nil, err
		}
	}
	toolDefs := s.buildToolDefinitions()
	touchedSheets := make(map[int64]struct{})
	changedSheets := make(map[int64]struct{})
	resourcesChanged := false
	lastModel := assistant.Model
	toolTraces := make([]ChatToolTrace, 0)
	var pendingOperations []SpreadsheetOperation

	for round := 0; round < 8; round++ {
		resp, assistantMessage, err := s.callChatCompletionWithTools(assistant.Endpoint, assistant.APIKey, assistant.Model, conversation, toolDefs)
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
				AssistantID:       assistant.ID,
				AssistantName:     assistant.Name,
				Reply:             reply,
				Model:             lastModel,
				TouchedSheetIDs:   sortedTouchedSheetIDs(touchedSheets),
				ChangedSheetIDs:   sortedTouchedSheetIDs(changedSheets),
				ResourcesChanged:  resourcesChanged,
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
			args["_assistant_id"] = assistant.ID

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
			for _, sheetID := range result.ChangedSheetIDs {
				changedSheets[sheetID] = struct{}{}
			}
			resourcesChanged = resourcesChanged || result.ResourcesChanged
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
		AssistantID:       assistant.ID,
		AssistantName:     assistant.Name,
		Reply:             "已完成处理。",
		Model:             lastModel,
		TouchedSheetIDs:   sortedTouchedSheetIDs(touchedSheets),
		ChangedSheetIDs:   sortedTouchedSheetIDs(changedSheets),
		ResourcesChanged:  resourcesChanged,
		PendingOperations: pendingOperations,
		ToolTraces:        toolTraces,
	}, nil
}

func (s *AIService) addAttachmentContext(userID int64, assistant *activeAIAssistant, conversation []map[string]any, attachmentIDs []int64) ([]map[string]any, error) {
	attachmentIDs = uniquePositiveInt64s(attachmentIDs, 4)
	fileContexts := make([]string, 0, len(attachmentIDs))
	imageParts := make([]map[string]any, 0, len(attachmentIDs))

	for _, attachmentID := range attachmentIDs {
		attachment, reader, err := s.uploadService.OpenStoredFile(attachmentID)
		if err != nil {
			return nil, err
		}
		allowed := attachment.UploaderID == userID
		if !allowed {
			if admin, adminErr := s.permService.IsAdmin(userID); adminErr == nil && admin {
				allowed = true
			}
		}
		if !allowed {
			if galleryAllowed, galleryErr := s.uploadService.CanAccessGalleryImage(userID, attachmentID); galleryErr == nil && galleryAllowed {
				allowed = true
			}
		}
		if !allowed {
			_ = reader.Close()
			return nil, fmt.Errorf("无权读取附件 %s", attachment.Filename)
		}

		if strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
			if !assistant.SupportsVision {
				_ = reader.Close()
				return nil, fmt.Errorf("当前 AI 助手未启用图片理解能力")
			}
			data, readErr := io.ReadAll(io.LimitReader(reader, 8*1024*1024+1))
			_ = reader.Close()
			if readErr != nil {
				return nil, fmt.Errorf("读取图片失败: %w", readErr)
			}
			if len(data) > 8*1024*1024 {
				return nil, fmt.Errorf("图片 %s 超过 8MB，无法发送给 AI", attachment.Filename)
			}
			imageParts = append(imageParts, map[string]any{
				"type":      "image_url",
				"image_url": map[string]any{"url": fmt.Sprintf("data:%s;base64,%s", attachment.MimeType, base64.StdEncoding.EncodeToString(data))},
			})
			continue
		}

		if !assistant.SupportsFiles {
			_ = reader.Close()
			return nil, fmt.Errorf("当前 AI 助手未启用文件读取能力")
		}
		content, readErr := readAIAttachmentText(attachment.Filename, attachment.MimeType, reader)
		_ = reader.Close()
		if readErr != nil {
			return nil, readErr
		}
		fileContexts = append(fileContexts, fmt.Sprintf("文件：%s\n%s", attachment.Filename, content))
	}

	if len(fileContexts) > 0 {
		conversation = append(conversation[:1], append([]map[string]any{{
			"role":    "system",
			"content": "用户已明确附加以下文件。仅依据文件中的真实内容回答，并继续遵守当前账号权限。\n\n" + strings.Join(fileContexts, "\n\n---\n\n"),
		}}, conversation[1:]...)...)
	}
	if len(imageParts) > 0 {
		for index := len(conversation) - 1; index >= 0; index-- {
			if conversation[index]["role"] != "user" {
				continue
			}
			textContent, _ := conversation[index]["content"].(string)
			parts := []map[string]any{{"type": "text", "text": textContent}}
			parts = append(parts, imageParts...)
			conversation[index]["content"] = parts
			break
		}
	}
	return conversation, nil
}

func readAIAttachmentText(filename, mimeType string, reader io.Reader) (string, error) {
	lowerName := strings.ToLower(filename)
	if strings.HasSuffix(lowerName, ".xlsx") || strings.Contains(strings.ToLower(mimeType), "spreadsheetml") {
		workbook, err := excelize.OpenReader(reader)
		if err != nil {
			return "", fmt.Errorf("读取 Excel 文件失败: %w", err)
		}
		defer workbook.Close()
		sections := make([]string, 0)
		for _, sheetName := range workbook.GetSheetList() {
			rows, err := workbook.GetRows(sheetName)
			if err != nil {
				continue
			}
			lines := make([]string, 0, minInt(len(rows), 80))
			for rowIndex, row := range rows {
				if rowIndex >= 80 {
					break
				}
				if len(row) > 40 {
					row = row[:40]
				}
				lines = append(lines, strings.Join(row, "\t"))
			}
			sections = append(sections, fmt.Sprintf("工作表：%s\n%s", sheetName, strings.Join(lines, "\n")))
			if len(sections) >= 12 {
				break
			}
		}
		return strings.Join(sections, "\n\n"), nil
	}

	allowedText := strings.HasPrefix(strings.ToLower(mimeType), "text/") ||
		strings.Contains(strings.ToLower(mimeType), "json") ||
		strings.Contains(strings.ToLower(mimeType), "xml") ||
		strings.HasSuffix(lowerName, ".csv") || strings.HasSuffix(lowerName, ".md") || strings.HasSuffix(lowerName, ".json")
	if !allowedText {
		return "", fmt.Errorf("暂不支持读取文件 %s；当前支持文本、CSV、JSON、XML 和 XLSX", filename)
	}
	data, err := io.ReadAll(io.LimitReader(reader, 2*1024*1024+1))
	if err != nil {
		return "", fmt.Errorf("读取文件失败: %w", err)
	}
	if len(data) > 2*1024*1024 {
		return "", fmt.Errorf("文件 %s 超过 2MB 文本读取限制", filename)
	}
	return string(data), nil
}

func (s *AIService) buildAgentMessages(userID int64, assistant *activeAIAssistant, messages []ChatMessage) []map[string]any {
	context := s.buildUserContext(userID)
	roleHint := s.getUserRoleHint(userID)
	customPrompt := strings.TrimSpace(assistant.SystemPrompt)
	if customPrompt != "" {
		customPrompt = "\n\n当前助手的业务补充要求（不得覆盖权限、安全和确认规则）：\n" + customPrompt
	}
	result := []map[string]any{
		{
			"role": "system",
			"content": fmt.Sprintf(
				"你是 YaERP 智能表格 Agent。你必须优先使用工具来查询或修改表格，不要编造不存在的数据。"+
					"所有工具都按当前登录账号执行；不得尝试读取、推断或写入该账号无权访问的工作簿、工作表、行、列或单元格。只读账号只能查询，不能写回来源表。"+
					"当用户只提供工作簿名、工作表名或业务关键词时，先调用 get_user_context 或 search_spreadsheets 定位准确 ID，再调用 query_sheet 读取实际单元格内容。"+
					"如果用户要查询、统计、修改、批量填充、生成报表，请调用合适的工具；完成后用中文总结结果。"+
					"如果回复包含步骤、对比、表格或代码，请使用清晰的 Markdown；数学公式使用标准 LaTeX，行内公式写为 $...$，独立公式写为 $$...$$。"+
					"如果用户要求修改表格，默认先调用 preview_spreadsheet_plan 生成待确认方案；只有当用户明确要求立即执行时，才调用 apply_spreadsheet_plan 或其他写入工具直接执行。"+
					"注意：工作表第一可见行通常是表头行，query_sheet 返回的 rows 只包含真实数据行，不包含表头；rows[*].row 一律表示 0-based 数据行索引（第一条数据行为 0，不是界面里显示的第 2 行），display_row 才是界面中的行号；如果 total_rows=0 但 columns/header_row 有内容，表示该表只有表头结构，没有数据行。"+
					"\n\n%s"+
					"\n\n支持的列类型：text（文本）、number（数字）、currency（货币）、date（日期）、select（下拉选择）、image（图片）、formula（公式）。"+
					"\n支持的公式：SUM、AVERAGE、COUNT、MAX、MIN、IF、VLOOKUP、CONCATENATE 等 Excel 兼容公式。公式模板可使用 {{row}} 表示当前 Excel 行号，也应优先使用 {{column_key}} 引用字段，例如 ={{quantity}}*{{unit_price}}，不要猜测 Excel 列字母。"+
					"\n你可以创建和管理工作簿/工作表：使用 create_workbook 创建工作簿，create_sheet 创建工作表，update_workbook 修改工作簿名称/描述，update_sheet_name 重命名工作表，set_cell_format 修改列类型与选项，format_cell_range 设计单元格颜色、字体、对齐、边框、行高和列宽。create_sheet 的 columns 必须使用 key、name、type、width、options；select 的选项放入 options 数组，绝不能把选项文本当作 format。"+
					"\n当用户明确要求美化、排版、设置表头颜色或区分数据区域时，可以直接调用 format_cell_range；必须使用用户有写权限且未被他人保护的范围。颜色优先使用 #RRGGBB。"+
					"\n用户明确要求财务分析工作簿时，使用 create_financial_report；需要跨工作簿网页总结时，使用 create_summary_page；需要编辑既有总结时，先 list_summary_pages 再 update_summary_page。"+
					"%s\n\n当前用户可访问的数据摘要如下：\n\n%s",
				roleHint,
				customPrompt,
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
			"type": "object",
			"properties": map[string]any{
				"limit": map[string]any{"type": "integer"},
			},
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
		buildToolDefinition("run_workflow", "Execute multiple spreadsheet operations after validating every operation. Supported kinds: update_cell, insert_row, delete_row, insert_column, fill_formula.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"operations": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"kind":                    map[string]any{"type": "string", "enum": []string{"update_cell", "insert_row", "delete_row", "insert_column", "fill_formula"}},
							"sheet_id":                map[string]any{"type": "integer"},
							"row":                     map[string]any{"type": "integer"},
							"column_key":              map[string]any{"type": "string"},
							"column_name":             map[string]any{"type": "string"},
							"value":                   map[string]any{},
							"row_values":              map[string]any{"type": "object"},
							"column_type":             map[string]any{"type": "string"},
							"insert_after_column_key": map[string]any{"type": "string"},
							"start_row":               map[string]any{"type": "integer"},
							"end_row":                 map[string]any{"type": "integer"},
							"formula_template":        map[string]any{"type": "string"},
						},
						"required": []string{"kind", "sheet_id"},
					},
				},
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
		buildToolDefinition("create_sheet", "Create a sheet in a workbook. Each column requires a unique key and display name. Use type=select with options for dropdown fields.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"workbook_id": map[string]any{"type": "integer"},
				"name":        map[string]any{"type": "string"},
				"columns": map[string]any{
					"type": "array",
					"items": map[string]any{
						"type": "object",
						"properties": map[string]any{
							"key":          map[string]any{"type": "string"},
							"name":         map[string]any{"type": "string"},
							"type":         map[string]any{"type": "string", "enum": []string{"text", "number", "currency", "date", "select", "image", "formula", "percentage"}},
							"width":        map[string]any{"type": "number"},
							"required":     map[string]any{"type": "boolean"},
							"options":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
							"currencyCode": map[string]any{"type": "string"},
						},
						"required": []string{"key", "name", "type"},
					},
				},
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
		buildToolDefinition("set_cell_format", "Set one column type and optional dropdown/currency metadata. For dropdowns use format=select and put choices in options.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":     map[string]any{"type": "integer"},
				"column_key":   map[string]any{"type": "string"},
				"format":       map[string]any{"type": "string", "enum": []string{"text", "number", "currency", "date", "percentage", "formula", "select", "image"}},
				"options":      map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"currencyCode": map[string]any{"type": "string"},
			},
			"required": []string{"sheet_id", "column_key", "format"},
		}),
		buildToolDefinition("format_cell_range", "Design spreadsheet cell presentation. Rows are 0-based data rows; the header is controlled by scope=header/all. Use this for colors, typography, alignment, wrapping, borders, row height and column width.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"sheet_id":             map[string]any{"type": "integer"},
				"scope":                map[string]any{"type": "string", "enum": []string{"header", "data", "all"}},
				"start_row":            map[string]any{"type": "integer", "description": "0-based first data row"},
				"end_row":              map[string]any{"type": "integer", "description": "0-based last data row"},
				"column_keys":          map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"background_color":     map[string]any{"type": "string", "description": "Hex color such as #E0F2FE"},
				"text_color":           map[string]any{"type": "string", "description": "Hex color such as #0F172A"},
				"bold":                 map[string]any{"type": "boolean"},
				"italic":               map[string]any{"type": "boolean"},
				"font_size":            map[string]any{"type": "number"},
				"horizontal_alignment": map[string]any{"type": "string", "enum": []string{"left", "center", "right"}},
				"vertical_alignment":   map[string]any{"type": "string", "enum": []string{"top", "middle", "bottom"}},
				"wrap":                 map[string]any{"type": "boolean"},
				"border_color":         map[string]any{"type": "string"},
				"border_style":         map[string]any{"type": "string", "enum": []string{"thin", "dotted", "dashed", "double", "thick"}},
				"column_width":         map[string]any{"type": "number"},
				"row_height":           map[string]any{"type": "number"},
				"clear_format":         map[string]any{"type": "boolean"},
			},
			"required": []string{"sheet_id"},
		}),
		buildToolDefinition("create_financial_report", "Create a new financial analysis workbook from accessible source sheets. Source sheets are read only; the report is created as a new workbook owned by the current user.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":             map[string]any{"type": "string"},
				"source_sheet_ids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
			},
			"required": []string{"source_sheet_ids"},
		}),
		buildToolDefinition("list_summary_pages", "List AI web summary pages accessible to the current user.", map[string]any{
			"type":       "object",
			"properties": map[string]any{},
		}),
		buildToolDefinition("create_summary_page", "Create an AI web summary page from one or more accessible workbooks.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"title":        map[string]any{"type": "string"},
				"workbook_ids": map[string]any{"type": "array", "items": map[string]any{"type": "integer"}},
				"prompt":       map[string]any{"type": "string"},
			},
			"required": []string{"title", "workbook_ids"},
		}),
		buildToolDefinition("update_summary_page", "Edit an existing AI web summary page owned by the current user.", map[string]any{
			"type": "object",
			"properties": map[string]any{
				"summary_id": map[string]any{"type": "integer"},
				"title":      map[string]any{"type": "string"},
				"headline":   map[string]any{"type": "string"},
				"overview":   map[string]any{"type": "string"},
				"metrics":    map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
				"sections":   map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
			},
			"required": []string{"summary_id"},
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
	if strings.TrimSpace(apiKey) != "" {
		request.Header.Set("Authorization", "Bearer "+apiKey)
	}

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

func (s *AIService) toolGetUserContext(userID int64, args map[string]any) (*toolExecutionResult, error) {
	limit, _ := intArgWithDefault(args, "limit", 50)
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	context, err := s.buildUserContextSnapshot(userID, limit)
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

	rawPreviewRows := buildAIPreviewRows(sheet, columns, rows)
	visiblePreviewRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	filteredRows := make([]map[string]any, 0, limit)
	visibleRowCount := 0
	for _, row := range visiblePreviewRows {
		if len(row.Data) == 0 {
			continue
		}
		visibleRowCount++
		if row.Row < startRow {
			continue
		}
		data := row.Data
		if len(columnFilter) > 0 {
			nextData := make(map[string]any, len(columnFilter))
			for key := range columnFilter {
				if value, ok := data[key]; ok {
					nextData[key] = value
				}
			}
			data = nextData
		}
		if len(data) == 0 {
			continue
		}
		filteredRows = append(filteredRows, map[string]any{
			"row":         row.Row,
			"source_row":  row.SourceRow,
			"display_row": row.DisplayRow,
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
		"total_rows":  visibleRowCount,
		"header_only": len(rawPreviewRows) == 0 && len(columns) > 0,
		"data_source": map[bool]string{true: "snapshot", false: "rows"}[len(extractRowsFromSnapshot(sheet.Config, columns)) > 0],
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

	snapshot, err := s.buildUserContextSnapshot(userID, 1000)
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
			if spreadsheetNameMatches(workbookName, sheetName, keywords, mode) {
				matches = append(matches, map[string]any{
					"workbook_id":   workbookID,
					"workbook_name": workbookName,
					"sheet_id":      sheetID,
					"sheet_name":    sheetName,
					"match_scope":   "workbook_or_sheet_name",
					"columns":       columns,
				})
				touched[sheetID] = struct{}{}
				if len(matches) >= limit {
					return buildSpreadsheetSearchResult(keywords, mode, limit, matches, touched), nil
				}
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
					return buildSpreadsheetSearchResult(keywords, mode, limit, matches, touched), nil
				}
			}
		}
	}

	return buildSpreadsheetSearchResult(keywords, mode, limit, matches, touched), nil
}

func buildSpreadsheetSearchResult(keywords []string, mode string, limit int, matches []map[string]any, touched map[int64]struct{}) *toolExecutionResult {
	return &toolExecutionResult{
		Data: map[string]any{
			"keywords": keywords,
			"mode":     normalizeSearchMode(mode),
			"limit":    limit,
			"matches":  matches,
		},
		TouchedSheetIDs: sortedTouchedSheetIDs(touched),
		Summary:         fmt.Sprintf("已在 %d 个位置找到关键字", len(matches)),
	}
}

func spreadsheetNameMatches(workbookName, sheetName string, keywords []string, mode string) bool {
	target := strings.ToLower(workbookName + " " + sheetName)
	matched := 0
	for _, keyword := range keywords {
		if strings.Contains(target, strings.ToLower(keyword)) {
			matched++
		}
	}
	if normalizeSearchMode(mode) == "all" {
		return matched == len(keywords)
	}
	return matched > 0
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
		ChangedSheetIDs: []int64{sheetID},
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
	targetPermissionRow := row
	if !isEmptySheet && row > 0 {
		targetPermissionRow = row - 1
	}
	if err := s.validateRowWriteAccess(userID, sheetID, targetPermissionRow); err != nil {
		return nil, err
	}
	for key := range rowValues {
		if err := s.validateCellWriteAccess(userID, sheetID, row, key); err != nil {
			return nil, err
		}
	}

	if !isEmptySheet {
		afterRow := row - 1
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
		ChangedSheetIDs: []int64{sheetID},
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

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "row": row}, TouchedSheetIDs: []int64{sheetID}, ChangedSheetIDs: []int64{sheetID}, Summary: fmt.Sprintf("已删除第 %d 行", row+1)}, nil
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

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey}, TouchedSheetIDs: touched, ChangedSheetIDs: touched, Summary: fmt.Sprintf("已新增列 %s", columnKey)}, nil
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

	return &toolExecutionResult{Data: map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey}, TouchedSheetIDs: touched, ChangedSheetIDs: touched, Summary: fmt.Sprintf("已批量填充列 %s", columnKey)}, nil
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
	return &toolExecutionResult{Data: map[string]any{"ok": true, "applied": len(operations)}, TouchedSheetIDs: touched, ChangedSheetIDs: touched, Summary: fmt.Sprintf("已执行 %d 条工作流操作", len(operations))}, nil
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

	assistantID, _ := int64Arg(args, "_assistant_id")
	result, err := s.PreviewSpreadsheetPlan(userID, assistantID, &SpreadsheetPlanRequest{WorkbookID: workbookID, SheetIDs: sheetIDs, Prompt: prompt})
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
	return &toolExecutionResult{Data: map[string]any{"ok": true, "applied": len(operations)}, TouchedSheetIDs: touched, ChangedSheetIDs: touched, Summary: fmt.Sprintf("已写入 %d 条表格修改", len(operations))}, nil
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
		Data:             map[string]any{"ok": true, "workbook_id": workbook.ID, "name": workbook.Name},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已创建工作簿「%s」(ID:%d)", workbook.Name, workbook.ID),
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
		columns, err := normalizeAgentSheetColumns(columnsRaw)
		if err != nil {
			return nil, err
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
			"columns":     json.RawMessage(sheet.Columns),
			"hint":        fmt.Sprintf("Use sheet_id=%d (NOT workbook_id=%d) for insert_row, update_cell, query_sheet, etc.", sheet.ID, workbookID),
		},
		TouchedSheetIDs:  []int64{sheet.ID},
		ChangedSheetIDs:  []int64{sheet.ID},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已在工作簿(ID:%d)中创建工作表「%s」(ID:%d)", workbookID, sheet.Name, sheet.ID),
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
		Data:             map[string]any{"ok": true, "workbook_id": workbook.ID, "name": workbook.Name},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已更新工作簿「%s」(ID:%d)", workbook.Name, workbook.ID),
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
		Data:             map[string]any{"ok": true, "sheet_id": sheet.ID, "name": sheet.Name},
		TouchedSheetIDs:  []int64{sheet.ID},
		ChangedSheetIDs:  []int64{sheet.ID},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已重命名工作表为「%s」(ID:%d)", sheet.Name, sheet.ID),
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
	rawFormat := firstStringValue(args, "format", "type", "column_type", "columnType")
	options := stringSliceArg(args, "options")
	if len(options) == 0 {
		options = splitColumnOptions(args["options"])
	}
	format := normalizeColumnType(rawFormat)
	if !isSupportedColumnType(format) {
		if inferred := splitColumnOptions(rawFormat); len(inferred) > 1 {
			format = "select"
			if len(options) == 0 {
				options = inferred
			}
		}
	}
	if format == "" && len(options) > 0 {
		format = "select"
	}
	currencyCode, _ := stringArgWithDefault(args, "currencyCode", "")
	if currencyCode == "" {
		currencyCode, _ = stringArgWithDefault(args, "currency_code", "")
	}

	validFormats := map[string]bool{
		"text": true, "number": true, "currency": true,
		"date": true, "percentage": true, "formula": true,
		"select": true, "image": true,
	}
	if !validFormats[format] {
		return nil, fmt.Errorf("不支持的格式类型: %s（支持 text/number/currency/date/percentage/formula/select/image）", format)
	}
	if format == "select" && len(options) == 0 {
		return nil, fmt.Errorf("select 类型必须提供非空 options 数组")
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
		if strings.EqualFold(strings.TrimSpace(col.Key), strings.TrimSpace(columnKey)) || strings.EqualFold(strings.TrimSpace(col.Name), strings.TrimSpace(columnKey)) {
			columns[i].Type = format
			if format == "select" {
				columns[i].Options = options
			} else {
				columns[i].Options = nil
			}
			if format == "currency" && strings.TrimSpace(currencyCode) != "" {
				columns[i].CurrencyCode = strings.ToUpper(strings.TrimSpace(currencyCode))
			}
			columnKey = columns[i].Key
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
		Data:            map[string]any{"ok": true, "sheet_id": sheetID, "column_key": columnKey, "format": format, "options": options},
		TouchedSheetIDs: []int64{sheetID},
		ChangedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已将列 %s 的格式设为 %s", columnKey, format),
	}, nil
}

func (s *AIService) toolFormatCellRange(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	scope := strings.ToLower(strings.TrimSpace(firstStringValue(args, "scope")))
	if scope == "" {
		scope = "data"
	}
	if scope != "header" && scope != "data" && scope != "all" {
		return nil, fmt.Errorf("scope 必须是 header、data 或 all")
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, fmt.Errorf("工作表不存在: %w", err)
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("工作表没有可格式化的列")
	}

	columnIndexes, columnKeys, err := resolveFormatColumnIndexes(columns, stringSliceArg(args, "column_keys"))
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	maxDataRow := -1
	for _, row := range rows {
		if row.RowIndex > maxDataRow {
			maxDataRow = row.RowIndex
		}
	}
	startRow, err := intArgWithDefault(args, "start_row", 0)
	if err != nil {
		return nil, err
	}
	endRow, err := intArgWithDefault(args, "end_row", maxDataRow)
	if err != nil {
		return nil, err
	}
	if startRow < 0 || endRow < startRow {
		if scope != "header" {
			return nil, fmt.Errorf("数据行范围无效")
		}
	}
	if maxDataRow >= 0 && endRow > maxDataRow {
		endRow = maxDataRow
	}

	backgroundColor, err := optionalAgentColor(args, "background_color")
	if err != nil {
		return nil, err
	}
	textColor, err := optionalAgentColor(args, "text_color")
	if err != nil {
		return nil, err
	}
	borderColor, err := optionalAgentColor(args, "border_color")
	if err != nil {
		return nil, err
	}
	bold, hasBold := optionalBoolArg(args, "bold")
	italic, hasItalic := optionalBoolArg(args, "italic")
	wrap, hasWrap := optionalBoolArg(args, "wrap")
	clearFormat, _ := optionalBoolArg(args, "clear_format")
	fontSize, hasFontSize, err := optionalNumberArg(args, "font_size", 8, 72)
	if err != nil {
		return nil, err
	}
	columnWidth, hasColumnWidth, err := optionalNumberArg(args, "column_width", 40, 500)
	if err != nil {
		return nil, err
	}
	rowHeight, hasRowHeight, err := optionalNumberArg(args, "row_height", 16, 240)
	if err != nil {
		return nil, err
	}
	horizontal := strings.ToLower(strings.TrimSpace(firstStringValue(args, "horizontal_alignment")))
	vertical := strings.ToLower(strings.TrimSpace(firstStringValue(args, "vertical_alignment")))
	borderStyle := strings.ToLower(strings.TrimSpace(firstStringValue(args, "border_style")))
	if horizontal != "" && horizontal != "left" && horizontal != "center" && horizontal != "right" {
		return nil, fmt.Errorf("horizontal_alignment 必须是 left、center 或 right")
	}
	if vertical != "" && vertical != "top" && vertical != "middle" && vertical != "bottom" {
		return nil, fmt.Errorf("vertical_alignment 必须是 top、middle 或 bottom")
	}
	if borderStyle != "" && borderColor == "" {
		borderColor = "#CBD5E1"
	}
	if borderColor != "" && borderStyle == "" {
		borderStyle = "thin"
	}
	if borderStyle != "" && agentBorderStyleValue(borderStyle) == 0 {
		return nil, fmt.Errorf("border_style 必须是 thin、dotted、dashed、double 或 thick")
	}
	styleRequested := clearFormat || backgroundColor != "" || textColor != "" || hasBold || hasItalic || hasWrap || hasFontSize || horizontal != "" || vertical != "" || borderColor != ""
	if !styleRequested && !hasColumnWidth && !hasRowHeight {
		return nil, fmt.Errorf("请至少提供一种颜色、字体、对齐、边框、行高或列宽设置")
	}

	worksheetRows := make([]int, 0)
	if scope == "header" || scope == "all" {
		worksheetRows = append(worksheetRows, 0)
	}
	if (scope == "data" || scope == "all") && maxDataRow >= 0 {
		for row := startRow; row <= endRow; row++ {
			worksheetRows = append(worksheetRows, row+1)
		}
	}
	if len(worksheetRows)*len(columnIndexes) > 20000 {
		return nil, fmt.Errorf("一次最多格式化 20000 个单元格，请缩小范围")
	}

	access, err := newSheetCellAccessCache(s.permService, userID, sheetID, sheet.Config, true)
	if err != nil {
		return nil, err
	}
	for _, worksheetRow := range worksheetRows {
		for index, columnIndex := range columnIndexes {
			columnKey := columnKeys[index]
			if !access.allowsCell(columnKey, worksheetRow, "write") {
				return nil, fmt.Errorf("没有权限格式化 %s%d", columns[columnIndex].Name, worksheetRow+1)
			}
			if protected, reason := access.checkProtection(columnKey, worksheetRow, userID); protected {
				return nil, fmt.Errorf("%s", reason)
			}
		}
	}

	configPayload, worksheet, cellData, err := ensureAgentWorksheetSnapshot(sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	styles, _ := configPayload["univerStyles"].(map[string]any)
	for _, worksheetRow := range worksheetRows {
		rowKey := strconv.Itoa(worksheetRow)
		rowCells, _ := cellData[rowKey].(map[string]any)
		if rowCells == nil {
			rowCells = make(map[string]any)
			cellData[rowKey] = rowCells
		}
		for _, columnIndex := range columnIndexes {
			columnKey := strconv.Itoa(columnIndex)
			cell, _ := rowCells[columnKey].(map[string]any)
			if cell == nil {
				cell = make(map[string]any)
				rowCells[columnKey] = cell
			}
			if styleRequested {
				if clearFormat {
					delete(cell, "s")
				} else {
					style := resolveAgentInlineStyle(cell["s"], styles)
					applyAgentStylePatch(style, backgroundColor, textColor, borderColor, borderStyle, horizontal, vertical, bold, hasBold, italic, hasItalic, wrap, hasWrap, fontSize, hasFontSize)
					cell["s"] = style
				}
			}
		}
	}
	worksheet["cellData"] = cellData

	if hasColumnWidth {
		columnData, _ := worksheet["columnData"].(map[string]any)
		if columnData == nil {
			columnData = make(map[string]any)
		}
		for _, columnIndex := range columnIndexes {
			columnData[strconv.Itoa(columnIndex)] = map[string]any{"w": columnWidth}
			columns[columnIndex].Width = columnWidth
		}
		worksheet["columnData"] = columnData
	}
	if hasRowHeight {
		rowData, _ := worksheet["rowData"].(map[string]any)
		if rowData == nil {
			rowData = make(map[string]any)
		}
		for _, worksheetRow := range worksheetRows {
			rowData[strconv.Itoa(worksheetRow)] = map[string]any{"h": rowHeight}
		}
		worksheet["rowData"] = rowData
	}
	configPayload["univerSheetData"] = worksheet

	nextConfig, err := json.Marshal(configPayload)
	if err != nil {
		return nil, fmt.Errorf("保存单元格样式失败: %w", err)
	}
	nextColumns, err := json.Marshal(columns)
	if err != nil {
		return nil, err
	}
	sheet.Config = nextConfig
	sheet.Columns = nextColumns
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, fmt.Errorf("更新单元格格式失败: %w", err)
	}
	if err := s.invalidateSheetByID(sheetID); err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok": true, "sheet_id": sheetID, "scope": scope, "column_keys": columnKeys,
			"start_row": startRow, "end_row": endRow, "formatted_cells": len(worksheetRows) * len(columnIndexes),
		},
		TouchedSheetIDs: []int64{sheetID},
		ChangedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已完成工作表样式设计，共更新 %d 个单元格", len(worksheetRows)*len(columnIndexes)),
	}, nil
}

func resolveFormatColumnIndexes(columns []sheetColumnPayload, requested []string) ([]int, []string, error) {
	if len(requested) == 0 {
		indexes := make([]int, len(columns))
		keys := make([]string, len(columns))
		for index, column := range columns {
			indexes[index] = index
			keys[index] = column.Key
		}
		return indexes, keys, nil
	}
	indexes := make([]int, 0, len(requested))
	keys := make([]string, 0, len(requested))
	seen := make(map[int]struct{})
	for _, reference := range requested {
		found := -1
		for index, column := range columns {
			if strings.EqualFold(strings.TrimSpace(reference), strings.TrimSpace(column.Key)) || strings.EqualFold(strings.TrimSpace(reference), strings.TrimSpace(column.Name)) {
				found = index
				break
			}
		}
		if found < 0 {
			return nil, nil, fmt.Errorf("列 %s 不存在", reference)
		}
		if _, exists := seen[found]; exists {
			continue
		}
		seen[found] = struct{}{}
		indexes = append(indexes, found)
		keys = append(keys, columns[found].Key)
	}
	return indexes, keys, nil
}

func ensureAgentWorksheetSnapshot(sheet *model.Sheet, columns []sheetColumnPayload, rows []model.Row) (map[string]any, map[string]any, map[string]any, error) {
	configPayload := make(map[string]any)
	if len(sheet.Config) > 0 {
		if err := json.Unmarshal(sheet.Config, &configPayload); err != nil {
			return nil, nil, nil, fmt.Errorf("解析工作表配置失败: %w", err)
		}
	}
	worksheet, _ := configPayload["univerSheetData"].(map[string]any)
	if worksheet == nil {
		worksheet = map[string]any{
			"id": fmt.Sprintf("sheet-%d", sheet.ID), "name": sheet.Name,
			"rowCount": 200, "columnCount": maxIntValue(len(columns), 26),
			"defaultColumnWidth": 140, "defaultRowHeight": 28,
			"rowData": map[string]any{}, "columnData": map[string]any{},
		}
	}
	cellData, _ := worksheet["cellData"].(map[string]any)
	if cellData == nil {
		cellData = make(map[string]any)
	}
	header, _ := cellData["0"].(map[string]any)
	if header == nil {
		header = make(map[string]any)
		cellData["0"] = header
	}
	for index, column := range columns {
		key := strconv.Itoa(index)
		if _, exists := header[key]; !exists {
			header[key] = map[string]any{"v": column.Name}
		}
	}
	maxWorksheetRow := 1
	for _, row := range rows {
		worksheetRow := row.RowIndex + 1
		if worksheetRow > maxWorksheetRow {
			maxWorksheetRow = worksheetRow
		}
		rowKey := strconv.Itoa(worksheetRow)
		rowCells, _ := cellData[rowKey].(map[string]any)
		if rowCells == nil {
			rowCells = make(map[string]any)
			cellData[rowKey] = rowCells
		}
		data := make(map[string]any)
		if len(row.Data) > 0 {
			_ = json.Unmarshal(row.Data, &data)
		}
		for columnIndex, column := range columns {
			cellKey := strconv.Itoa(columnIndex)
			if _, exists := rowCells[cellKey]; exists {
				continue
			}
			if value, exists := data[column.Key]; exists {
				rowCells[cellKey] = agentUniverCell(value)
			}
		}
	}
	worksheet["rowCount"] = maxIntValue(maxWorksheetRow+25, 200)
	worksheet["columnCount"] = maxIntValue(len(columns), 26)
	worksheet["cellData"] = cellData
	return configPayload, worksheet, cellData, nil
}

func agentUniverCell(value any) map[string]any {
	style := map[string]any(nil)
	if record, ok := value.(map[string]any); ok {
		if rawStyle, exists := record["style"].(map[string]any); exists {
			style = make(map[string]any)
			if color := strings.TrimSpace(fmt.Sprint(rawStyle["textColor"])); color != "" && color != "<nil>" {
				style["cl"] = map[string]any{"rgb": color}
			}
			if color := strings.TrimSpace(fmt.Sprint(rawStyle["backgroundColor"])); color != "" && color != "<nil>" {
				style["bg"] = map[string]any{"rgb": color}
			}
		}
		if raw, exists := record["value"]; exists {
			value = raw
		}
		if formula, exists := record["formula"].(string); exists && strings.TrimSpace(formula) != "" {
			value = formula
		}
	}
	cell := make(map[string]any)
	if formula, ok := value.(string); ok && strings.HasPrefix(strings.TrimSpace(formula), "=") {
		cell["f"] = formula
	} else {
		cell["v"] = value
	}
	if len(style) > 0 {
		cell["s"] = style
	}
	return cell
}

func resolveAgentInlineStyle(raw any, styles map[string]any) map[string]any {
	if style, ok := raw.(map[string]any); ok {
		encoded, _ := json.Marshal(style)
		result := make(map[string]any)
		_ = json.Unmarshal(encoded, &result)
		return result
	}
	if styleID, ok := raw.(string); ok && styles != nil {
		if style, ok := styles[styleID].(map[string]any); ok {
			encoded, _ := json.Marshal(style)
			result := make(map[string]any)
			_ = json.Unmarshal(encoded, &result)
			return result
		}
	}
	return make(map[string]any)
}

func applyAgentStylePatch(style map[string]any, backgroundColor, textColor, borderColor, borderStyle, horizontal, vertical string, bold, hasBold, italic, hasItalic, wrap, hasWrap bool, fontSize float64, hasFontSize bool) {
	if backgroundColor != "" {
		style["bg"] = map[string]any{"rgb": backgroundColor}
	}
	if textColor != "" {
		style["cl"] = map[string]any{"rgb": textColor}
	}
	if hasBold {
		style["bl"] = map[bool]int{true: 1, false: 0}[bold]
	}
	if hasItalic {
		style["it"] = map[bool]int{true: 1, false: 0}[italic]
	}
	if hasFontSize {
		style["fs"] = fontSize
	}
	if horizontal != "" {
		style["ht"] = map[string]int{"left": 1, "center": 2, "right": 3}[horizontal]
	}
	if vertical != "" {
		style["vt"] = map[string]int{"top": 1, "middle": 2, "bottom": 3}[vertical]
	}
	if hasWrap {
		style["tb"] = map[bool]int{true: 3, false: 1}[wrap]
	}
	if borderColor != "" {
		line := map[string]any{"s": agentBorderStyleValue(borderStyle), "cl": map[string]any{"rgb": borderColor}}
		style["bd"] = map[string]any{"t": line, "r": line, "b": line, "l": line}
	}
}

func optionalAgentColor(args map[string]any, key string) (string, error) {
	value := strings.ToUpper(strings.TrimSpace(firstStringValue(args, key)))
	if value == "" {
		return "", nil
	}
	if matched, _ := regexp.MatchString(`^#[0-9A-F]{6}([0-9A-F]{2})?$`, value); !matched {
		return "", fmt.Errorf("%s 必须使用 #RRGGBB 或 #RRGGBBAA 颜色", key)
	}
	return value, nil
}

func optionalBoolArg(args map[string]any, key string) (bool, bool) {
	value, exists := args[key]
	if !exists || value == nil {
		return false, false
	}
	switch typed := value.(type) {
	case bool:
		return typed, true
	case string:
		parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
		return parsed, err == nil
	default:
		return false, false
	}
}

func optionalNumberArg(args map[string]any, key string, minimum, maximum float64) (float64, bool, error) {
	value, exists := args[key]
	if !exists || value == nil {
		return 0, false, nil
	}
	number, ok := toFloat64(value)
	if !ok || number < minimum || number > maximum {
		return 0, false, fmt.Errorf("%s 必须在 %.0f 到 %.0f 之间", key, minimum, maximum)
	}
	return number, true, nil
}

func agentBorderStyleValue(value string) int {
	return map[string]int{"thin": 1, "dotted": 3, "dashed": 4, "double": 7, "thick": 13}[value]
}

func maxIntValue(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func (s *AIService) toolCreateFinancialReport(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetIDs, err := int64SliceArg(args, "source_sheet_ids")
	if err != nil {
		return nil, err
	}
	name, _ := stringArgWithDefault(args, "name", "")
	workbookID, sheetID, metricCount, err := s.CreateFinancialReportWorkbook(userID, name, sheetIDs)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok":           true,
			"workbook_id":  workbookID,
			"sheet_id":     sheetID,
			"metric_count": metricCount,
			"open_url":     fmt.Sprintf("/sheets/%d/%d", workbookID, sheetID),
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  []int64{sheetID},
		ResourcesChanged: true,
		Summary:          fmt.Sprintf("已创建财务分析工作簿，共生成 %d 项指标", metricCount),
	}, nil
}

func (s *AIService) toolListSummaryPages(userID int64, _ map[string]any) (*toolExecutionResult, error) {
	pages, err := s.ListAISummaryPages(userID)
	if err != nil {
		return nil, err
	}
	items := make([]map[string]any, 0, len(pages))
	for _, page := range pages {
		items = append(items, map[string]any{
			"summary_id":     page.ID,
			"title":          page.Title,
			"assistant_name": page.AssistantName,
			"updated_at":     page.UpdatedAt,
			"open_url":       fmt.Sprintf("/ai/summaries?selected=%d", page.ID),
		})
	}
	return &toolExecutionResult{
		Data:    map[string]any{"pages": items, "count": len(items)},
		Summary: fmt.Sprintf("已找到 %d 个 AI 汇总页面", len(items)),
	}, nil
}

func (s *AIService) toolCreateSummaryPage(userID int64, args map[string]any) (*toolExecutionResult, error) {
	title, err := stringArg(args, "title")
	if err != nil {
		return nil, err
	}
	workbookIDs, err := int64SliceArg(args, "workbook_ids")
	if err != nil {
		return nil, err
	}
	prompt, _ := stringArgWithDefault(args, "prompt", "")
	assistantID, _ := int64Arg(args, "_assistant_id")
	var assistantIDPtr *int64
	if assistantID > 0 {
		assistantIDPtr = &assistantID
	}
	page, err := s.GenerateAISummaryPage(userID, &model.AISummaryGenerateRequest{
		Title:       title,
		WorkbookIDs: workbookIDs,
		AssistantID: assistantIDPtr,
		Prompt:      prompt,
	})
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok":              true,
			"summary_page_id": page.ID,
			"title":           page.Title,
			"summary_url":     fmt.Sprintf("/ai/summaries?selected=%d", page.ID),
		},
		Summary: fmt.Sprintf("已创建 AI 汇总页面「%s」", page.Title),
	}, nil
}

func (s *AIService) toolUpdateSummaryPage(userID int64, args map[string]any) (*toolExecutionResult, error) {
	pageID, err := int64Arg(args, "summary_id")
	if err != nil {
		return nil, err
	}
	page, err := s.GetAISummaryPage(userID, pageID)
	if err != nil {
		return nil, err
	}
	req := &model.AISummaryUpdateRequest{}
	if title, _ := stringArgWithDefault(args, "title", ""); strings.TrimSpace(title) != "" {
		req.Title = &title
	}
	content := page.Content
	contentChanged := false
	if headline, _ := stringArgWithDefault(args, "headline", ""); strings.TrimSpace(headline) != "" {
		content.Headline = headline
		contentChanged = true
	}
	if overview, _ := stringArgWithDefault(args, "overview", ""); strings.TrimSpace(overview) != "" {
		content.Overview = overview
		contentChanged = true
	}
	if raw, ok := args["metrics"]; ok {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, fmt.Errorf("metrics 参数错误: %w", err)
		}
		if err := json.Unmarshal(encoded, &content.Metrics); err != nil {
			return nil, fmt.Errorf("metrics 参数错误: %w", err)
		}
		contentChanged = true
	}
	if raw, ok := args["sections"]; ok {
		encoded, err := json.Marshal(raw)
		if err != nil {
			return nil, fmt.Errorf("sections 参数错误: %w", err)
		}
		if err := json.Unmarshal(encoded, &content.Sections); err != nil {
			return nil, fmt.Errorf("sections 参数错误: %w", err)
		}
		contentChanged = true
	}
	if contentChanged {
		req.Content = &content
	}
	if req.Title == nil && req.Content == nil {
		return nil, fmt.Errorf("没有提供需要修改的汇总内容")
	}
	updated, err := s.UpdateAISummaryPage(userID, pageID, req)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok":              true,
			"summary_page_id": updated.ID,
			"title":           updated.Title,
			"summary_url":     fmt.Sprintf("/ai/summaries?selected=%d", updated.ID),
		},
		Summary: fmt.Sprintf("已更新 AI 汇总页面「%s」", updated.Title),
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

	for index, operation := range operations {
		normalized, err := s.resolveSpreadsheetOperationForExecution(operation)
		if err != nil {
			return nil, fmt.Errorf("operation %d: %w", index+1, err)
		}
		if normalized.SheetID == 0 {
			return nil, fmt.Errorf("operation %d: sheet_id is required", index+1)
		}
		if err := s.validateSpreadsheetOperationAccess(userID, normalized); err != nil {
			return nil, fmt.Errorf("operation %d (%s): %w", index+1, normalized.Kind, err)
		}
		if err := s.applySpreadsheetOperation(userID, normalized); err != nil {
			return nil, fmt.Errorf("operation %d (%s): %w", index+1, normalized.Kind, err)
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
		targetPermissionRow := operation.Row
		if operation.Row > 0 {
			targetPermissionRow = operation.Row - 1
		}
		if err := s.validateRowWriteAccess(userID, operation.SheetID, targetPermissionRow); err != nil {
			return err
		}
		for key := range operation.RowValues {
			if err := s.validateCellWriteAccess(userID, operation.SheetID, operation.Row, key); err != nil {
				return err
			}
		}
		return nil
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
	if operation.Kind == "" {
		return operation, fmt.Errorf("operation kind is required")
	}
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
	if operation.Kind == "insert_column" {
		if !isSupportedColumnType(normalizeColumnType(firstNonEmpty(operation.ColumnType, "text"))) {
			return operation, fmt.Errorf("unsupported column type %q", operation.ColumnType)
		}
		operation.ColumnType = normalizeColumnType(firstNonEmpty(operation.ColumnType, "text"))
		if key, _ := resolveColumnReference(operation.ColumnKey, columns); key != "" {
			return operation, fmt.Errorf("column %q already exists", operation.ColumnKey)
		}
		if operation.FormulaTemplate != "" {
			if err := validateFormulaTemplateReferences(operation.FormulaTemplate, columns); err != nil {
				return operation, err
			}
		}
	} else if strings.TrimSpace(operation.ColumnKey) != "" || strings.TrimSpace(operation.ColumnName) != "" {
		reference := firstNonEmpty(strings.TrimSpace(operation.ColumnKey), strings.TrimSpace(operation.ColumnName))
		resolvedKey, resolvedName := resolveColumnReference(reference, columns)
		if resolvedKey == "" {
			return operation, fmt.Errorf("column %q does not exist", reference)
		}
		operation.ColumnKey = resolvedKey
		operation.ColumnName = resolvedName
	}
	if operation.Kind == "insert_row" {
		normalizedValues := make(map[string]interface{}, len(operation.RowValues))
		for reference, value := range operation.RowValues {
			resolvedKey, _ := resolveColumnReference(reference, columns)
			if resolvedKey == "" {
				return operation, fmt.Errorf("row_values column %q does not exist", reference)
			}
			normalizedValues[resolvedKey] = value
		}
		operation.RowValues = normalizedValues
	}
	if operation.Kind == "fill_formula" {
		if err := validateFormulaTemplateReferences(operation.FormulaTemplate, columns); err != nil {
			return operation, err
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
	value, ok := args[key]
	if !ok {
		return nil
	}
	if typedItems, ok := value.([]string); ok {
		result := make([]string, 0, len(typedItems))
		for _, item := range typedItems {
			if text := strings.TrimSpace(item); text != "" {
				result = append(result, text)
			}
		}
		return result
	}
	items, ok := value.([]any)
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
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, err
	}
	departmentIDs, err := s.permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, err
	}
	departmentSet := int64Set(departmentIDs)
	result := make([]aiPreviewRow, 0, len(previewRows))
	for _, row := range previewRows {
		filtered := make(map[string]interface{}, len(row.Data))
		for key, value := range row.Data {
			allowed, err := s.permService.CheckCellPermission(sheet.ID, userID, key, row.Row, "read")
			if err != nil {
				return nil, err
			}
			if allowed && !protectionHidesCell(protections, row.Row, key, userID, isAdmin, departmentSet) {
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
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array", key)
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("%s must contain at least one operation", key)
	}
	operations := make([]SpreadsheetOperation, 0, len(items))
	for index, item := range items {
		raw, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("operations[%d] must be an object", index)
		}
		normalizedItems, err := normalizeRawSpreadsheetOperations(raw)
		if err != nil {
			return nil, fmt.Errorf("operations[%d]: %w", index, err)
		}
		operations = append(operations, normalizedItems...)
	}
	return operations, nil
}

func normalizeRawSpreadsheetOperations(raw map[string]any) ([]SpreadsheetOperation, error) {
	rawKind := firstStringValue(raw, "kind", "type", "action", "operation")
	kind := normalizeSpreadsheetOperationKind(rawKind)
	rowValues := firstMapValue(raw, "row_values", "rowValues", "values", "data", "changes")
	if kind == "" {
		kind = normalizeSpreadsheetOperationKind(inferSpreadsheetOperationKind(raw))
	}
	columnReference := firstStringValue(raw, "column_key", "columnKey", "key", "column", "column_name", "columnName")
	if len(rowValues) > 0 && columnReference == "" && (kind == "update_cell" || kind == "update_row" || kind == "set_row" || kind == "upsert_row" || kind == "batch_update") {
		row, hasRow := firstIntValue(raw, "row", "row_index", "rowIndex")
		if !hasRow || row < 0 {
			return nil, fmt.Errorf("整行更新需要 row（0-based 数据行索引）")
		}
		sheetID := firstPositiveInt64Value(raw, "sheet_id", "sheetId")
		if sheetID == 0 {
			return nil, fmt.Errorf("sheet_id is required")
		}
		keys := make([]string, 0, len(rowValues))
		for key := range rowValues {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		operations := make([]SpreadsheetOperation, 0, len(keys))
		for _, key := range keys {
			operations = append(operations, SpreadsheetOperation{
				Kind:      "update_cell",
				SheetID:   sheetID,
				Row:       row,
				ColumnKey: key,
				Value:     rowValues[key],
			})
		}
		return operations, nil
	}
	operation, err := normalizeRawSpreadsheetOperation(raw)
	if err != nil {
		return nil, err
	}
	return []SpreadsheetOperation{operation}, nil
}

func normalizeAgentSheetColumns(value any) ([]sheetColumnPayload, error) {
	items, ok := value.([]any)
	if !ok {
		return nil, fmt.Errorf("columns 必须是数组")
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("columns 至少需要一列")
	}
	columns := make([]sheetColumnPayload, 0, len(items))
	seenKeys := make(map[string]struct{}, len(items))
	seenNames := make(map[string]struct{}, len(items))
	for index, item := range items {
		raw, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("columns[%d] 必须是对象", index)
		}
		key := firstStringValue(raw, "key", "column_key", "columnKey", "field", "field_key")
		name := firstStringValue(raw, "name", "column_name", "columnName", "label", "title")
		if key == "" {
			return nil, fmt.Errorf("columns[%d] 缺少 key；可使用 key 或 column_key", index)
		}
		if name == "" {
			return nil, fmt.Errorf("columns[%d] 缺少 name；可使用 name 或 column_name", index)
		}
		if len(key) > 128 || strings.ContainsAny(key, ":\r\n\t") {
			return nil, fmt.Errorf("columns[%d] 的 key %q 无效", index, key)
		}
		keyIdentity := strings.ToLower(key)
		nameIdentity := strings.ToLower(name)
		if _, exists := seenKeys[keyIdentity]; exists {
			return nil, fmt.Errorf("columns[%d] 的 key %q 重复", index, key)
		}
		if _, exists := seenNames[nameIdentity]; exists {
			return nil, fmt.Errorf("columns[%d] 的 name %q 重复", index, name)
		}
		seenKeys[keyIdentity] = struct{}{}
		seenNames[nameIdentity] = struct{}{}

		rawType := firstStringValue(raw, "type", "column_type", "columnType", "format", "data_type")
		options := firstColumnOptions(raw)
		columnType := normalizeColumnType(rawType)
		if !isSupportedColumnType(columnType) {
			if inferred := splitColumnOptions(rawType); len(inferred) > 1 {
				columnType = "select"
				if len(options) == 0 {
					options = inferred
				}
			}
		}
		if columnType == "" {
			if len(options) > 0 {
				columnType = "select"
			} else {
				columnType = "text"
			}
		}
		if !isSupportedColumnType(columnType) {
			return nil, fmt.Errorf("columns[%d] 的类型 %q 不受支持", index, rawType)
		}
		if len(options) > 0 {
			columnType = "select"
		}

		width := float64(140)
		for _, widthKey := range []string{"width", "column_width", "columnWidth"} {
			if value, exists := raw[widthKey]; exists {
				if parsed, ok := toFloat64(value); ok && parsed >= 60 && parsed <= 600 {
					width = parsed
				}
				break
			}
		}
		required, _ := raw["required"].(bool)
		validation, _ := raw["validation"].(map[string]any)
		currencyCode := firstStringValue(raw, "currencyCode", "currency_code")
		currencySource := firstStringValue(raw, "currencySource", "currency_source")
		columns = append(columns, sheetColumnPayload{
			Key:            key,
			Name:           name,
			Type:           columnType,
			Width:          width,
			Required:       required,
			Validation:     validation,
			Formula:        firstStringValue(raw, "formula", "formula_template", "formulaTemplate"),
			Options:        options,
			CurrencyCode:   strings.ToUpper(currencyCode),
			CurrencySource: currencySource,
		})
	}
	return columns, nil
}

func normalizeColumnType(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	switch normalized {
	case "", "auto", "自动":
		return ""
	case "text", "string", "文本", "字符串":
		return "text"
	case "number", "numeric", "integer", "decimal", "数字", "数值", "整数", "小数":
		return "number"
	case "currency", "money", "amount", "金额", "货币", "人民币":
		return "currency"
	case "date", "datetime", "日期", "时间", "日期时间":
		return "date"
	case "percentage", "percent", "百分比", "百分率":
		return "percentage"
	case "formula", "公式":
		return "formula"
	case "select", "dropdown", "enum", "下拉", "下拉选择", "选择", "枚举":
		return "select"
	case "image", "图片", "图像":
		return "image"
	default:
		return normalized
	}
}

func isSupportedColumnType(value string) bool {
	switch value {
	case "text", "number", "currency", "date", "percentage", "formula", "select", "image":
		return true
	default:
		return false
	}
}

func firstColumnOptions(raw map[string]any) []string {
	for _, key := range []string{"options", "choices", "values", "enum", "allowed_values", "allowedValues"} {
		if options := splitColumnOptions(raw[key]); len(options) > 0 {
			return options
		}
	}
	if validation, ok := raw["validation"].(map[string]any); ok {
		for _, key := range []string{"options", "values", "enum", "allowed_values", "formula1"} {
			if options := splitColumnOptions(validation[key]); len(options) > 0 {
				return options
			}
		}
	}
	return nil
}

func splitColumnOptions(value any) []string {
	var candidates []string
	switch typed := value.(type) {
	case []any:
		for _, item := range typed {
			if text, ok := item.(string); ok {
				candidates = append(candidates, text)
			}
		}
	case []string:
		candidates = append(candidates, typed...)
	case string:
		text := strings.TrimSpace(typed)
		if strings.HasPrefix(text, "[") {
			var parsed []string
			if json.Unmarshal([]byte(text), &parsed) == nil {
				candidates = append(candidates, parsed...)
				break
			}
		}
		candidates = append(candidates, strings.FieldsFunc(text, func(value rune) bool {
			return value == ',' || value == '，' || value == ';' || value == '；' || value == '|' || value == '\n'
		})...)
	}
	result := make([]string, 0, len(candidates))
	seen := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		trimmed := strings.TrimSpace(candidate)
		if trimmed == "" {
			continue
		}
		identity := strings.ToLower(trimmed)
		if _, exists := seen[identity]; exists {
			continue
		}
		seen[identity] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

func validateFormulaTemplateReferences(template string, columns []sheetColumnPayload) error {
	check := func(leftIndex, rightIndex int, operator string) error {
		if leftIndex < 0 || leftIndex >= len(columns) || rightIndex < 0 || rightIndex >= len(columns) {
			return fmt.Errorf("公式中的列引用超出工作表字段范围，请使用 {{column_key}} 引用字段")
		}
		for _, index := range []int{leftIndex, rightIndex} {
			columnType := normalizeColumnType(columns[index].Type)
			if columnType != "number" && columnType != "currency" && columnType != "percentage" && columnType != "formula" {
				return fmt.Errorf("公式运算符 %s 引用了非数值列 %s（%s，类型 %s）；请改用正确字段的 {{column_key}} 模板", operator, spreadsheetColumnLetter(index), firstNonEmpty(columns[index].Name, columns[index].Key), columns[index].Type)
			}
		}
		return nil
	}

	for _, match := range formulaArithmeticReferencePattern.FindAllStringSubmatch(template, -1) {
		leftIndex := spreadsheetColumnIndex(match[1])
		rightIndex := spreadsheetColumnIndex(match[3])
		if err := check(leftIndex, rightIndex, match[2]); err != nil {
			return err
		}
	}
	for _, match := range formulaKeyArithmeticPattern.FindAllStringSubmatch(template, -1) {
		leftKey, _ := resolveColumnReference(match[1], columns)
		rightKey, _ := resolveColumnReference(match[3], columns)
		if leftKey == "" || rightKey == "" {
			return fmt.Errorf("公式引用了不存在的字段，请检查 {{%s}} 和 {{%s}}", match[1], match[3])
		}
		leftIndex, rightIndex := -1, -1
		for index, column := range columns {
			if column.Key == leftKey {
				leftIndex = index
			}
			if column.Key == rightKey {
				rightIndex = index
			}
		}
		if err := check(leftIndex, rightIndex, match[2]); err != nil {
			return err
		}
	}
	return nil
}

func spreadsheetColumnIndex(value string) int {
	index := 0
	for _, character := range strings.ToUpper(strings.TrimSpace(value)) {
		if character < 'A' || character > 'Z' {
			return -1
		}
		index = index*26 + int(character-'A'+1)
	}
	return index - 1
}

func normalizeRawSpreadsheetOperation(raw map[string]any) (SpreadsheetOperation, error) {
	kind := firstStringValue(raw, "kind", "type", "action", "operation")
	if strings.TrimSpace(kind) == "" {
		kind = inferSpreadsheetOperationKind(raw)
	}
	kind = normalizeSpreadsheetOperationKind(kind)
	validKinds := map[string]bool{
		"update_cell":   true,
		"insert_row":    true,
		"delete_row":    true,
		"insert_column": true,
		"fill_formula":  true,
	}
	if !validKinds[kind] {
		return SpreadsheetOperation{}, fmt.Errorf("unsupported or missing kind %q; supported kinds: update_cell, insert_row, delete_row, insert_column, fill_formula", kind)
	}

	encoded, err := json.Marshal(raw)
	if err != nil {
		return SpreadsheetOperation{}, fmt.Errorf("marshal operation: %w", err)
	}
	var operation SpreadsheetOperation
	if err := json.Unmarshal(encoded, &operation); err != nil {
		return SpreadsheetOperation{}, fmt.Errorf("parse operation: %w", err)
	}
	operation.Kind = kind
	if operation.SheetID == 0 {
		if value, ok := firstInt64Value(raw, "sheet_id", "sheetId"); ok {
			operation.SheetID = value
		}
	}
	if operation.SheetID <= 0 {
		return SpreadsheetOperation{}, fmt.Errorf("sheet_id is required")
	}
	if operation.ColumnKey == "" {
		operation.ColumnKey = firstStringValue(raw, "column_key", "columnKey", "key", "column")
	}
	if operation.ColumnName == "" {
		operation.ColumnName = firstStringValue(raw, "column_name", "columnName")
	}
	if operation.ColumnType == "" {
		operation.ColumnType = normalizeColumnType(firstStringValue(raw, "column_type", "columnType", "format"))
	}
	if operation.FormulaTemplate == "" {
		operation.FormulaTemplate = firstStringValue(raw, "formula_template", "formulaTemplate", "formula")
	}
	if operation.InsertAfterColumnKey == "" {
		operation.InsertAfterColumnKey = firstStringValue(raw, "insert_after_column_key", "insertAfterColumnKey", "after_column")
	}
	if len(operation.RowValues) == 0 {
		operation.RowValues = firstMapValue(raw, "row_values", "rowValues", "values", "data")
	}
	rowValue, hasRow := firstIntValue(raw, "row", "row_index", "rowIndex")
	if hasRow {
		operation.Row = rowValue
	}
	if value, ok := firstIntValue(raw, "start_row", "startRow"); ok {
		operation.StartRow = &value
	}
	if value, ok := firstIntValue(raw, "end_row", "endRow"); ok {
		operation.EndRow = &value
	}

	switch operation.Kind {
	case "update_cell":
		if strings.TrimSpace(operation.ColumnKey) == "" && strings.TrimSpace(operation.ColumnName) == "" {
			return SpreadsheetOperation{}, fmt.Errorf("update_cell requires column_key or column_name")
		}
		if !hasRow || operation.Row < 0 {
			return SpreadsheetOperation{}, fmt.Errorf("update_cell requires row（0-based 数据行索引）")
		}
		if value, ok := firstAnyValue(raw, "value", "new_value", "newValue", "cell_value", "cellValue"); ok {
			operation.Value = value
		} else {
			return SpreadsheetOperation{}, fmt.Errorf("update_cell requires value")
		}
	case "insert_row":
		if operation.Row < 0 {
			operation.Row = 0
		}
		if len(operation.RowValues) == 0 {
			return SpreadsheetOperation{}, fmt.Errorf("insert_row requires row_values")
		}
	case "delete_row":
		if !hasRow || operation.Row < 0 {
			return SpreadsheetOperation{}, fmt.Errorf("delete_row requires row（0-based 数据行索引）")
		}
	case "insert_column":
		if strings.TrimSpace(operation.ColumnKey) == "" || strings.TrimSpace(operation.ColumnName) == "" {
			return SpreadsheetOperation{}, fmt.Errorf("insert_column requires column_key and column_name")
		}
	case "fill_formula":
		if strings.TrimSpace(operation.ColumnKey) == "" || strings.TrimSpace(operation.FormulaTemplate) == "" {
			return SpreadsheetOperation{}, fmt.Errorf("fill_formula requires column_key and formula_template")
		}
	}
	return operation, nil
}

func inferSpreadsheetOperationKind(raw map[string]any) string {
	if len(firstMapValue(raw, "row_values", "rowValues")) > 0 {
		return "insert_row"
	}
	if len(firstMapValue(raw, "values", "data", "changes")) > 0 {
		if _, hasRow := firstIntValue(raw, "row", "row_index", "rowIndex"); hasRow {
			return "update_row"
		}
		return "insert_row"
	}
	if firstStringValue(raw, "formula_template", "formulaTemplate", "formula") != "" {
		return "fill_formula"
	}
	if firstStringValue(raw, "column_name", "columnName") != "" && firstStringValue(raw, "column_key", "columnKey", "key") != "" {
		return "insert_column"
	}
	if _, hasValue := raw["value"]; hasValue && firstStringValue(raw, "column_key", "columnKey", "key", "column") != "" {
		return "update_cell"
	}
	return ""
}

func firstStringValue(raw map[string]any, keys ...string) string {
	for _, key := range keys {
		if value, ok := raw[key].(string); ok && strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func firstMapValue(raw map[string]any, keys ...string) map[string]interface{} {
	for _, key := range keys {
		if value, ok := raw[key].(map[string]any); ok && len(value) > 0 {
			return value
		}
	}
	return nil
}

func firstIntValue(raw map[string]any, keys ...string) (int, bool) {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			if parsed, ok := toInt64(value); ok {
				return int(parsed), true
			}
		}
	}
	return 0, false
}

func firstInt64Value(raw map[string]any, keys ...string) (int64, bool) {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			if parsed, ok := toInt64(value); ok {
				return parsed, true
			}
		}
	}
	return 0, false
}

func firstPositiveInt64Value(raw map[string]any, keys ...string) int64 {
	value, ok := firstInt64Value(raw, keys...)
	if !ok || value <= 0 {
		return 0
	}
	return value
}

func firstAnyValue(raw map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := raw[key]; ok {
			return value, true
		}
	}
	return nil, false
}
