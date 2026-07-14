package service

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
)

type summaryMetricAccumulator struct {
	WorkbookName string
	SheetName    string
	ColumnName   string
	ColumnKey    string
	ColumnType   string
	Count        int
	Sum          float64
	Min          float64
	Max          float64
}

type summaryBuildResult struct {
	Content        model.AISummaryContent
	ModelPayload   map[string]any
	NumericMetrics []summaryMetricAccumulator
	VisibleRows    int
	VisibleSheets  int
}

type summaryRowScanner interface {
	Scan(dest ...any) error
}

func (s *AIService) GenerateAISummaryPage(userID int64, req *model.AISummaryGenerateRequest) (*model.AISummaryPage, error) {
	title := strings.TrimSpace(req.Title)
	if title == "" {
		return nil, fmt.Errorf("汇总标题不能为空")
	}
	workbookIDs := uniquePositiveInt64s(req.WorkbookIDs, 12)
	if len(workbookIDs) == 0 {
		return nil, fmt.Errorf("请至少选择一个工作簿")
	}

	build, err := s.buildAISummaryData(userID, title, workbookIDs)
	if err != nil {
		return nil, err
	}

	var assistant *activeAIAssistant
	requestedAssistantID := int64(0)
	if req.AssistantID != nil {
		requestedAssistantID = *req.AssistantID
	}
	assistant, assistantErr := s.resolveAIAssistant(requestedAssistantID)
	if requestedAssistantID > 0 && assistantErr != nil {
		return nil, assistantErr
	}
	if assistantErr == nil {
		if generated, err := s.generateAISummaryContent(assistant, title, req.Prompt, build.ModelPayload); err == nil {
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

	workbookJSON, err := json.Marshal(workbookIDs)
	if err != nil {
		return nil, fmt.Errorf("encode summary sources: %w", err)
	}
	contentJSON, err := json.Marshal(build.Content)
	if err != nil {
		return nil, fmt.Errorf("encode summary content: %w", err)
	}

	var assistantID *int64
	if assistant != nil && assistant.ID > 0 {
		value := assistant.ID
		assistantID = &value
	}
	var pageID int64
	err = s.db.QueryRow(
		`INSERT INTO ai_summary_pages (title, owner_id, assistant_id, source_workbook_ids, content)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		title,
		userID,
		assistantID,
		workbookJSON,
		contentJSON,
	).Scan(&pageID)
	if err != nil {
		return nil, fmt.Errorf("create AI summary page: %w", err)
	}

	return s.GetAISummaryPage(userID, pageID)
}

func (s *AIService) generateAISummaryContent(assistant *activeAIAssistant, title, prompt string, payload map[string]any) (*model.AISummaryContent, error) {
	contextJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("encode AI summary context: %w", err)
	}
	if len(contextJSON) > 140000 {
		return nil, fmt.Errorf("汇总数据过大，请减少工作簿范围")
	}

	systemPrompt := "你是 YaERP 经营数据分析助手。只能依据用户有权限查看的输入数据总结，不得猜测缺失数据。" +
		"只返回 JSON 对象，不要返回 Markdown。格式：" +
		`{"headline":"标题","overview":"总体结论","metrics":[{"label":"指标","value":"值","hint":"说明"}],"sections":[{"title":"章节","body":"正文","bullets":["要点"]}]}` +
		"。指标最多 8 个，章节最多 8 个；金额、数量和比例要说明来源工作簿或工作表。"
	if strings.TrimSpace(assistant.SystemPrompt) != "" {
		systemPrompt += "\n\n该助手的补充要求：\n" + strings.TrimSpace(assistant.SystemPrompt)
	}
	userPrompt := strings.TrimSpace(prompt)
	if userPrompt == "" {
		userPrompt = "请总结关键指标、异常、趋势和后续建议。"
	}

	response, err := s.callChatCompletion(assistant.Endpoint, assistant.APIKey, assistant.Model, []ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: fmt.Sprintf("页面标题：%s\n分析要求：%s\n\n可访问数据(JSON)：\n%s", title, userPrompt, string(contextJSON))},
	})
	if err != nil {
		return nil, err
	}

	content := extractJSONObject(response.Reply)
	var generated model.AISummaryContent
	if err := json.Unmarshal([]byte(content), &generated); err != nil {
		return nil, fmt.Errorf("AI 汇总结果无法解析: %w", err)
	}
	generated.Metrics = limitSummaryMetrics(generated.Metrics, 8)
	generated.Sections = limitSummarySections(generated.Sections, 8)
	return &generated, nil
}

func (s *AIService) buildAISummaryData(userID int64, title string, workbookIDs []int64) (*summaryBuildResult, error) {
	result := &summaryBuildResult{
		Content: model.AISummaryContent{
			Headline: title,
			Metrics:  make([]model.AISummaryMetric, 0),
			Sections: make([]model.AISummarySection, 0),
			Sources:  make([]model.AISummarySource, 0, len(workbookIDs)),
		},
		ModelPayload: map[string]any{"workbooks": make([]map[string]any, 0, len(workbookIDs))},
	}

	workbookPayloads := make([]map[string]any, 0, len(workbookIDs))
	for _, workbookID := range workbookIDs {
		workbook, err := s.sheetService.GetWorkbook(workbookID, userID)
		if err != nil {
			return nil, fmt.Errorf("工作簿 %d 不可访问: %w", workbookID, err)
		}

		source := model.AISummarySource{WorkbookID: workbook.ID, WorkbookName: workbook.Name, SheetNames: make([]string, 0, len(workbook.Sheets))}
		sheetPayloads := make([]map[string]any, 0, len(workbook.Sheets))
		sectionBullets := make([]string, 0, len(workbook.Sheets))

		for _, sheet := range workbook.Sheets {
			if result.VisibleSheets >= 48 {
				break
			}
			if err := s.ensureSheetViewAccess(userID, sheet.ID); err != nil {
				continue
			}
			rows, err := s.sheetRepo.GetRows(sheet.ID)
			if err != nil {
				return nil, fmt.Errorf("读取工作表 %s 失败: %w", sheet.Name, err)
			}
			columns, err := parseSheetColumns(sheet.Columns)
			if err != nil {
				return nil, err
			}
			visibleRows, err := s.buildVisiblePreviewRows(userID, &sheet, columns, rows)
			if err != nil {
				return nil, err
			}

			filteredRows := make([]map[string]any, 0, minInt(len(visibleRows), 40))
			visibleRowCount := 0
			for _, row := range visibleRows {
				if len(row.Data) == 0 {
					continue
				}
				visibleRowCount++
				if len(filteredRows) < 40 {
					filteredRows = append(filteredRows, map[string]any{
						"row":         row.Row,
						"display_row": row.DisplayRow,
						"data":        row.Data,
					})
				}
			}

			result.VisibleRows += visibleRowCount
			result.VisibleSheets++
			source.SheetNames = append(source.SheetNames, sheet.Name)
			sectionBullets = append(sectionBullets, fmt.Sprintf("%s：%d 条可见数据，%d 个字段", sheet.Name, visibleRowCount, len(columns)))
			result.NumericMetrics = append(result.NumericMetrics, collectSummaryNumericMetrics(workbook.Name, sheet.Name, columns, visibleRows)...)
			sheetPayloads = append(sheetPayloads, map[string]any{
				"sheet_id":   sheet.ID,
				"sheet_name": sheet.Name,
				"columns":    columns,
				"row_count":  visibleRowCount,
				"rows":       filteredRows,
			})
		}

		result.Content.Sources = append(result.Content.Sources, source)
		result.Content.Sections = append(result.Content.Sections, model.AISummarySection{
			Title:   workbook.Name,
			Body:    fmt.Sprintf("已读取 %d 张当前账号可访问的工作表。", len(source.SheetNames)),
			Bullets: sectionBullets,
		})
		workbookPayloads = append(workbookPayloads, map[string]any{
			"workbook_id":   workbook.ID,
			"workbook_name": workbook.Name,
			"sheets":        sheetPayloads,
		})
	}

	result.Content.Overview = fmt.Sprintf(
		"本页汇总了 %d 个工作簿、%d 张可访问工作表和 %d 条可见数据。所有内容均按当前账号权限生成。",
		len(result.Content.Sources),
		result.VisibleSheets,
		result.VisibleRows,
	)
	result.Content.Metrics = append(result.Content.Metrics,
		model.AISummaryMetric{Label: "工作簿", Value: strconv.Itoa(len(result.Content.Sources)), Hint: "本次汇总范围"},
		model.AISummaryMetric{Label: "工作表", Value: strconv.Itoa(result.VisibleSheets), Hint: "当前账号可访问"},
		model.AISummaryMetric{Label: "可见数据", Value: strconv.Itoa(result.VisibleRows), Hint: "已按单元格权限过滤"},
	)
	sort.Slice(result.NumericMetrics, func(i, j int) bool {
		return math.Abs(result.NumericMetrics[i].Sum) > math.Abs(result.NumericMetrics[j].Sum)
	})
	for _, metric := range result.NumericMetrics {
		if len(result.Content.Metrics) >= 8 {
			break
		}
		result.Content.Metrics = append(result.Content.Metrics, model.AISummaryMetric{
			Label: fmt.Sprintf("%s / %s", metric.SheetName, metric.ColumnName),
			Value: formatSummaryNumber(metric.Sum),
			Hint:  fmt.Sprintf("%s，共 %d 个可见数值", metric.WorkbookName, metric.Count),
		})
	}
	result.ModelPayload["workbooks"] = workbookPayloads
	result.ModelPayload["permission_note"] = "数据已按当前账号的工作表、行、列和单元格读取权限过滤"
	return result, nil
}

func collectSummaryNumericMetrics(workbookName, sheetName string, columns []sheetColumnPayload, rows []aiPreviewRow) []summaryMetricAccumulator {
	result := make([]summaryMetricAccumulator, 0)
	for _, column := range columns {
		columnType := strings.ToLower(strings.TrimSpace(column.Type))
		if columnType != "number" && columnType != "currency" && columnType != "percentage" {
			continue
		}
		metric := summaryMetricAccumulator{
			WorkbookName: workbookName,
			SheetName:    sheetName,
			ColumnName:   firstNonEmpty(column.Name, column.Key),
			ColumnKey:    column.Key,
			ColumnType:   columnType,
			Min:          math.Inf(1),
			Max:          math.Inf(-1),
		}
		for _, row := range rows {
			value, ok := row.Data[column.Key]
			if !ok {
				continue
			}
			number, ok := toFloat64(value)
			if !ok {
				continue
			}
			metric.Count++
			metric.Sum += number
			if number < metric.Min {
				metric.Min = number
			}
			if number > metric.Max {
				metric.Max = number
			}
		}
		if metric.Count > 0 {
			result = append(result, metric)
		}
	}
	return result
}

func (s *AIService) ListAISummaryPages(userID int64) ([]model.AISummaryPage, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	query := `SELECT p.id, p.title, p.owner_id, u.username,
	                 p.assistant_id, COALESCE(a.name, ''),
	                 p.source_workbook_ids, p.content, p.created_at, p.updated_at
	          FROM ai_summary_pages p
	          JOIN users u ON u.id = p.owner_id
	          LEFT JOIN ai_assistants a ON a.id = p.assistant_id`
	args := make([]any, 0, 1)
	if !isAdmin {
		query += ` WHERE p.owner_id = $1 OR EXISTS (
			SELECT 1 FROM channel_messages cm
			JOIN channels c ON c.id = cm.channel_id
			LEFT JOIN channel_members member ON member.channel_id = c.id AND member.user_id = $1
			WHERE cm.linked_summary_id = p.id AND (c.owner_id = $1 OR member.user_id IS NOT NULL)
		)`
		args = append(args, userID)
	}
	query += ` ORDER BY p.updated_at DESC, p.id DESC`

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list AI summary pages: %w", err)
	}
	defer rows.Close()
	pages := make([]model.AISummaryPage, 0)
	for rows.Next() {
		page, err := scanAISummaryPage(rows)
		if err != nil {
			return nil, err
		}
		if !isAdmin && page.OwnerID == userID {
			allowed, err := s.canAccessAISummarySources(userID, page.SourceWorkbookIDs)
			if err != nil {
				return nil, err
			}
			if !allowed {
				continue
			}
		}
		pages = append(pages, *page)
	}
	return pages, rows.Err()
}

func (s *AIService) GetAISummaryPage(userID, pageID int64) (*model.AISummaryPage, error) {
	page, err := scanAISummaryPage(s.db.QueryRow(
		`SELECT p.id, p.title, p.owner_id, u.username,
		        p.assistant_id, COALESCE(a.name, ''),
		        p.source_workbook_ids, p.content, p.created_at, p.updated_at
		 FROM ai_summary_pages p
		 JOIN users u ON u.id = p.owner_id
		 LEFT JOIN ai_assistants a ON a.id = p.assistant_id
		 WHERE p.id = $1`,
		pageID,
	))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("AI 汇总页面不存在")
	}
	if err != nil {
		return nil, err
	}
	if page.OwnerID != userID {
		isAdmin, err := s.permService.IsAdmin(userID)
		if err != nil {
			return nil, err
		}
		if !isAdmin {
			shared, sharedErr := s.canAccessSharedAISummary(userID, page.ID)
			if sharedErr != nil {
				return nil, sharedErr
			}
			if shared {
				return page, nil
			}
			return nil, fmt.Errorf("没有权限访问该 AI 汇总页面")
		}
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		allowed, err := s.canAccessAISummarySources(userID, page.SourceWorkbookIDs)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, fmt.Errorf("来源工作簿权限已变更，当前账号不能继续查看该 AI 汇总页面")
		}
	}
	return page, nil
}

func (s *AIService) canAccessSharedAISummary(userID, pageID int64) (bool, error) {
	var allowed bool
	err := s.db.QueryRow(
		`SELECT EXISTS (
			SELECT 1 FROM channel_messages m
			JOIN channels c ON c.id = m.channel_id
			LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
			WHERE m.linked_summary_id = $2 AND (c.owner_id = $1 OR cm.user_id IS NOT NULL)
		)`,
		userID,
		pageID,
	).Scan(&allowed)
	return allowed, err
}

func (s *AIService) canAccessAISummarySources(userID int64, workbookIDs []int64) (bool, error) {
	if len(workbookIDs) == 0 {
		return false, nil
	}
	for _, workbookID := range workbookIDs {
		if _, err := s.sheetService.GetWorkbook(workbookID, userID); err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "not found") || errors.Is(err, ErrWorkbookAccessDenied) {
				return false, nil
			}
			return false, err
		}
	}
	return true, nil
}

func (s *AIService) UpdateAISummaryPage(userID, pageID int64, req *model.AISummaryUpdateRequest) (*model.AISummaryPage, error) {
	current, err := s.GetAISummaryPage(userID, pageID)
	if err != nil {
		return nil, err
	}
	if current.OwnerID != userID {
		isAdmin, adminErr := s.permService.IsAdmin(userID)
		if adminErr != nil || !isAdmin {
			return nil, fmt.Errorf("只有总结创建者或管理员可以编辑")
		}
	}
	title := current.Title
	if req.Title != nil {
		title = strings.TrimSpace(*req.Title)
		if title == "" {
			return nil, fmt.Errorf("汇总标题不能为空")
		}
	}
	content := current.Content
	if req.Content != nil {
		content = *req.Content
		content.Sources = current.Content.Sources
		content.Metrics = limitSummaryMetrics(content.Metrics, 12)
		content.Sections = limitSummarySections(content.Sections, 12)
	}
	encoded, err := json.Marshal(content)
	if err != nil {
		return nil, fmt.Errorf("encode summary content: %w", err)
	}
	if _, err := s.db.Exec(
		`UPDATE ai_summary_pages SET title = $2, content = $3, updated_at = NOW() WHERE id = $1`,
		pageID,
		title,
		encoded,
	); err != nil {
		return nil, fmt.Errorf("update AI summary page: %w", err)
	}
	return s.GetAISummaryPage(userID, pageID)
}

func (s *AIService) DeleteAISummaryPage(userID, pageID int64) error {
	current, err := s.GetAISummaryPage(userID, pageID)
	if err != nil {
		return err
	}
	if current.OwnerID != userID {
		isAdmin, adminErr := s.permService.IsAdmin(userID)
		if adminErr != nil || !isAdmin {
			return fmt.Errorf("只有总结创建者或管理员可以删除")
		}
	}
	_, err = s.db.Exec(`DELETE FROM ai_summary_pages WHERE id = $1`, pageID)
	if err != nil {
		return fmt.Errorf("delete AI summary page: %w", err)
	}
	return nil
}

func scanAISummaryPage(scanner summaryRowScanner) (*model.AISummaryPage, error) {
	var page model.AISummaryPage
	var workbookJSON []byte
	var contentJSON []byte
	if err := scanner.Scan(
		&page.ID,
		&page.Title,
		&page.OwnerID,
		&page.OwnerName,
		&page.AssistantID,
		&page.AssistantName,
		&workbookJSON,
		&contentJSON,
		&page.CreatedAt,
		&page.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(workbookJSON, &page.SourceWorkbookIDs); err != nil {
		return nil, fmt.Errorf("decode summary sources: %w", err)
	}
	if err := json.Unmarshal(contentJSON, &page.Content); err != nil {
		return nil, fmt.Errorf("decode summary content: %w", err)
	}
	return &page, nil
}

func (s *AIService) CreateFinancialReportWorkbook(userID int64, name string, sourceSheetIDs []int64) (int64, int64, int, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = fmt.Sprintf("财务分析报表 %s", time.Now().Format("2006-01-02"))
	}
	sourceSheetIDs = uniquePositiveInt64s(sourceSheetIDs, 30)
	if len(sourceSheetIDs) == 0 {
		return 0, 0, 0, fmt.Errorf("请至少提供一张来源工作表")
	}

	metrics := make([]summaryMetricAccumulator, 0)
	rowCounts := make([]summaryMetricAccumulator, 0, len(sourceSheetIDs))
	for _, sheetID := range sourceSheetIDs {
		if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
			return 0, 0, 0, fmt.Errorf("工作表 %d 不可访问: %w", sheetID, err)
		}
		sheet, err := s.sheetRepo.GetSheet(sheetID)
		if err != nil {
			return 0, 0, 0, err
		}
		workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
		if err != nil {
			return 0, 0, 0, err
		}
		rows, err := s.sheetRepo.GetRows(sheetID)
		if err != nil {
			return 0, 0, 0, err
		}
		columns, err := parseSheetColumns(sheet.Columns)
		if err != nil {
			return 0, 0, 0, err
		}
		visibleRows, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
		if err != nil {
			return 0, 0, 0, err
		}
		visibleCount := 0
		for _, row := range visibleRows {
			if len(row.Data) > 0 {
				visibleCount++
			}
		}
		rowCounts = append(rowCounts, summaryMetricAccumulator{
			WorkbookName: workbook.Name,
			SheetName:    sheet.Name,
			ColumnName:   "可见数据行",
			ColumnKey:    "visible_rows",
			ColumnType:   "number",
			Count:        visibleCount,
			Sum:          float64(visibleCount),
			Min:          float64(visibleCount),
			Max:          float64(visibleCount),
		})
		metrics = append(metrics, collectSummaryNumericMetrics(workbook.Name, sheet.Name, columns, visibleRows)...)
	}
	if len(metrics) == 0 {
		metrics = rowCounts
	}

	description := "由 AI 助手按当前账号读取权限生成的财务分析工作簿"
	sourceIDsJSON, _ := json.Marshal(sourceSheetIDs)
	metadata := json.RawMessage(fmt.Sprintf(`{"generatedBy":"ai_financial_report","sourceSheetIds":%s,"generatedAt":%q}`, sourceIDsJSON, time.Now().Format(time.RFC3339)))
	workbook := &model.Workbook{Name: name, Description: &description, OwnerID: userID, Metadata: metadata}
	if err := s.sheetService.CreateWorkbookForUser(userID, workbook); err != nil {
		return 0, 0, 0, err
	}

	columns := []sheetColumnPayload{
		{Key: "source_workbook", Name: "来源工作簿", Type: "text", Width: 180},
		{Key: "source_sheet", Name: "来源工作表", Type: "text", Width: 180},
		{Key: "metric", Name: "指标", Type: "text", Width: 180},
		{Key: "records", Name: "数值数", Type: "number", Width: 110},
		{Key: "total", Name: "合计", Type: "currency", Width: 140},
		{Key: "average", Name: "平均值", Type: "currency", Width: 140},
		{Key: "minimum", Name: "最小值", Type: "currency", Width: 140},
		{Key: "maximum", Name: "最大值", Type: "currency", Width: 140},
	}
	columnJSON, _ := json.Marshal(columns)
	reportSheet := &model.Sheet{WorkbookID: workbook.ID, Name: "财务汇总", Columns: columnJSON}
	if err := s.sheetService.CreateSheetForUser(userID, reportSheet); err != nil {
		return workbook.ID, 0, 0, err
	}

	for index, metric := range metrics {
		average := 0.0
		if metric.Count > 0 {
			average = metric.Sum / float64(metric.Count)
		}
		row := map[string]any{
			"source_workbook": metric.WorkbookName,
			"source_sheet":    metric.SheetName,
			"metric":          metric.ColumnName,
			"records":         metric.Count,
			"total":           metric.Sum,
			"average":         average,
			"minimum":         metric.Min,
			"maximum":         metric.Max,
		}
		encoded, _ := json.Marshal(row)
		if err := s.sheetRepo.UpsertRow(reportSheet.ID, index, encoded, userID); err != nil {
			return workbook.ID, reportSheet.ID, index, err
		}
	}

	return workbook.ID, reportSheet.ID, len(metrics), nil
}

func extractJSONObject(value string) string {
	content := strings.TrimSpace(value)
	if strings.HasPrefix(content, "```") {
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSpace(strings.TrimPrefix(content, "json"))
		content = strings.TrimSpace(strings.TrimSuffix(content, "```"))
	}
	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start >= 0 && end > start {
		return content[start : end+1]
	}
	return content
}

func uniquePositiveInt64s(values []int64, limit int) []int64 {
	result := make([]int64, 0, minInt(len(values), limit))
	seen := make(map[int64]struct{}, len(values))
	for _, value := range values {
		if value <= 0 {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
		if len(result) >= limit {
			break
		}
	}
	return result
}

func limitSummaryMetrics(items []model.AISummaryMetric, limit int) []model.AISummaryMetric {
	if len(items) <= limit {
		return items
	}
	return items[:limit]
}

func limitSummarySections(items []model.AISummarySection, limit int) []model.AISummarySection {
	if len(items) <= limit {
		return items
	}
	return items[:limit]
}

func formatSummaryNumber(value float64) string {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "0"
	}
	formatted := strconv.FormatFloat(value, 'f', 2, 64)
	formatted = strings.TrimRight(strings.TrimRight(formatted, "0"), ".")
	if formatted == "-0" || formatted == "" {
		return "0"
	}
	return formatted
}
