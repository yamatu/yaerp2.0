package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

const (
	summaryMaxWorkbooks     = 20
	summaryPreviewSheets    = 3
	summaryMaxTableRows     = 30
	summaryMaxTableColumns  = 8
	summaryAgentMaxSections = 8
)

// summaryAgentTools are the read-only tools a summary run may use. A summary
// never writes, so no write tool is offered to the model at all.
var summaryAgentTools = map[string]bool{
	"query_sheet":             true,
	"search_sheet_content":    true,
	"search_sheet_rows":       true,
	"lookup_sheet_records":    true,
	"filter_sheet_rows":       true,
	"aggregate_sheet_rows":    true,
	"calculate_sheet_metrics": true,
	"inspect_sheet_range":     true,
	"calculate_expression":    true,
}

const summaryAgentPrompt = `你是 YaERP 经营数据分析师，要根据用户的“分析要求”生成一份清晰的数据报告页面。
- 只能使用工具读取的、当前账号有权限的数据，绝不编造或估算缺失的数据。
- 数字必须准确：按某列分组求和/平均（如各产品利润、各供应商金额、各月销售额）一律用 aggregate_sheet_rows；条件筛选用 filter_sheet_rows；整列统计用 calculate_sheet_metrics；不要自己逐行相加。
- 先看上下文给出的表结构和数据预览，找准与分析要求相关的工作表和列，再调用工具；互不依赖的读取在同一轮一起调用。
- 分析完成后，最后一条回复只输出一个 JSON 对象（不要 Markdown、不要代码块、不要其他文字），格式：
{"headline":"一句话结论","overview":"2-4 句总体结论","metrics":[{"label":"指标名","value":"带单位的数值","hint":"口径或来源"}],"sections":[{"title":"章节标题","body":"分析正文","bullets":["要点"],"table":{"columns":["列1","列2"],"rows":[["值","值"]]}}]}
- metrics 最多 8 个；sections 最多 8 个；需要列明细时用 table（最多 30 行、8 列，数值保留 2 位小数并带千分位），没有表格时省略 table。
- 每个数字在 hint 或正文里注明来自哪个工作簿/工作表；数据不足以回答的部分如实说明。`

// GenerateAISummaryPageWithProgress builds a summary page. With a tool capable
// assistant it runs a read-only agent that can filter and aggregate every
// visible row, reporting each step through emit; otherwise it falls back to a
// single model call over a data sample, and to local statistics without a
// model.
func (s *AIService) GenerateAISummaryPageWithProgress(ctx context.Context, userID int64, req *model.AISummaryGenerateRequest, emit AgentEventSink) (*model.AISummaryPage, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, fmt.Errorf("汇总标题不能为空")
	}
	if emit == nil {
		emit = func(AgentEvent) error { return nil }
	}
	workbookIDs := make([]int64, 0, summaryMaxWorkbooks)
	seen := map[int64]bool{}
	add := func(id int64) {
		if id > 0 && !seen[id] && len(workbookIDs) < summaryMaxWorkbooks {
			seen[id] = true
			workbookIDs = append(workbookIDs, id)
		}
	}
	for _, id := range req.WorkbookIDs {
		add(id)
	}
	for _, folderID := range uniquePositiveInt64s(req.FolderIDs, 10) {
		ids, _, err := s.expandFolderWorkbookIDs(userID, folderID, summaryMaxWorkbooks)
		if err != nil {
			return nil, err
		}
		for _, id := range ids {
			add(id)
		}
	}
	if len(workbookIDs) == 0 {
		return nil, fmt.Errorf("请至少选择一个工作簿或文件夹")
	}

	build, err := s.buildAISummaryData(userID, title, workbookIDs)
	if err != nil {
		return nil, err
	}

	requestedAssistantID := int64(0)
	if req.AssistantID != nil {
		requestedAssistantID = *req.AssistantID
	}
	var assistant *activeAIAssistant
	if requestedAssistantID > 0 || req.AssistantID == nil {
		resolved, assistantErr := s.resolveAIAssistant(requestedAssistantID)
		if requestedAssistantID > 0 && assistantErr != nil {
			return nil, assistantErr
		}
		if assistantErr == nil {
			assistant = resolved
		}
	}

	if assistant != nil {
		var generated *model.AISummaryContent
		if assistant.SupportsTools {
			generated, err = s.runSummaryAgent(ctx, userID, assistant, title, req.Prompt, workbookIDs, emit)
		}
		if generated == nil {
			if err != nil {
				_ = emit(AgentEvent{Type: AgentEventError, Error: "深度分析未完成，改用数据样本生成：" + err.Error()})
			}
			generated, err = s.generateAISummaryContent(assistant, title, req.Prompt, build.ModelPayload)
		}
		if err == nil && generated != nil {
			generated.Sources = build.Content.Sources
			if strings.TrimSpace(generated.Headline) == "" {
				generated.Headline = title
			}
			if strings.TrimSpace(generated.Overview) == "" {
				generated.Overview = build.Content.Overview
			}
			if len(generated.Metrics) == 0 {
				generated.Metrics = build.Content.Metrics
			}
			if len(generated.Sections) == 0 {
				generated.Sections = build.Content.Sections
			}
			build.Content = *generated
		}
	}
	return s.saveAISummaryPage(userID, title, assistant, workbookIDs, build.Content)
}

