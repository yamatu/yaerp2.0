package service

import (
	"fmt"
	"strings"
	"time"

	"yaerp/internal/model"
)

// The spreadsheet agent used to answer "where is X?" by walking every accessible
// workbook, loading every row of every sheet into Go, and checking each cell
// against the account's cell permissions. That path is O(all data), so it became
// unusably slow as an account accumulated workbooks.
//
// The tools in this file make the same search cost proportional to what the
// employee is actually looking at:
//
//  1. The workbook the employee currently has open in the UI is always searched
//     first, so the common "search what I am looking at" case never touches the
//     rest of the account.
//  2. Only with `scope=all` does the search fan out to the remaining accessible
//     workbooks, most recently updated first, under a hard sheet budget.
//  3. Searching stops as soon as the requested number of matches is found.
//  4. Rows that cannot match are rejected by a cheap value test before any
//     per-cell permission check runs.
//
// Data correctness is preserved: cell values live in two stores (the `rows`
// table, written by the API/AI paths, and the Univer snapshot in
// `sheets.config`, written by the spreadsheet UI). buildAIPreviewRows unions
// them, and every row still passes the same cell permission and protection
// filtering as query_sheet before it can be reported.

const (
	sheetSearchDefaultLimit     = 20
	sheetSearchMaxLimit         = 100
	sheetSearchDefaultMaxSheets = 40
	sheetSearchMaxSheets        = 120
	sheetSearchMaxWorkbooks     = 200
)

// openSheetContext is the workbook/sheet the employee currently has open in the
// UI. It is injected into every tool call so a tool can act on "the table I am
// looking at" without asking the model to guess an id.
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

// inject adds the open-workbook hints to a tool call's arguments. The keys are
// underscore prefixed so they can never collide with a model supplied argument
// name, and every tool must treat them as untrusted hints verified against
// permissions like any other id.
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

// openWorkbookIDArg resolves the workbook a search should start from: an explicit
// workbook_id wins, otherwise the workbook the employee has open in the UI.
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

// toolGetOpenWorkbookContext answers "which workbook is the employee looking at?"
// so the agent can act on the visible table before scanning anything else.
func (s *AIService) toolGetOpenWorkbookContext(userID int64, args map[string]any) (*toolExecutionResult, error) {
	workbookID := openWorkbookIDArg(args)
	openSheetIDs := openSheetIDsArg(args)
	activeSheetID := int64(0)
	if value, ok := toInt64(args["_open_active_sheet_id"]); ok {
		activeSheetID = value
	}

	recent, _, err := s.sheetService.ListWorkbooks(userID, 1, 10)
	if err != nil {
		return nil, err
	}
	recentItems := make([]map[string]any, 0, len(recent))
	for _, workbook := range recent {
		recentItems = append(recentItems, map[string]any{
			"workbook_id":   workbook.ID,
			"workbook_name": workbook.Name,
			"updated_at":    workbook.UpdatedAt,
		})
	}

	data := map[string]any{
		"has_open_workbook": false,
		"recent_workbooks":  recentItems,
	}
	if workbookID == 0 && activeSheetID == 0 && len(openSheetIDs) == 0 {
		data["hint"] = "当前对话没有携带界面上下文；请先询问员工正在查看哪个工作簿，或使用 search_sheet_content 并设置 scope=all。"
		return &toolExecutionResult{
			Data:    data,
			Summary: "当前对话未携带打开的工作簿上下文",
		}, nil
	}

	data["has_open_workbook"] = true
	data["source"] = "ui_context"

	if workbookID > 0 {
		workbook, err := s.sheetService.GetWorkbook(workbookID, userID)
		if err != nil {
			return nil, fmt.Errorf("读取当前打开的工作簿失败: %w", err)
		}
		sheets := make([]map[string]any, 0, len(workbook.Sheets))
		for _, sheet := range workbook.Sheets {
			columns, _ := parseSheetColumns(sheet.Columns)
			sheets = append(sheets, map[string]any{
				"sheet_id":   sheet.ID,
				"sheet_name": sheet.Name,
				"columns":    columns,
				"is_active":  sheet.ID == activeSheetID,
			})
		}
		data["workbook_id"] = workbook.ID
		data["workbook_name"] = workbook.Name
		data["workbook_can_manage"] = workbook.CanManage
		data["sheets"] = sheets
	}
	if len(openSheetIDs) > 0 {
		data["open_sheet_ids"] = openSheetIDs
	}
	if activeSheetID > 0 {
		data["active_sheet_id"] = activeSheetID
		if sheet, err := s.sheetRepo.GetSheet(activeSheetID); err == nil {
			data["active_sheet_name"] = sheet.Name
		}
	}
	selection := map[string]any{}
	if value, ok := args["_open_selection_start_row"]; ok {
		selection["start_row"] = value
	}
	if value, ok := args["_open_selection_end_row"]; ok {
		selection["end_row"] = value
	}
	if columns := stringSliceArg(args, "_open_selection_columns"); len(columns) > 0 {
		selection["column_keys"] = columns
	}
	if len(selection) > 0 {
		selection["sheet_id"] = activeSheetID
		data["selection"] = selection
	}

	return &toolExecutionResult{
		Data:            data,
		TouchedSheetIDs: openSheetIDs,
		Summary:         "已识别当前打开的工作簿",
	}, nil
}

