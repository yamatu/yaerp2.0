package service

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"yaerp/internal/model"
)

// Search uses a lightweight catalog, lazy workbook expansion, a request-scoped
// permission matrix, and SQL merging of row data + the latest Univer snapshot.
// Only bounded candidate pages cross the database boundary. Hidden candidates
// are redacted and rechecked, and do not prematurely end a page of visible hits.
const (
	sheetSearchDefaultLimit     = 20
	sheetSearchMaxLimit         = 100
	sheetSearchDefaultMaxSheets = 40
	sheetSearchMaxSheets        = 120
	sheetSearchMaxWorkbooks     = 200
)

type openSheetContext struct {
	WorkbookID        int64
	SheetIDs          []int64
	ActiveSheetID     int64
	SelectionStartRow *int
	SelectionEndRow   *int
	SelectionColumns  []string
}

func openSheetContextFromChatContext(chatContext *ChatContext) *openSheetContext {
	if chatContext == nil {
		return nil
	}
	context := &openSheetContext{SheetIDs: uniquePositiveInt64s(chatContext.SheetIDs, 48)}
	if chatContext.WorkbookID != nil && *chatContext.WorkbookID > 0 {
		context.WorkbookID = *chatContext.WorkbookID
	}
	if selection := chatContext.Selection; selection != nil && selection.SheetID > 0 {
		context.ActiveSheetID = selection.SheetID
		context.SelectionStartRow = selection.StartRow
		context.SelectionEndRow = selection.EndRow
		context.SelectionColumns = normalizeSearchKeywords(selection.ColumnKeys)
	}
	if context.ActiveSheetID == 0 && len(context.SheetIDs) > 0 {
		context.ActiveSheetID = context.SheetIDs[0]
	}
	if context.WorkbookID == 0 && context.ActiveSheetID == 0 && len(context.SheetIDs) == 0 {
		return nil
	}
	return context
}

func (context *openSheetContext) inject(args map[string]any) {
	if context == nil || args == nil {
		return
	}
	if context.WorkbookID > 0 {
		args["_open_workbook_id"] = context.WorkbookID
	}
	if len(context.SheetIDs) > 0 {
		args["_open_sheet_ids"] = context.SheetIDs
	}
	if context.ActiveSheetID > 0 {
		args["_open_active_sheet_id"] = context.ActiveSheetID
	}
	if context.SelectionStartRow != nil {
		args["_open_selection_start_row"] = *context.SelectionStartRow
	}
	if context.SelectionEndRow != nil {
		args["_open_selection_end_row"] = *context.SelectionEndRow
	}
	if len(context.SelectionColumns) > 0 {
		args["_open_selection_columns"] = context.SelectionColumns
	}
}

func openWorkbookIDArg(args map[string]any) int64 {
	if value, ok := toInt64(args["workbook_id"]); ok && value > 0 {
		return value
	}
	if value, ok := toInt64(args["_open_workbook_id"]); ok && value > 0 {
		return value
	}
	return 0
}

func openSheetIDsArg(args map[string]any) []int64 {
	return uniquePositiveInt64s(intSliceArg(args, "_open_sheet_ids"), 48)
}