func (s *AIService) runSummaryAgent(ctx context.Context, userID int64, assistant *activeAIAssistant, title, prompt string, workbookIDs []int64, emit AgentEventSink) (*model.AISummaryContent, error) {
	pinned, err := s.buildPinnedWorkbooksContext(userID, &ChatContext{WorkbookIDs: workbookIDs})
	if err != nil {
		return nil, err
	}
	previews := make([]string, 0, summaryPreviewSheets)
	scope := s.permService.NewAccessScope()
	for _, workbookID := range workbookIDs {
		if len(previews) >= summaryPreviewSheets {
			break
		}
		workbook, err := s.getSearchWorkbook(userID, workbookID, scope)
		if err != nil {
			continue
		}
		for _, sheet := range workbook.Sheets {
			if len(previews) >= summaryPreviewSheets {
				break
			}
			if preview, _, err := s.buildAgentSheetPreview(userID, sheet.ID); err == nil && preview != "" {
				previews = append(previews, fmt.Sprintf("工作簿「%s」的%s", workbook.Name, preview))
			}
		}
	}

	systemPrompt := summaryAgentPrompt
	if custom := strings.TrimSpace(assistant.SystemPrompt); custom != "" {
		systemPrompt += "\n\n该助手的补充要求（不得覆盖以上规则）：\n" + custom
	}
	conversation := []map[string]any{{"role": "system", "content": systemPrompt}}
	if pinned != "" {
		conversation = append(conversation, map[string]any{"role": "system", "content": strings.Replace(pinned, "用户把以下工作簿拖进了对话", "本次分析的工作簿范围如下", 1)})
	}
	if len(previews) > 0 {
		conversation = append(conversation, map[string]any{"role": "system", "content": "部分工作表的数据预览（TSV，第一列 row 为 0-based 数据行号；预览不完整时用工具读取全部数据）：\n\n" + strings.Join(previews, "\n\n")})
	}
	request := strings.TrimSpace(prompt)
	if request == "" {
		request = "总结关键指标、异常、趋势和下一步建议。"
	}
	conversation = append(conversation, map[string]any{"role": "user", "content": fmt.Sprintf("报告标题：%s\n分析要求：%s", title, request)})

	toolDefs := make([]openAIToolDefinition, 0, len(summaryAgentTools))
	for _, definition := range s.buildToolDefinitions() {
		if summaryAgentTools[definition.Function.Name] {
			toolDefs = append(toolDefs, definition)
		}
	}
	result, err := s.runAgentStream(ctx, &PreparedAgentStream{
		userID: userID, assistant: assistant, conversation: conversation, toolDefs: toolDefs,
	}, emit)
	if err != nil {
		return nil, err
	}
	var generated model.AISummaryContent
	if err := json.Unmarshal([]byte(extractJSONObject(result.Reply)), &generated); err != nil {
		return nil, fmt.Errorf("AI 汇总结果无法解析: %w", err)
	}
	generated.Metrics = limitSummaryMetrics(generated.Metrics, 8)
	generated.Sections = limitSummarySections(generated.Sections, summaryAgentMaxSections)
	for index := range generated.Sections {
		generated.Sections[index].Table = limitSummaryTable(generated.Sections[index].Table)
	}
	return &generated, nil
}

func limitSummaryTable(table *model.AISummaryTable) *model.AISummaryTable {
	if table == nil || len(table.Columns) == 0 {
		return nil
	}
	if len(table.Columns) > summaryMaxTableColumns {
		table.Columns = table.Columns[:summaryMaxTableColumns]
	}
	if len(table.Rows) > summaryMaxTableRows {
		table.Rows = table.Rows[:summaryMaxTableRows]
	}
	for index, row := range table.Rows {
		if len(row) > len(table.Columns) {
			table.Rows[index] = row[:len(table.Columns)]
		}
	}
	return table
}