// sheetSearchCandidate is one sheet that a content search may have to read.
type sheetSearchCandidate struct {
	Sheet        *model.Sheet
	WorkbookID   int64
	WorkbookName string
	Tier         string
}

// planSheetSearchTargets decides which sheets a search touches, and in what
// order. The workbook the employee has open always comes first, hidden sheets
// are skipped, and the total number of sheets is capped so an account with
// thousands of sheets cannot turn one question into a full account scan.
func planSheetSearchTargets(
	scope string,
	openWorkbookID int64,
	requestedSheetIDs []int64,
	maxSheets int,
	openWorkbook []sheetSearchCandidate,
	otherWorkbooks []sheetSearchCandidate,
) (targets []sheetSearchCandidate, skippedHidden int, budgetExhausted bool) {
	if maxSheets <= 0 {
		maxSheets = sheetSearchDefaultMaxSheets
	}
	restrict := make(map[int64]struct{}, len(requestedSheetIDs))
	for _, sheetID := range requestedSheetIDs {
		restrict[sheetID] = struct{}{}
	}
	seen := make(map[int64]struct{})

	appendCandidates := func(candidates []sheetSearchCandidate, tier string) {
		for _, candidate := range candidates {
			if candidate.Sheet == nil {
				continue
			}
			if len(restrict) > 0 {
				if _, ok := restrict[candidate.Sheet.ID]; !ok {
					continue
				}
			}
			if candidate.Sheet.IsHidden {
				skippedHidden++
				continue
			}
			if _, ok := seen[candidate.Sheet.ID]; ok {
				continue
			}
			if len(targets) >= maxSheets {
				budgetExhausted = true
				return
			}
			entry := candidate
			entry.Tier = tier
			targets = append(targets, entry)
			seen[candidate.Sheet.ID] = struct{}{}
		}
	}

	if openWorkbookID > 0 || len(openWorkbook) > 0 {
		appendCandidates(openWorkbook, "open_workbook")
	}
	if scope == "all" && !budgetExhausted {
		appendCandidates(otherWorkbooks, "other_workbooks")
	}
	return targets, skippedHidden, budgetExhausted
}

func candidatesFromWorkbook(workbook *model.Workbook, tier string) []sheetSearchCandidate {
	candidates := make([]sheetSearchCandidate, 0, len(workbook.Sheets))
	for index := range workbook.Sheets {
		candidates = append(candidates, sheetSearchCandidate{
			Sheet:        &workbook.Sheets[index],
			WorkbookID:   workbook.ID,
			WorkbookName: workbook.Name,
			Tier:         tier,
		})
	}
	return candidates
}