func (s *AIService) toolGetOpenWorkbookContext(userID int64, args map[string]any) (*toolExecutionResult, error) {
	workbookID := openWorkbookIDArg(args)
	activeSheetID, _ := toInt64(args["_open_active_sheet_id"])
	if workbookID == 0 && activeSheetID > 0 {
		sheet, err := s.sheetRepo.GetSearchSheet(activeSheetID)
		if err != nil {
			return nil, err
		}
		workbookID = sheet.WorkbookID
	}
	data := map[string]any{"has_open_workbook": false}
	if workbookID == 0 {
		recent, _, err := s.sheetService.ListWorkbooks(userID, 1, 10)
		if err != nil {
			return nil, err
		}
		items := make([]map[string]any, 0, len(recent))
		for _, wb := range recent {
			items = append(items, map[string]any{"workbook_id": wb.ID, "workbook_name": wb.Name})
		}
		data["recent_workbooks"] = items
		data["hint"] = "没有打开的工作簿上下文；用 search_sheet_content(scope=all) 搜内容，或 search_spreadsheets 按名称定位。"
		return &toolExecutionResult{Data: data, Summary: "当前对话未携带打开的工作簿上下文"}, nil
	}
	workbook, err := s.getSearchWorkbook(userID, workbookID, s.permService.NewAccessScope())
	if err != nil {
		return nil, fmt.Errorf("读取当前工作簿失败: %w", err)
	}
	sheets := make([]map[string]any, 0, len(workbook.Sheets))
	touched := make([]int64, 0)
	for _, sheet := range workbook.Sheets {
		columns, err := parseSheetColumns(sheet.Columns)
		if err != nil {
			return nil, err
		}
		sheets = append(sheets, map[string]any{"sheet_id": sheet.ID, "sheet_name": sheet.Name,
			"columns": columns, "is_active": sheet.ID == activeSheetID})
		if sheet.ID == activeSheetID {
			data["active_sheet_id"], data["active_sheet_name"] = sheet.ID, sheet.Name
			touched = append(touched, sheet.ID)
		}
	}
	data["has_open_workbook"], data["source"] = true, "ui_context"
	data["workbook_id"], data["workbook_name"] = workbook.ID, workbook.Name
	data["sheets"], data["workbook_can_manage"] = sheets, workbook.CanManage
	selection := map[string]any{}
	for _, field := range []string{"start_row", "end_row"} {
		if value, ok := args["_open_selection_"+field]; ok {
			selection[field] = value
		}
	}
	if columns := stringSliceArg(args, "_open_selection_columns"); len(columns) > 0 {
		selection["column_keys"] = columns
	}
	if len(selection) > 0 && len(touched) > 0 {
		selection["sheet_id"] = activeSheetID
		data["selection"] = selection
	}
	return &toolExecutionResult{Data: data, TouchedSheetIDs: touched, Summary: "已识别当前打开的工作簿"}, nil
}

type sheetSearchCandidate struct {
	Sheet        *model.Sheet
	WorkbookID   int64
	WorkbookName string
	Tier         string
}

// planSheetSearchTargets is also used incrementally: plan one workbook only,
// search it, and do not even load the next catalog when the result limit is met.
func planSheetSearchTargets(scope string, openWorkbookID int64, requestedSheetIDs []int64, maxSheets int,
	openWorkbook, otherWorkbooks []sheetSearchCandidate,
) (targets []sheetSearchCandidate, skippedHidden int, budgetExhausted bool) {
	if maxSheets <= 0 {
		maxSheets = sheetSearchDefaultMaxSheets
	}
	restrict := make(map[int64]bool, len(requestedSheetIDs))
	for _, id := range requestedSheetIDs {
		restrict[id] = true
	}
	seen := map[int64]bool{}
	appendCandidates := func(candidates []sheetSearchCandidate, tier string) {
		for _, candidate := range candidates {
			if candidate.Sheet == nil || (len(restrict) > 0 && !restrict[candidate.Sheet.ID]) || seen[candidate.Sheet.ID] {
				continue
			}
			if candidate.Sheet.IsHidden {
				skippedHidden++
				continue
			}
			if len(targets) >= maxSheets {
				budgetExhausted = true
				return
			}
			candidate.Tier = tier
			targets = append(targets, candidate)
			seen[candidate.Sheet.ID] = true
		}
	}
	if openWorkbookID > 0 || len(openWorkbook) > 0 {
		appendCandidates(openWorkbook, "open_workbook")
	}
	if scope == "all" && !budgetExhausted {
		appendCandidates(otherWorkbooks, "other_workbooks")
	}
	return
}

func candidatesFromWorkbook(workbook *model.Workbook, tier string) []sheetSearchCandidate {
	candidates := make([]sheetSearchCandidate, 0, len(workbook.Sheets))
	for index := range workbook.Sheets {
		candidates = append(candidates, sheetSearchCandidate{Sheet: &workbook.Sheets[index],
			WorkbookID: workbook.ID, WorkbookName: workbook.Name, Tier: tier})
	}
	return candidates
}

func prioritizeSearchSheets(candidates []sheetSearchCandidate, activeSheetID int64) {
	sort.SliceStable(candidates, func(i, j int) bool {
		return candidates[i].Sheet.ID == activeSheetID && candidates[j].Sheet.ID != activeSheetID
	})
}

func (s *AIService) toolSearchSheetContent(userID int64, args map[string]any) (*toolExecutionResult, error) {
	started := time.Now()
	keywords := normalizeSearchKeywords(append(stringSliceArg(args, "keywords"), splitSearchQuery(args["query"])...))
	if len(keywords) == 0 {
		return nil, fmt.Errorf("keywords is required")
	}
	if len(keywords) > 20 {
		return nil, fmt.Errorf("最多支持 20 个检索关键词，请缩小条件")
	}
	mode := normalizeSearchMode(stringArgOr(args, "mode", "any"))
	columnKeys, returnColumns := stringSliceArg(args, "column_keys"), stringSliceArg(args, "return_columns")
	limit, _ := intArgWithDefault(args, "limit", sheetSearchDefaultLimit)
	if limit <= 0 {
		limit = sheetSearchDefaultLimit
	}
	limit = minInt(limit, sheetSearchMaxLimit)
	maxSheets, _ := intArgWithDefault(args, "max_sheets", sheetSearchDefaultMaxSheets)
	if maxSheets <= 0 {
		maxSheets = sheetSearchDefaultMaxSheets
	}
	maxSheets = minInt(maxSheets, sheetSearchMaxSheets)
	startRow, _ := intArgWithDefault(args, "start_row", 0)
	if startRow < 0 {
		startRow = 0
	}
	workbookID := openWorkbookIDArg(args)
	if workbookID == 0 {
		activeID, _ := toInt64(args["_open_active_sheet_id"])
		if activeID > 0 {
			sheet, err := s.sheetRepo.GetSearchSheet(activeID)
			if err != nil {
				return nil, err
			}
			workbookID = sheet.WorkbookID
		}
	}
	requestedIDs := uniquePositiveInt64s(intSliceArg(args, "sheet_ids"), 64)
	if id, ok := toInt64(args["sheet_id"]); ok && id > 0 {
		requestedIDs = []int64{id}
	}
	workbookName := strings.TrimSpace(stringArgOr(args, "workbook_name", ""))
	sheetName := strings.TrimSpace(stringArgOr(args, "sheet_name", ""))
	scope := strings.ToLower(strings.TrimSpace(stringArgOr(args, "scope", "")))
	if scope == "" {
		scope = "all"
		if workbookID > 0 && workbookName == "" {
			scope = "current"
		}
	}
	if scope != "all" && scope != "current" && scope != "workbook" {
		return nil, fmt.Errorf("scope must be one of current, workbook, all")
	}
	if scope != "all" && workbookID == 0 && len(requestedIDs) == 0 {
		return nil, fmt.Errorf("scope=%s 需要 workbook_id 或当前打开的工作簿上下文", scope)
	}
	access := s.permService.NewAccessScope()
	matches := make([]map[string]any, 0, limit)
	touched := make([]int64, 0)
	seenWorkbooks := map[int64]bool{}
	seenSheets := map[int64]bool{}
	primaryName := ""
	hasMore, budgetHit, candidateBudgetHit := false, false, false
	tierCounts := map[string]int{}
	var nextStartRow any
	var nextSheetID any

	scanWorkbook := func(id int64, tier string) (bool, error) {
		if seenWorkbooks[id] {
			return false, nil
		}
		seenWorkbooks[id] = true
		workbook, err := s.getSearchWorkbook(userID, id, access)
		if err != nil {
			return false, err
		}
		if id == workbookID {
			primaryName = workbook.Name
		}
		if workbookName != "" && !strings.Contains(strings.ToLower(workbook.Name), strings.ToLower(workbookName)) {
			return false, nil
		}
		candidates := candidatesFromWorkbook(workbook, tier)
		activeID, _ := toInt64(args["_open_active_sheet_id"])
		prioritizeSearchSheets(candidates, activeID)
		if sheetName != "" {
			filtered := candidates[:0]
			for _, candidate := range candidates {
				if strings.Contains(strings.ToLower(candidate.Sheet.Name), strings.ToLower(sheetName)) {
					filtered = append(filtered, candidate)
				}
			}
			candidates = filtered
		}
		targets, _, catalogTruncated := planSheetSearchTargets("current", id, requestedIDs, sheetSearchMaxSheets+1, candidates, nil)
		if catalogTruncated {
			hasMore = true
		}
		for index, target := range targets {
			sheet := target.Sheet
			if seenSheets[sheet.ID] || (sheetName != "" && !strings.Contains(strings.ToLower(sheet.Name), strings.ToLower(sheetName))) {
				continue
			}
			columns, err := parseSheetColumns(sheet.Columns)
			if err != nil {
				return false, err
			}
			columnFilter := resolveColumnKeyFilter(columns, columnKeys)
			if len(columnKeys) > 0 && len(columnFilter) == 0 {
				continue
			}
			if len(touched) >= maxSheets {
				budgetHit, hasMore = true, true
				return true, nil
			}
			seenSheets[sheet.ID] = true
			touched = append(touched, sheet.ID)
			page, err := s.searchVisibleSheetRows(userID, sheet, columns, keywords, mode, columnFilter,
				startRow, limit-len(matches), access)
			if err != nil {
				return false, err
			}
			for _, row := range page.Rows {
				matches = append(matches, map[string]any{
					"workbook_id": id, "workbook_name": workbook.Name,
					"sheet_id": sheet.ID, "sheet_name": sheet.Name,
					"row": row.Row, "source_row": row.SourceRow, "display_row": row.DisplayRow,
					"matches": collectRowKeywordMatches(restrictDataToColumns(row.Data, columnFilter), columns, keywords, mode),
					"data":    filterRowDataByColumns(row.Data, columns, returnColumns), "search_tier": tier,
				})
				tierCounts[tier]++
			}
			if page.HasMore {
				hasMore = true
				if page.NextRow > 0 {
					nextStartRow, nextSheetID = page.NextRow, sheet.ID
				}
			}
			if page.BudgetHit {
				candidateBudgetHit = true
			}
			if len(matches) >= limit {
				hasMore = hasMore || index+1 < len(targets) || (scope == "all" && len(requestedIDs) == 0)
				return true, nil
			}
		}
		return false, nil
	}

	stopped := false
	if len(requestedIDs) > 0 {
		// Current workbook first even when exact IDs span several workbooks.
		if workbookID > 0 {
			var err error
			stopped, err = scanWorkbook(workbookID, "open_workbook")
			if err != nil {
				return nil, err
			}
		}
		// Exact IDs never require listing the whole account. Resolve their parent
		// workbooks and still check permissions before any name/value is returned.
		for _, id := range requestedIDs {
			if stopped {
				hasMore = true
				break
			}
			sheet, err := s.sheetRepo.GetSearchSheet(id)
			if err != nil {
				return nil, err
			}
			if scope != "all" && workbookID > 0 && sheet.WorkbookID != workbookID {
				continue
			}
			tier := "other_workbooks"
			if sheet.WorkbookID == workbookID {
				tier = "open_workbook"
			}
			stopped, err = scanWorkbook(sheet.WorkbookID, tier)
			if err != nil {
				return nil, err
			}
			if stopped {
				break
			}
		}
	} else {
		if workbookID > 0 {
			var err error
			stopped, err = scanWorkbook(workbookID, "open_workbook")
			if err != nil {
				return nil, err
			}
		}
		// Lazy expansion is crucial: the previous implementation loaded all 200
		// workbook snapshots BEFORE searching even the first open-workbook cell.
		if scope == "all" && !stopped {
			workbooks, total, err := s.sheetService.ListWorkbooks(userID, 1, sheetSearchMaxWorkbooks)
			if err != nil {
				return nil, err
			}
			if total > int64(len(workbooks)) {
				hasMore = true
			}
			for _, wb := range workbooks {
				if seenWorkbooks[wb.ID] || (workbookName != "" && !strings.Contains(strings.ToLower(wb.Name), strings.ToLower(workbookName))) {
					continue
				}
				stopped, err = scanWorkbook(wb.ID, "other_workbooks")
				if err != nil {
					// A listing can include workbooks with no visible sheets. Do not
					// silently report a complete search after an unreadable workbook.
					hasMore = true
					continue
				}
				if stopped {
					break
				}
			}
		}
	}
	result := map[string]any{
		"keywords": keywords, "mode": mode, "scope": scope, "column_keys": columnKeys, "limit": limit,
		"matches": matches, "match_count": len(matches), "has_more": hasMore, "truncated": hasMore,
		"search_order": "open_workbook_first", "strategy": "snapshot_overlay_sql",
		"duration_ms": time.Since(started).Milliseconds(),
		"searched": map[string]any{"open_workbook_first": true, "open_workbook_id": workbookID,
			"open_workbook_name": primaryName, "sheets_scanned": len(touched), "workbooks_loaded": len(seenWorkbooks),
			"open_workbook_matches": tierCounts["open_workbook"], "other_workbook_matches": tierCounts["other_workbooks"],
			"budget_exhausted": budgetHit, "candidate_budget_exhausted": candidateBudgetHit},
	}
	if nextStartRow != nil {
		result["next_start_row"], result["next_sheet_id"] = nextStartRow, nextSheetID
	}
	if hasMore {
		result["next_hint"] = "检索尚未完成，不能据此判断数据不存在。指定 sheet_ids/workbook_name/sheet_name 缩小范围；有 next_sheet_id/next_start_row 时可用 search_sheet_rows 继续该表。"
	}
	return &toolExecutionResult{Data: result, TouchedSheetIDs: touched,
		Summary: fmt.Sprintf("在 %d 张表中找到 %d 条记录，当前工作簿 %d 条（%dms）", len(touched), len(matches), tierCounts["open_workbook"], time.Since(started).Milliseconds())}, nil
}