// toolSearchSheetContent is the tiered spreadsheet search.
//
// It searches the workbook the employee has open first, stops at `limit`
// matches, and only fans out to the remaining accessible workbooks (most
// recently updated first) when scope=all.
func (s *AIService) toolSearchSheetContent(userID int64, args map[string]any) (*toolExecutionResult, error) {
	startedAt := time.Now()

	keywords := normalizeSearchKeywords(append(stringSliceArg(args, "keywords"), splitSearchQuery(args["query"])...))
	if len(keywords) == 0 {
		return nil, fmt.Errorf("keywords is required")
	}
	mode := normalizeSearchMode(stringArgOr(args, "mode", "any"))
	returnColumns := stringSliceArg(args, "return_columns")
	columnKeys := normalizeSearchKeywords(stringSliceArg(args, "column_keys"))

	limit, _ := intArgWithDefault(args, "limit", sheetSearchDefaultLimit)
	if limit <= 0 {
		limit = sheetSearchDefaultLimit
	}
	if limit > sheetSearchMaxLimit {
		limit = sheetSearchMaxLimit
	}
	maxSheets, _ := intArgWithDefault(args, "max_sheets", sheetSearchDefaultMaxSheets)
	if maxSheets <= 0 {
		maxSheets = sheetSearchDefaultMaxSheets
	}
	if maxSheets > sheetSearchMaxSheets {
		maxSheets = sheetSearchMaxSheets
	}

	openWorkbookID := openWorkbookIDArg(args)
	openSheetIDs := openSheetIDsArg(args)
	requestedSheetIDs := uniquePositiveInt64s(intSliceArg(args, "sheet_ids"), 64)

	scope := strings.ToLower(strings.TrimSpace(stringArgOr(args, "scope", "")))
	if scope == "" {
		if openWorkbookID > 0 {
			scope = "current"
		} else {
			scope = "all"
		}
	}
	switch scope {
	case "current", "workbook", "all":
	default:
		return nil, fmt.Errorf("scope must be one of current, workbook, all")
	}
	if scope == "workbook" && openWorkbookID == 0 {
		return nil, fmt.Errorf("scope=workbook 需要 workbook_id，或使用 scope=current 让工具读取当前打开的工作簿")
	}
	// The UI context lists the sheets the employee actually has open, so when no
	// explicit sheet_ids were given a "current" search stays inside them.
	if scope == "current" && len(requestedSheetIDs) == 0 && len(openSheetIDs) > 0 {
		requestedSheetIDs = openSheetIDs
	}

	openWorkbookName := ""
	var openWorkbookCandidates []sheetSearchCandidate
	if openWorkbookID > 0 {
		workbook, err := s.sheetService.GetWorkbook(openWorkbookID, userID)
		if err != nil {
			return nil, fmt.Errorf("读取当前工作簿失败: %w", err)
		}
		openWorkbookName = workbook.Name
		openWorkbookCandidates = candidatesFromWorkbook(workbook, "open_workbook")
	}

	var otherCandidates []sheetSearchCandidate
	if scope == "all" {
		workbooks, _, err := s.sheetService.ListWorkbooks(userID, 1, sheetSearchMaxWorkbooks)
		if err != nil {
			return nil, err
		}
		for _, workbook := range workbooks {
			if workbook.ID == openWorkbookID {
				continue
			}
			detail, err := s.sheetService.GetWorkbook(workbook.ID, userID)
			if err != nil {
				continue
			}
			otherCandidates = append(otherCandidates, candidatesFromWorkbook(detail, "other_workbooks")...)
		}
	}

	targets, skippedHidden, budgetExhausted := planSheetSearchTargets(
		scope, openWorkbookID, requestedSheetIDs, maxSheets, openWorkbookCandidates, otherCandidates,
	)

	searchedMeta := map[string]any{
		"open_workbook_first":    true,
		"open_workbook_id":       openWorkbookID,
		"open_workbook_name":     openWorkbookName,
		"sheets_planned":         len(targets),
		"sheets_scanned":         0,
		"sheets_skipped_hidden":  skippedHidden,
		"budget_exhausted":       budgetExhausted,
		"open_workbook_matches":  0,
		"other_workbook_matches": 0,
	}

	baseResult := func() map[string]any {
		return map[string]any{
			"keywords":     keywords,
			"mode":         mode,
			"scope":        scope,
			"column_keys":  columnKeys,
			"limit":        limit,
			"matches":      []map[string]any{},
			"match_count":  0,
			"has_more":     false,
			"searched":     searchedMeta,
			"search_order": "open_workbook_first",
		}
	}

	if len(targets) == 0 {
		result := baseResult()
		result["duration_ms"] = time.Since(startedAt).Milliseconds()
		return &toolExecutionResult{Data: result, Summary: "没有找到可检索的工作表"}, nil
	}

	matches := make([]map[string]any, 0, limit)
	tierCounts := map[string]int{}
	scannedSheets := make([]int64, 0, len(targets))
	truncated := false

scan:
	for _, target := range targets {
		sheet := target.Sheet
		columns, err := parseSheetColumns(sheet.Columns)
		if err != nil {
			continue
		}
		// An explicit column_keys filter is resolved per sheet, because the same
		// column name can map to different keys across workbooks. A sheet without
		// any of the requested columns has nothing to match.
		var columnFilter map[string]struct{}
		if len(columnKeys) > 0 {
			columnFilter = resolveColumnKeyFilter(columns, columnKeys)
			if len(columnFilter) == 0 {
				continue
			}
		}
		rows, err := s.sheetRepo.GetRows(sheet.ID)
		if err != nil {
			continue
		}
		scannedSheets = append(scannedSheets, sheet.ID)

		// buildAIPreviewRows unions the `rows` table with the Univer snapshot, so
		// values that only the spreadsheet UI has written are still searchable.
		previewRows := buildAIPreviewRows(sheet, columns, rows)
		// The cheap superset test runs before any permission work: filtering only
		// removes cells, so a row that cannot match here cannot match once filtered
		// either. This keeps the per-cell permission work proportional to the
		// matching rows instead of to the whole sheet.
		candidates := make([]aiPreviewRow, 0, len(previewRows))
		for _, row := range previewRows {
			if !rowDataMayContainKeywords(restrictDataToColumns(row.Data, columnFilter), keywords, mode) {
				continue
			}
			candidates = append(candidates, row)
		}
		if len(candidates) == 0 {
			continue
		}

		filter, err := s.buildSheetCellFilter(userID, sheet)
		if err != nil {
			return nil, err
		}
		for _, row := range candidates {
			if len(matches) >= limit {
				truncated = true
				break scan
			}
			visible, err := s.visibleRowData(userID, sheet.ID, row.Row, row.Data, filter)
			if err != nil {
				return nil, err
			}
			rowMatches := collectRowKeywordMatches(restrictDataToColumns(visible, columnFilter), columns, keywords, mode)
			if len(rowMatches) == 0 {
				// Everything that matched is redacted for this account.
				continue
			}
			matches = append(matches, map[string]any{
				"workbook_id":   target.WorkbookID,
				"workbook_name": target.WorkbookName,
				"sheet_id":      sheet.ID,
				"sheet_name":    sheet.Name,
				"row":           row.Row,
				"source_row":    row.SourceRow,
				"display_row":   row.DisplayRow,
				"matches":       rowMatches,
				"data":          filterRowDataByColumns(visible, columns, returnColumns),
				"search_tier":   target.Tier,
			})
			tierCounts[target.Tier]++
		}
	}

	searchedMeta["sheets_scanned"] = len(scannedSheets)
	searchedMeta["open_workbook_matches"] = tierCounts["open_workbook"]
	searchedMeta["other_workbook_matches"] = tierCounts["other_workbooks"]

	result := baseResult()
	result["matches"] = matches
	result["match_count"] = len(matches)
	result["has_more"] = truncated || budgetExhausted
	result["duration_ms"] = time.Since(startedAt).Milliseconds()
	if truncated {
		result["truncated"] = true
		result["next_hint"] = "结果已截断；请提高 limit、加 column_keys，或指定 workbook_id/sheet_ids 缩小范围后重试。"
	}
	if budgetExhausted {
		result["budget_exhausted"] = true
		result["next_hint"] = fmt.Sprintf("已达到 max_sheets=%d 的检索上限；请指定 workbook_id 或 sheet_ids 继续。", maxSheets)
	}

	summary := fmt.Sprintf("已在 %d 张工作表中找到 %d 条匹配记录（当前工作簿命中 %d 条，耗时 %dms）",
		len(scannedSheets), len(matches), tierCounts["open_workbook"], time.Since(startedAt).Milliseconds())

	return &toolExecutionResult{
		Data:            result,
		TouchedSheetIDs: scannedSheets,
		Summary:         summary,
	}, nil
}