func resolveColumnKeyFilter(columns []sheetColumnPayload, references []string) map[string]struct{} {
	if len(references) == 0 {
		return nil
	}
	filter := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if key, _ := resolveColumnReference(reference, columns); key != "" {
			filter[key] = struct{}{}
		}
	}
	return filter
}

func restrictDataToColumns(data map[string]interface{}, filter map[string]struct{}) map[string]interface{} {
	if len(filter) == 0 {
		return data
	}
	restricted := make(map[string]interface{}, len(filter))
	for key := range filter {
		if value, ok := data[key]; ok {
			restricted[key] = value
		}
	}
	return restricted
}

func splitSearchQuery(value any) []string {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return nil
	}
	return normalizeSearchKeywords(strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == '，' || r == '\n' || r == '\t'
	}))
}

func intSliceArg(args map[string]any, key string) []int64 {
	switch typed := args[key].(type) {
	case []int64:
		return typed
	case []any:
		result := make([]int64, 0, len(typed))
		for _, item := range typed {
			if value, ok := toInt64(item); ok {
				result = append(result, value)
			}
		}
		return result
	case []float64:
		result := make([]int64, len(typed))
		for i, value := range typed {
			result[i] = int64(value)
		}
		return result
	}
	return nil
}

func stringArgOr(args map[string]any, key, fallback string) string {
	value, err := stringArgWithDefault(args, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}