// resolveColumnKeyFilter maps requested column references (key or display name)
// onto the column keys this sheet actually has. It returns nil when the caller
// did not ask for a restriction.
func resolveColumnKeyFilter(columns []sheetColumnPayload, references []string) map[string]struct{} {
	if len(references) == 0 {
		return nil
	}
	filter := make(map[string]struct{}, len(references))
	for _, reference := range references {
		if columnKey, _ := resolveColumnReference(reference, columns); columnKey != "" {
			filter[columnKey] = struct{}{}
		}
	}
	return filter
}

// restrictDataToColumns narrows a row to the requested columns. Filtering can
// only remove cells, which keeps the cheap keyword pre-test sound.
func restrictDataToColumns(data map[string]interface{}, filter map[string]struct{}) map[string]interface{} {
	if len(filter) == 0 {
		return data
	}
	restricted := make(map[string]interface{}, len(filter))
	for key, value := range data {
		if _, ok := filter[key]; ok {
			restricted[key] = value
		}
	}
	return restricted
}

func splitSearchQuery(value any) []string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return nil
	}
	// Accept both a plain phrase and a comma/newline separated shorthand.
	fields := strings.FieldsFunc(text, func(r rune) bool {
		return r == ',' || r == '，' || r == '\n' || r == '\t'
	})
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if trimmed := strings.TrimSpace(field); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	if len(result) == 0 {
		return []string{text}
	}
	return result
}

func intSliceArg(args map[string]any, key string) []int64 {
	value, ok := args[key]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []int64:
		return typed
	case []any:
		result := make([]int64, 0, len(typed))
		for _, item := range typed {
			if parsed, ok := toInt64(item); ok {
				result = append(result, parsed)
			}
		}
		return result
	case []float64:
		result := make([]int64, 0, len(typed))
		for _, item := range typed {
			result = append(result, int64(item))
		}
		return result
	default:
		return nil
	}
}

// stringArgOr reads an optional string argument and falls back instead of
// failing when the model sent the wrong type for an optional hint.
func stringArgOr(args map[string]any, key, fallback string) string {
	value, err := stringArgWithDefault(args, key, fallback)
	if err != nil {
		return fallback
	}
	return value
}
