package service

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

// ---------------------------------------------------------------------------
// Advanced spreadsheet editing tools
//
// These tools exist because the single-cell tools are too slow and too costly
// for real spreadsheet work: filling a column of 500 rows through `update_cell`
// needs 500 model turns. Every tool here works on a whole range in one call and
// reuses the same permission checks and write path as the simple tools.
// ---------------------------------------------------------------------------

const (
	// maxBatchCellUpdates keeps one tool call inside a sane transaction size.
	maxBatchCellUpdates = 2000
	// maxScriptRows bounds the row range a script may touch.
	maxScriptRows = 5000
	// maxSortRangeRows bounds sorting/filtering work.
	maxSortRangeRows = 20000
)

// batchCellUpdate is one row/column/value triple of a batch write.
type batchCellUpdate struct {
	Row       *int
	ColumnKey string
	Value     any
}

// ---------------------------------------------------------------------------
// batch_update_cells
// ---------------------------------------------------------------------------

// toolBatchUpdateCells writes a rectangular or sparse set of cells in one call.
//
// Two input shapes are accepted:
//
//	rows:    [{"row": 0, "values": {"qty": 3, "price": 12.5}}, ...]
//	updates: [{"row": 2, "column_key": "qty", "value": 3}, ...]
func (s *AIService) toolBatchUpdateCells(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetEditAccess(userID, sheetID); err != nil {
		return nil, err
	}

	updates, err := parseBatchCellUpdates(args)
	if err != nil {
		return nil, err
	}
	if len(updates) == 0 {
		return nil, fmt.Errorf("rows 或 updates 至少需要一项内容")
	}
	if len(updates) > maxBatchCellUpdates {
		return nil, fmt.Errorf("单次最多写入 %d 个单元格，本次 %d 个；请分批调用", maxBatchCellUpdates, len(updates))
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	if err := ensureZeroBasedSheetRows(rows); err != nil {
		return nil, err
	}
	totalRowsBefore := len(rows)
	disableFormula := boolArg(args, "disable_formula")

	cellUpdates := make([]model.CellUpdate, 0, len(updates))
	applied := make([]map[string]any, 0, len(updates))
	for index, update := range updates {
		if update.Row == nil || *update.Row < 0 {
			return nil, fmt.Errorf("第 %d 项必须提供非负的 row", index+1)
		}
		key, _ := resolveColumnReference(update.ColumnKey, columns)
		if key == "" {
			return nil, fmt.Errorf("第 %d 项的列 %q 不存在于工作表「%s」；可用列：%s", index+1, update.ColumnKey, sheet.Name, describeColumnKeys(columns))
		}
		if err := s.validateCellWriteAccess(userID, sheetID, *update.Row, key); err != nil {
			return nil, fmt.Errorf("第 %d 项（第 %d 行 %s）：%w", index+1, *update.Row+1, key, err)
		}
		raw, err := json.Marshal(update.Value)
		if err != nil {
			return nil, fmt.Errorf("第 %d 项的值无法序列化: %w", index+1, err)
		}
		cellUpdates = append(cellUpdates, model.CellUpdate{SheetID: sheetID, Row: *update.Row, Col: key, Value: raw})
		applied = append(applied, map[string]any{"row": *update.Row, "column_key": key, "value": update.Value})
	}

	writeResult, err := s.sheetService.UpdateCellsWithSourceOptions(userID, cellUpdates, "ai", CellUpdateOptions{AllowFormulaLiteral: disableFormula})
	if err != nil {
		return nil, err
	}
	cacheWarning := ""
	if len(writeResult.AppliedChanges) > 0 {
		if err := s.invalidateSheetByID(userID, sheetID); err != nil {
			cacheWarning = fmt.Sprintf("数据已写入，但刷新表格缓存失败：%v", err)
		}
	}

	// Post-write receipt: the agent must be able to see whether the write changed
	// the row domain or touched an unexpected column, instead of trusting a bare
	// "updated_cells" count.
	totalRowsAfter := totalRowsBefore
	if reloaded, err := s.sheetRepo.GetRows(sheetID); err == nil {
		totalRowsAfter = len(reloaded)
	}
	affectedColumns := distinctColumnKeys(writeResult.AppliedChanges)
	invariantsOK := totalRowsAfter >= totalRowsBefore
	postWriteInvariants := map[string]any{
		"total_rows_before": totalRowsBefore,
		"total_rows_after":  totalRowsAfter,
		"row_count_stable":  invariantsOK,
		"affected_columns":  affectedColumns,
	}

	pending := len(writeResult.PendingStates) > 0
	summary := fmt.Sprintf("已写入 %d 个单元格，%d 个等待审批（涉及 %d 行，总行数 %d→%d）", len(writeResult.AppliedChanges), len(applied)-len(writeResult.AppliedChanges), distinctRowCount(applied), totalRowsBefore, totalRowsAfter)
	if !invariantsOK {
		summary += "；警告：写入后总行数减少，请立即检查"
	}
	if cacheWarning != "" {
		summary += "；" + cacheWarning
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":                    true,
			"sheet_id":              sheetID,
			"updated_cells":         len(writeResult.AppliedChanges),
			"requested_cells":       len(applied),
			"updated_rows":          distinctRowCount(applied),
			"affected_columns":      affectedColumns,
			"total_rows_before":     totalRowsBefore,
			"total_rows_after":      totalRowsAfter,
			"invariants_ok":         invariantsOK,
			"post_write_invariants": postWriteInvariants,
			"pending_approval":      pending,
			"approval_states":       writeResult.PendingStates,
			"warning":               cacheWarning,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDsWhen(len(writeResult.AppliedChanges) > 0, sheetID),
		ResourcesChanged: pending,
		Summary:          summary,
	}, nil
}

// parseBatchCellUpdates accepts both the row-map and the flat update shape.
func parseBatchCellUpdates(args map[string]any) ([]batchCellUpdate, error) {
	updates := make([]batchCellUpdate, 0)
	if raw, ok := args["updates"].([]any); ok {
		for index, item := range raw {
			entry, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("updates[%d] 必须是对象", index)
			}
			row, err := intArg(entry, "row")
			if err != nil {
				return nil, fmt.Errorf("updates[%d]: %w", index, err)
			}
			columnKey, err := stringArg(entry, "column_key")
			if err != nil {
				return nil, fmt.Errorf("updates[%d]: %w", index, err)
			}
			value, exists := entry["value"]
			if !exists {
				return nil, fmt.Errorf("updates[%d] 缺少 value", index)
			}
			rowCopy := row
			updates = append(updates, batchCellUpdate{Row: &rowCopy, ColumnKey: columnKey, Value: value})
		}
	}
	if raw, ok := args["rows"].([]any); ok {
		for index, item := range raw {
			entry, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("rows[%d] 必须是对象", index)
			}
			row, err := intArg(entry, "row")
			if err != nil {
				return nil, fmt.Errorf("rows[%d]: %w", index, err)
			}
			values := mapArg(entry, "values")
			if len(values) == 0 {
				return nil, fmt.Errorf("rows[%d] 缺少 values（列 key 到值的映射）", index)
			}
			rowCopy := row
			keys := make([]string, 0, len(values))
			for key := range values {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				updates = append(updates, batchCellUpdate{Row: &rowCopy, ColumnKey: key, Value: values[key]})
			}
		}
	}
	return updates, nil
}

func distinctRowCount(applied []map[string]any) int {
	rows := map[int]struct{}{}
	for _, item := range applied {
		if row, ok := item["row"].(int); ok {
			rows[row] = struct{}{}
		}
	}
	return len(rows)
}

// distinctColumnKeys returns the sorted set of columns touched by a batch so
// the write receipt cannot hide an unexpected column.
func distinctColumnKeys(changes []model.CellUpdate) []string {
	keys := make(map[string]struct{}, len(changes))
	for _, change := range changes {
		if key := strings.TrimSpace(change.Col); key != "" {
			keys[key] = struct{}{}
		}
	}
	result := make([]string, 0, len(keys))
	for key := range keys {
		result = append(result, key)
	}
	sort.Strings(result)
	return result
}

// ---------------------------------------------------------------------------
// run_sheet_formulas
// ---------------------------------------------------------------------------

// toolRunSheetFormulas writes one formula per row of a column over a range.
// The `{{row}}` placeholder becomes the Excel row number and `{{column_key}}`
// becomes a reference to another column of the same row.
func (s *AIService) toolRunSheetFormulas(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	template, err := stringArg(args, "formula")
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.TrimSpace(template), "=") {
		template = "=" + strings.TrimSpace(template)
	}

	startRow, endRow, err := s.resolveSheetRowRange(userID, sheetID, args)
	if err != nil {
		return nil, err
	}
	if endRow-startRow+1 > maxScriptRows {
		return nil, fmt.Errorf("单次最多为 %d 行写入公式，本次 %d 行；请缩小范围", maxScriptRows, endRow-startRow+1)
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	key, _ := resolveColumnReference(columnKey, columns)
	if key == "" {
		return nil, fmt.Errorf("公式目标列 %q 不存在", columnKey)
	}
	if err := validateFormulaTemplateReferences(template, columns); err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	if err := ensureZeroBasedSheetRows(rows); err != nil {
		return nil, err
	}
	preview := buildAIPreviewRows(sheet, columns, rows)
	existing := make(map[int]bool, len(preview))
	for _, row := range preview {
		existing[row.Row] = true
	}
	updates := make([]model.CellUpdate, 0, endRow-startRow+1)
	for row := startRow; row <= endRow; row++ {
		if !existing[row] {
			return nil, fmt.Errorf("第 %d 行不存在；填充公式不会自动创建新行", row+1)
		}
		if err := s.validateCellWriteAccess(userID, sheetID, row, key); err != nil {
			return nil, fmt.Errorf("第 %d 行不可写: %w", row+1, err)
		}
		formula := expandFormulaTemplate(template, row, columns)
		raw, err := json.Marshal(formula)
		if err != nil {
			return nil, err
		}
		updates = append(updates, model.CellUpdate{SheetID: sheetID, Row: row, Col: key, Value: raw})
	}
	// The shared cell path enforces the same approval and history rules as
	// batch_update_cells; raw UpsertRow bypasses those rules and can half-fill.
	writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, updates, "ai")
	if err != nil {
		return nil, err
	}
	cacheWarning := ""
	if len(writeResult.AppliedChanges) > 0 {
		if err := s.invalidateSheetByID(userID, sheetID); err != nil {
			cacheWarning = fmt.Sprintf("数据已写入，但刷新表格缓存失败：%v", err)
		}
	}
	pending := len(writeResult.PendingStates) > 0
	summary := fmt.Sprintf("公式已写入 %d 行，%d 行等待审批", len(writeResult.AppliedChanges), len(updates)-len(writeResult.AppliedChanges))
	if cacheWarning != "" {
		summary += "；" + cacheWarning
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok": true, "sheet_id": sheetID, "column_key": key, "formula": template,
			"start_row": startRow, "end_row": endRow, "row_count": len(updates),
			"applied_cells": len(writeResult.AppliedChanges), "pending_approval": pending,
			"approval_states": writeResult.PendingStates, "warning": cacheWarning,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDsWhen(len(writeResult.AppliedChanges) > 0, sheetID),
		ResourcesChanged: pending,
		Summary:          summary,
	}, nil
}

// resolveSheetRowRange resolves an explicit or full-sheet row range and
// validates edit access on the sheet.
func (s *AIService) resolveSheetRowRange(userID, sheetID int64, args map[string]any) (int, int, error) {
	if err := s.ensureSheetEditAccess(userID, sheetID); err != nil {
		return 0, 0, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return 0, 0, err
	}
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return 0, 0, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return 0, 0, err
	}
	preview := buildAIPreviewRows(sheet, columns, rows)
	if len(preview) == 0 {
		return 0, 0, fmt.Errorf("工作表没有可编辑的数据行")
	}
	startRow, endRow := preview[0].Row, preview[len(preview)-1].Row
	if value, ok := intPtrArg(args, "start_row"); ok && value != nil {
		startRow = *value
	}
	if value, ok := intPtrArg(args, "end_row"); ok && value != nil {
		endRow = *value
	}
	if startRow < 0 || endRow < startRow || endRow > preview[len(preview)-1].Row {
		return 0, 0, fmt.Errorf("行范围无效：只能选择现有数据行 %d-%d", preview[0].Row, preview[len(preview)-1].Row)
	}
	return startRow, endRow, nil
}

// ---------------------------------------------------------------------------
// sort_sheet_range
// ---------------------------------------------------------------------------

// toolSortSheetRange reorders a contiguous block of data rows by one column.
// Sorting is implemented as a permutation of row values so the underlying row
// IDs (and therefore every permission and approval binding) stay untouched.
func (s *AIService) toolSortSheetRange(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	columnKey, err := stringArg(args, "column_key")
	if err != nil {
		return nil, err
	}
	descending := boolArg(args, "descending")

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetEditAccess(userID, sheetID); err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	key, _ := resolveColumnReference(columnKey, columns)
	if key == "" {
		return nil, fmt.Errorf("排序列 %q 不存在；可用列：%s", columnKey, describeColumnKeys(columns))
	}

	startRow, endRow, err := s.resolveSheetRowRange(userID, sheetID, args)
	if err != nil {
		return nil, err
	}
	if endRow-startRow+1 > maxSortRangeRows {
		return nil, fmt.Errorf("单次最多排序 %d 行，本次 %d 行", maxSortRangeRows, endRow-startRow+1)
	}

	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	if err := ensureZeroBasedSheetRows(rows); err != nil {
		return nil, err
	}
	values, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	// Compare unfiltered values with the permission-filtered preview. Moving
	// only visible cells while retaining a hidden column would split a record.
	cellUpdates, err := planSheetSort(sheetID, buildAIPreviewRows(sheet, columns, rows), values, columns, startRow, endRow, key, descending)
	if err != nil {
		return nil, err
	}
	if len(cellUpdates) == 0 {
		return &toolExecutionResult{
			Data:            map[string]any{"ok": true, "sheet_id": sheetID, "sorted": false},
			TouchedSheetIDs: []int64{sheetID}, Summary: "数据已经按该列排序，无需调整",
		}, nil
	}
	// A cached spreadsheet formula may appear to be an ordinary value in the
	// row preview. Until relative references can be translated correctly,
	// refuse to permute any sheet containing snapshot formulas.
	if hasSheetSnapshotFormulas(sheet.Config) {
		return nil, fmt.Errorf("工作表包含公式，直接排序会破坏公式引用；请先处理公式后再排序")
	}
	if len(cellUpdates) > maxBatchCellUpdates {
		return nil, fmt.Errorf("排序需要修改 %d 个单元格，超过单次上限 %d；请缩小范围", len(cellUpdates), maxBatchCellUpdates)
	}

	// A held approval could apply only part of a permutation. Reject before
	// invoking the approval interceptor rather than leaving mixed-up rows.
	if s.automationService != nil {
		hasApproval, err := s.automationService.repo.HasCellApprovalInRange(sheetID, startRow, endRow)
		if err != nil {
			return nil, err
		}
		if hasApproval {
			return nil, fmt.Errorf("排序范围内有审批记录，重排值会让审批记录指向错误的数据行")
		}
		rules, err := s.automationService.repo.ListEnabledRules("cell_change", &sheetID)
		if err != nil {
			return nil, err
		}
		for _, update := range cellUpdates {
			for i := range rules {
				if rules[i].HoldChanges && automationApprovalRangeMatches(&rules[i], update.Row, update.Col) {
					return nil, fmt.Errorf("排序区域包含待审批单元格 %s%d，无法安全地重排整行", update.Col, update.Row+2)
				}
			}
		}
	}
	for row := startRow; row <= endRow; row++ {
		if err := s.validateRowWriteAccess(userID, sheetID, row); err != nil {
			return nil, fmt.Errorf("第 %d 行不可写，排序未执行: %w", row+1, err)
		}
	}
	for _, update := range cellUpdates {
		if err := s.validateCellWriteAccess(userID, sheetID, update.Row, update.Col); err != nil {
			return nil, fmt.Errorf("第 %d 行 %s 不可写，排序未执行: %w", update.Row+1, update.Col, err)
		}
	}

	writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai")
	if err != nil {
		return nil, err
	}
	cacheWarning := ""
	if len(writeResult.AppliedChanges) > 0 {
		if err := s.invalidateSheetByID(userID, sheetID); err != nil {
			cacheWarning = fmt.Sprintf("数据已写入，但刷新表格缓存失败：%v", err)
		}
	}

	direction := "升序"
	if descending {
		direction = "降序"
	}
	pending := len(writeResult.PendingStates) > 0
	summary := fmt.Sprintf("已按 %s 列%s重排 %d 行", key, direction, endRow-startRow+1)
	if pending {
		summary = fmt.Sprintf("排序未全部生效：已写入 %d 格，%d 格等待审批；请完成审批后核对数据", len(writeResult.AppliedChanges), len(cellUpdates)-len(writeResult.AppliedChanges))
	}
	if cacheWarning != "" {
		summary += "；" + cacheWarning
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok": !pending, "sheet_id": sheetID, "column_key": key,
			"sorted": !pending, "start_row": startRow, "end_row": endRow,
			"row_count": endRow - startRow + 1, "pending_approval": pending,
			"approval_states": writeResult.PendingStates, "warning": cacheWarning,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDsWhen(len(writeResult.AppliedChanges) > 0, sheetID),
		ResourcesChanged: pending,
		Summary:          summary,
	}, nil
}

// ---------------------------------------------------------------------------
// filter_sheet_rows
// ---------------------------------------------------------------------------

// toolFilterSheetRows returns the rows matching a set of conditions without
// modifying anything, so the model can reason over a subset instead of paging
// through the whole sheet.
func (s *AIService) toolFilterSheetRows(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}
	conditions, err := parseFilterConditions(args)
	if err != nil {
		return nil, err
	}
	if len(conditions) == 0 {
		return nil, fmt.Errorf("conditions 至少需要一项，例如 [{\"column_key\":\"status\",\"op\":\"equals\",\"value\":\"已付款\"}]")
	}

	limit, _ := intArgWithDefault(args, "limit", 100)
	if limit <= 0 || limit > 500 {
		limit = 100
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	for index, condition := range conditions {
		key, _ := resolveColumnReference(condition.ColumnKey, columns)
		if key == "" {
			return nil, fmt.Errorf("conditions[%d] 的列 %q 不存在；可用列：%s", index, condition.ColumnKey, describeColumnKeys(columns))
		}
		conditions[index].ColumnKey = key
	}

	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	visible, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(conditions))
	for _, condition := range conditions {
		keys = append(keys, condition.ColumnKey)
	}
	if err := ensureReadColumnsVisible(buildAIPreviewRows(sheet, columns, rows), visible, keys); err != nil {
		return nil, err
	}

	matches := make([]map[string]any, 0, limit)
	total := 0
	for _, preview := range visible {
		if !sheetValuesMatch(preview.Data, conditions) {
			continue
		}
		total++
		if len(matches) >= limit {
			continue
		}
		entry := map[string]any{"row": preview.Row, "display_row": preview.DisplayRow}
		for key, value := range preview.Data {
			entry[key] = value
		}
		matches = append(matches, entry)
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":          true,
			"sheet_id":    sheetID,
			"match_count": total,
			"returned":    len(matches),
			"truncated":   total > len(matches),
			"rows":        matches,
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("按条件筛出 %d 行", total),
	}, nil
}

// filterCondition is one predicate of filter_sheet_rows and dedupe matching.
type filterCondition struct {
	ColumnKey string
	Op        string
	Value     any
}

func parseFilterConditions(args map[string]any) ([]filterCondition, error) {
	raw, ok := args["conditions"].([]any)
	if !ok {
		return nil, nil
	}
	conditions := make([]filterCondition, 0, len(raw))
	for index, item := range raw {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("conditions[%d] 必须是对象", index)
		}
		columnKey := strings.TrimSpace(fmt.Sprint(entry["column_key"]))
		if columnKey == "" || columnKey == "<nil>" {
			return nil, fmt.Errorf("conditions[%d] 缺少 column_key", index)
		}
		op := strings.ToLower(strings.TrimSpace(fmt.Sprint(entry["op"])))
		if op == "" || op == "<nil>" {
			op = "equals"
		}
		conditions = append(conditions, filterCondition{ColumnKey: columnKey, Op: op, Value: entry["value"]})
	}
	return conditions, nil
}

// sheetValuesMatch reports whether all conditions hold for one row.
func sheetValuesMatch(values map[string]any, conditions []filterCondition) bool {
	for _, condition := range conditions {
		actual := values[condition.ColumnKey]
		if !matchFilterCondition(actual, condition) {
			return false
		}
	}
	return true
}

func matchFilterCondition(actual any, condition filterCondition) bool {
	actualText := strings.TrimSpace(fmt.Sprint(normalizeComparableValue(actual)))
	expectedText := strings.TrimSpace(fmt.Sprint(normalizeComparableValue(condition.Value)))
	switch condition.Op {
	case "equals", "eq", "=", "等于":
		if actualNumber, ok := toFloat(actual); ok {
			if expectedNumber, ok := toFloat(condition.Value); ok {
				return actualNumber == expectedNumber
			}
		}
		return strings.EqualFold(actualText, expectedText)
	case "not_equals", "ne", "!=", "不等于":
		return !matchFilterCondition(actual, filterCondition{Op: "equals", Value: condition.Value})
	case "contains", "包含":
		return strings.Contains(strings.ToLower(actualText), strings.ToLower(expectedText))
	case "not_contains", "不包含":
		return !strings.Contains(strings.ToLower(actualText), strings.ToLower(expectedText))
	case "starts_with", "前缀":
		return strings.HasPrefix(strings.ToLower(actualText), strings.ToLower(expectedText))
	case "gt", ">", "大于":
		return compareSheetValues(actual, condition.Value) > 0
	case "gte", ">=", "大于等于":
		return compareSheetValues(actual, condition.Value) >= 0
	case "lt", "<", "小于":
		return compareSheetValues(actual, condition.Value) < 0
	case "lte", "<=", "小于等于":
		return compareSheetValues(actual, condition.Value) <= 0
	case "empty", "为空":
		return actualText == "" || actualText == "<nil>"
	case "not_empty", "非空":
		return actualText != "" && actualText != "<nil>"
	case "in", "属于":
		list, ok := condition.Value.([]any)
		if !ok {
			return false
		}
		for _, item := range list {
			if matchFilterCondition(actual, filterCondition{Op: "equals", Value: item}) {
				return true
			}
		}
		return false
	default:
		return strings.Contains(strings.ToLower(actualText), strings.ToLower(expectedText))
	}
}

// compareSheetValues orders two cell values: numbers numerically, everything
// else as a case-insensitive string.
func compareSheetValues(left, right any) int {
	leftNumber, leftOK := toFloat(left)
	rightNumber, rightOK := toFloat(right)
	if leftOK && rightOK {
		switch {
		case leftNumber < rightNumber:
			return -1
		case leftNumber > rightNumber:
			return 1
		default:
			return 0
		}
	}
	leftText := strings.ToLower(strings.TrimSpace(fmt.Sprint(normalizeComparableValue(left))))
	rightText := strings.ToLower(strings.TrimSpace(fmt.Sprint(normalizeComparableValue(right))))
	return strings.Compare(leftText, rightText)
}

// normalizeComparableValue unwraps common cell wrappers so comparisons work on
// both raw values and richer cell structures.
func normalizeComparableValue(value any) any {
	switch typed := value.(type) {
	case nil:
		return ""
	case map[string]any:
		for _, key := range []string{"value", "text", "label", "display"} {
			if inner, ok := typed[key]; ok {
				return normalizeComparableValue(inner)
			}
		}
		return fmt.Sprint(typed)
	case []any:
		parts := make([]string, 0, len(typed))
		for _, item := range typed {
			parts = append(parts, fmt.Sprint(normalizeComparableValue(item)))
		}
		return strings.Join(parts, ",")
	default:
		return value
	}
}

func toFloat(value any) (float64, bool) {
	switch typed := normalizeComparableValue(value).(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return 0, false
		}
		parsed, err := strconv.ParseFloat(trimmed, 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

// ---------------------------------------------------------------------------
// dedupe_sheet_rows
// ---------------------------------------------------------------------------

// toolDedupeSheetRows groups rows by a set of key columns and reports duplicate
// groups. With apply=false it only reports; with apply=true it fills the merge
// column on the kept row and clears it on the removed duplicates.
func (s *AIService) toolDedupeSheetRows(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return nil, err
	}
	keys := stringSliceArg(args, "key_columns")
	if len(keys) == 0 {
		return nil, fmt.Errorf("key_columns 至少需要一列，用于判断哪些行是重复的")
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	for index, reference := range keys {
		key, _ := resolveColumnReference(reference, columns)
		if key == "" {
			return nil, fmt.Errorf("key_columns[%d] 的列 %q 不存在；可用列：%s", index, reference, describeColumnKeys(columns))
		}
		keys[index] = key
	}

	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	visible, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	if err := ensureReadColumnsVisible(buildAIPreviewRows(sheet, columns, rows), visible, keys); err != nil {
		return nil, err
	}

	// Group row indexes by their key tuple, keeping the first occurrence as the
	// canonical row so the report is deterministic.
	type group struct {
		keep       int
		duplicates []int
	}
	groups := map[string]*group{}
	order := make([]string, 0)
	for _, preview := range visible {
		row, values := preview.Row, preview.Data
		parts := make([]string, 0, len(keys))
		empty := true
		for _, key := range keys {
			text := strings.ToLower(strings.TrimSpace(fmt.Sprint(normalizeComparableValue(values[key]))))
			if text != "" && text != "<nil>" {
				empty = false
			}
			parts = append(parts, text)
		}
		if empty {
			// Rows with no key at all are not duplicates of each other.
			continue
		}
		tuple := strings.Join(parts, "\x00")
		entry, exists := groups[tuple]
		if !exists {
			entry = &group{keep: row}
			groups[tuple] = entry
			order = append(order, tuple)
		} else {
			entry.duplicates = append(entry.duplicates, row)
		}
	}

	duplicateGroups := make([]map[string]any, 0)
	duplicateRows := make([]int, 0)
	for _, tuple := range order {
		entry := groups[tuple]
		if len(entry.duplicates) == 0 {
			continue
		}
		duplicateRows = append(duplicateRows, entry.duplicates...)
		duplicateGroups = append(duplicateGroups, map[string]any{
			"keep_row":       entry.keep,
			"duplicate_rows": entry.duplicates,
		})
	}

	apply := boolArg(args, "apply")
	mergeColumn, _ := stringArgWithDefault(args, "merge_column", "")
	appliedCells := 0
	cacheWarning := ""
	var approvalStates []model.CellApprovalState
	if apply && len(duplicateRows) > 0 {
		if err := ensureZeroBasedSheetRows(rows); err != nil {
			return nil, err
		}
		if len(duplicateRows) > maxBatchCellUpdates {
			return nil, fmt.Errorf("待清理 %d 行超过单次写入上限 %d", len(duplicateRows), maxBatchCellUpdates)
		}
		if mergeColumn == "" {
			return nil, fmt.Errorf("apply=true 时必须提供 merge_column，用于记录合并结果")
		}
		key, _ := resolveColumnReference(mergeColumn, columns)
		if key == "" {
			return nil, fmt.Errorf("merge_column %q 不存在；可用列：%s", mergeColumn, describeColumnKeys(columns))
		}
		if err := s.ensureSheetEditAccess(userID, sheetID); err != nil {
			return nil, err
		}
		cellUpdates := make([]model.CellUpdate, 0, len(duplicateRows))
		for _, row := range duplicateRows {
			if err := s.validateCellWriteAccess(userID, sheetID, row, key); err != nil {
				return nil, fmt.Errorf("第 %d 行不可写: %w", row+1, err)
			}
			raw, _ := json.Marshal("")
			cellUpdates = append(cellUpdates, model.CellUpdate{SheetID: sheetID, Row: row, Col: key, Value: raw})
		}
		writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai")
		if err != nil {
			return nil, err
		}
		appliedCells = len(writeResult.AppliedChanges)
		approvalStates = writeResult.PendingStates
		if appliedCells > 0 {
			if err := s.invalidateSheetByID(userID, sheetID); err != nil {
				cacheWarning = fmt.Sprintf("数据已写入，但刷新表格缓存失败：%v", err)
			}
		}
	}

	data := map[string]any{
		"ok":               true,
		"sheet_id":         sheetID,
		"key_columns":      keys,
		"duplicate_rows":   duplicateRows,
		"duplicate_count":  len(duplicateRows),
		"groups":           duplicateGroups,
		"applied":          appliedCells > 0 && appliedCells == len(duplicateRows),
		"applied_cells":    appliedCells,
		"pending_approval": len(approvalStates) > 0,
		"approval_states":  approvalStates,
		"warning":          cacheWarning,
	}
	summary := fmt.Sprintf("按 %s 发现 %d 行重复数据", strings.Join(keys, "+"), len(duplicateRows))
	if apply && len(duplicateRows) > 0 {
		summary = fmt.Sprintf("去重：已清理 %d 行，%d 行等待审批", appliedCells, len(duplicateRows)-appliedCells)
	}
	if cacheWarning != "" {
		summary += "；" + cacheWarning
	}
	return &toolExecutionResult{
		Data:             data,
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDsWhen(appliedCells > 0, sheetID),
		ResourcesChanged: len(approvalStates) > 0,
		Summary:          summary,
	}, nil
}

func changedSheetIDsWhen(condition bool, sheetID int64) []int64 {
	if condition {
		return []int64{sheetID}
	}
	return nil
}

// ---------------------------------------------------------------------------
// inspect_sheet_range
// ---------------------------------------------------------------------------

// toolInspectSheetRange describes the shape of a sheet: columns with their
// types, row count, an example value per column and the distinct values of
// selection columns. It removes the need to page through data before planning.
func (s *AIService) toolInspectSheetRange(userID int64, args map[string]any) (*toolExecutionResult, error) {
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
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	visible, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	allKeys := make([]string, 0, len(columns))
	for _, column := range columns {
		allKeys = append(allKeys, column.Key)
	}
	if err := ensureReadColumnsVisible(buildAIPreviewRows(sheet, columns, rows), visible, allKeys); err != nil {
		return nil, err
	}

	sampleLimit, _ := intArgWithDefault(args, "sample_values", 5)
	if sampleLimit <= 0 || sampleLimit > 20 {
		sampleLimit = 5
	}

	columnInfo := make([]map[string]any, 0, len(columns))
	for _, column := range columns {
		info := map[string]any{
			"key":  column.Key,
			"name": column.Name,
			"type": column.Type,
		}
		if len(column.Options) > 0 {
			options := make([]string, 0, len(column.Options))
			options = append(options, column.Options...)
			info["options"] = options
		}
		seen := map[string]struct{}{}
		samples := make([]string, 0, sampleLimit)
		emptyRows := 0
		for _, preview := range visible {
			text := strings.TrimSpace(fmt.Sprint(normalizeComparableValue(preview.Data[column.Key])))
			if text == "" || text == "<nil>" {
				emptyRows++
				continue
			}
			if _, exists := seen[text]; exists {
				continue
			}
			seen[text] = struct{}{}
			if len(samples) < sampleLimit {
				samples = append(samples, text)
			}
		}
		info["distinct_values"] = len(seen)
		info["sample_values"] = samples
		info["empty_rows"] = emptyRows
		columnInfo = append(columnInfo, info)
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":           true,
			"sheet_id":     sheetID,
			"sheet_name":   sheet.Name,
			"row_count":    len(visible),
			"column_count": len(columns),
			"columns":      columnInfo,
			"row_indexing": "rows[*].row 一律为 0-based 数据行索引（第一条数据行是 0），界面显示行号 = row + 2。",
		},
		TouchedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("工作表「%s」共 %d 行 %d 列", sheet.Name, len(visible), len(columns)),
	}, nil
}

// ---------------------------------------------------------------------------
// run_spreadsheet_script
// ---------------------------------------------------------------------------

// SpreadsheetScriptProgram is the intermediate representation of the script
// language. It is produced by parseSpreadsheetScript and executed step by step,
// which keeps the script surface tiny and fully validated before any write.
type SpreadsheetScriptProgram struct {
	Steps []SpreadsheetScriptStep `json:"steps"`
}

// SpreadsheetScriptStep is one statement of the script.
type SpreadsheetScriptStep struct {
	Op         string            `json:"op"`
	Column     string            `json:"column,omitempty"`
	Columns    []string          `json:"columns,omitempty"`
	Alias      string            `json:"alias,omitempty"`
	Formula    string            `json:"formula,omitempty"`
	Value      any               `json:"value,omitempty"`
	Condition  []filterCondition `json:"condition,omitempty"`
	Set        map[string]any    `json:"set,omitempty"`
	Descending bool              `json:"descending,omitempty"`
	Line       int               `json:"line,omitempty"`
}

// toolRunSpreadsheetScript executes a small, validated spreadsheet program:
//
//	select where status = "已付款"
//	filter where amount > 1000
//	sort by amount desc
//	compute total = SUM({{amount}})
//	set note = "已核对"
//
// Each line becomes one step. Nothing runs until every line parses and every
// referenced column and permission has been checked, so a typo cannot leave the
// sheet half-modified.
func (s *AIService) toolRunSpreadsheetScript(userID int64, args map[string]any) (*toolExecutionResult, error) {
	sheetID, err := int64Arg(args, "sheet_id")
	if err != nil {
		return nil, err
	}
	script, err := stringArg(args, "script")
	if err != nil {
		return nil, err
	}
	if err := s.ensureSheetEditAccess(userID, sheetID); err != nil {
		return nil, err
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}

	program, err := parseSpreadsheetScript(script)
	if err != nil {
		return nil, err
	}
	if len(program.Steps) == 0 {
		return nil, fmt.Errorf("script 至少需要一行可执行语句")
	}
	if len(program.Steps) > 32 {
		return nil, fmt.Errorf("script 最多 32 行语句，本次 %d 行", len(program.Steps))
	}

	// Validate every column reference before running anything.
	for index, step := range program.Steps {
		if strings.TrimSpace(step.Column) != "" && step.Op != "compute" {
			key, _ := resolveColumnReference(step.Column, columns)
			if key == "" {
				return nil, fmt.Errorf("第 %d 行引用的列 %q 不存在；可用列：%s", index+1, step.Column, describeColumnKeys(columns))
			}
			program.Steps[index].Column = key
		}
		if step.Op == "compute" {
			operation, argument, err := parseAggregateFormula(step.Formula)
			if err != nil {
				return nil, fmt.Errorf("第 %d 行: %w", index+1, err)
			}
			if argument == "" && (operation == "COUNT" || operation == "ROWS" || operation == "行数") {
				// Row counts need no source column; the left side is a report alias.
				program.Steps[index].Formula = operation
			} else {
				if argument == "" {
					argument = step.Column
				}
				key, _ := resolveColumnReference(argument, columns)
				if key == "" {
					return nil, fmt.Errorf("第 %d 行公式引用的列 %q 不存在", index+1, argument)
				}
				program.Steps[index].Formula = operation + "(" + key + ")"
			}
		}
		for key := range step.Set {
			resolved, _ := resolveColumnReference(key, columns)
			if resolved == "" {
				return nil, fmt.Errorf("第 %d 行 set 的列 %q 不存在；可用列：%s", index+1, key, describeColumnKeys(columns))
			}
			if resolved != key {
				program.Steps[index].Set[resolved] = step.Set[key]
				delete(program.Steps[index].Set, key)
			}
		}
		for conditionIndex := range step.Condition {
			key, _ := resolveColumnReference(step.Condition[conditionIndex].ColumnKey, columns)
			if key == "" {
				return nil, fmt.Errorf("第 %d 行条件的列 %q 不存在；可用列：%s", index+1, step.Condition[conditionIndex].ColumnKey, describeColumnKeys(columns))
			}
			program.Steps[index].Condition[conditionIndex].ColumnKey = key
		}
	}

	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	visible, err := s.readSheetRowValues(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	readKeys := make([]string, 0)
	for _, step := range program.Steps {
		for _, condition := range step.Condition {
			readKeys = append(readKeys, condition.ColumnKey)
		}
		if step.Op == "sort" {
			readKeys = append(readKeys, step.Column)
		}
		if step.Op == "compute" {
			_, key, _ := parseAggregateFormula(step.Formula)
			if key != "" {
				readKeys = append(readKeys, key)
			}
		}
	}
	if err := ensureReadColumnsVisible(buildAIPreviewRows(sheet, columns, rows), visible, readKeys); err != nil {
		return nil, err
	}

	selection := make([]int, 0, len(visible))
	values := make([]map[string]any, len(visible))
	for index, preview := range visible {
		selection = append(selection, index)
		values[index] = preview.Data
	}

	reports := make([]map[string]any, 0)
	cellUpdates := make([]model.CellUpdate, 0)

	for index, step := range program.Steps {
		switch step.Op {
		case "select", "filter":
			filtered := make([]int, 0, len(selection))
			for _, row := range selection {
				if sheetValuesMatch(values[row], step.Condition) {
					filtered = append(filtered, row)
				}
			}
			selection = filtered
			reports = append(reports, map[string]any{
				"line": index + 1, "op": step.Op, "remaining_rows": len(selection),
			})
		case "sort":
			sort.SliceStable(selection, func(i, j int) bool {
				comparison := compareSheetValues(values[selection[i]][step.Column], values[selection[j]][step.Column])
				if step.Descending {
					return comparison > 0
				}
				return comparison < 0
			})
			reports = append(reports, map[string]any{"line": index + 1, "op": step.Op, "column": step.Column, "descending": step.Descending, "persisted": false})
		case "compute":
			value, err := computeSelectionAggregate(values, selection, step.Column, step.Formula)
			if err != nil {
				return nil, fmt.Errorf("第 %d 行: %w", index+1, err)
			}
			reports = append(reports, map[string]any{"line": index + 1, "op": step.Op, "column": step.Column, "formula": step.Formula, "value": value, "persisted": false})
		case "set":
			if len(step.Set) == 0 {
				return nil, fmt.Errorf("第 %d 行 set 缺少赋值", index+1)
			}
			keys := make([]string, 0, len(step.Set))
			for key := range step.Set {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, row := range selection {
				for _, key := range keys {
					if err := s.validateCellWriteAccess(userID, sheetID, visible[row].Row, key); err != nil {
						return nil, fmt.Errorf("第 %d 行（第 %d 行数据 %s）：%w", index+1, visible[row].Row+1, key, err)
					}
					raw, err := json.Marshal(step.Set[key])
					if err != nil {
						return nil, err
					}
					cellUpdates = append(cellUpdates, model.CellUpdate{SheetID: sheetID, Row: visible[row].Row, Col: key, Value: raw})
					// Later statements read the staged value, while the DB remains
					// untouched until all statements have validated successfully.
					values[row][key] = step.Set[key]
				}
			}
			reports = append(reports, map[string]any{"line": index + 1, "op": step.Op, "rows": len(selection), "columns": keys})
		default:
			return nil, fmt.Errorf("第 %d 行不支持的操作 %q；可用：select、filter、sort、compute、set", index+1, step.Op)
		}
	}

	if len(cellUpdates) > maxBatchCellUpdates {
		return nil, fmt.Errorf("脚本将写入 %d 个单元格，超过单次上限 %d；请先用 select/filter 缩小范围", len(cellUpdates), maxBatchCellUpdates)
	}
	if len(cellUpdates) > 0 {
		if err := ensureZeroBasedSheetRows(rows); err != nil {
			return nil, err
		}
	}

	changedSheetIDs := []int64(nil)
	appliedCells := 0
	cacheWarning := ""
	var approvalStates []model.CellApprovalState
	if len(cellUpdates) > 0 {
		writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai")
		if err != nil {
			return nil, err
		}
		appliedCells = len(writeResult.AppliedChanges)
		approvalStates = writeResult.PendingStates
		if appliedCells > 0 {
			changedSheetIDs = []int64{sheetID}
			if err := s.invalidateSheetByID(userID, sheetID); err != nil {
				cacheWarning = fmt.Sprintf("数据已写入，但刷新表格缓存失败：%v", err)
			}
		}
	}

	summary := fmt.Sprintf("脚本执行完成：匹配 %d 行，写入 %d 格，%d 格等待审批（sort 仅改变处理顺序，compute 仅返回统计）", len(selection), appliedCells, len(cellUpdates)-appliedCells)
	if cacheWarning != "" {
		summary += "；" + cacheWarning
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok": true, "sheet_id": sheetID, "steps": len(program.Steps),
			"matched_rows": len(selection), "requested_cells": len(cellUpdates),
			"written_cells": appliedCells, "pending_approval": len(approvalStates) > 0,
			"approval_states": approvalStates, "reports": reports, "warning": cacheWarning,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDs,
		ResourcesChanged: len(approvalStates) > 0,
		Summary:          summary,
	}, nil
}

// computeSelectionAggregate evaluates SUM/AVG/COUNT/MIN/MAX over a column.
//
// The column comes from the formula argument when present, so
// `compute total = SUM({{amount}})` and `compute n = COUNT_NON_EMPTY(note)`
// both read the right column regardless of the result column name.
func computeSelectionAggregate(visible []map[string]any, selection []int, column, formula string) (any, error) {
	operation, argument, err := parseAggregateFormula(formula)
	if err != nil {
		return nil, err
	}
	if argument != "" {
		column = argument
	}

	numbers := make([]float64, 0, len(selection))
	nonEmpty := 0
	for _, row := range selection {
		value := visible[row][column]
		text := strings.TrimSpace(fmt.Sprint(normalizeComparableValue(value)))
		if text != "" && text != "<nil>" {
			nonEmpty++
		}
		if number, ok := toFloat(value); ok {
			numbers = append(numbers, number)
		}
	}

	switch operation {
	case "COUNT", "COUNTIF", "ROWS", "行数":
		return len(selection), nil
	case "COUNTNONEMPTY", "COUNT_NON_EMPTY", "COUNTA", "非空":
		return nonEmpty, nil
	case "SUM", "TOTAL", "合计", "求和", "TOTALPRICE":
		total := 0.0
		for _, number := range numbers {
			total += number
		}
		return total, nil
	case "AVG", "AVERAGE", "MEAN", "平均", "平均值":
		if len(numbers) == 0 {
			return nil, nil
		}
		total := 0.0
		for _, number := range numbers {
			total += number
		}
		return total / float64(len(numbers)), nil
	case "MIN", "最小", "最小值":
		if len(numbers) == 0 {
			return nil, nil
		}
		smallest := numbers[0]
		for _, number := range numbers {
			if number < smallest {
				smallest = number
			}
		}
		return smallest, nil
	case "MAX", "最大", "最大值":
		if len(numbers) == 0 {
			return nil, nil
		}
		largest := numbers[0]
		for _, number := range numbers {
			if number > largest {
				largest = number
			}
		}
		return largest, nil
	default:
		return nil, fmt.Errorf("不支持的聚合函数 %q；可用：SUM、AVG、COUNT、COUNT_NON_EMPTY、MIN、MAX", formula)
	}
}

// parseAggregateFormula preserves case-sensitive column keys and refuses
// unknown functions or malformed references before any script cell is written.
func parseAggregateFormula(formula string) (string, string, error) {
	text := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(formula), "="))
	operation, argument := text, ""
	if open := strings.Index(text, "("); open >= 0 {
		if !strings.HasSuffix(text, ")") {
			return "", "", fmt.Errorf("聚合公式 %q 缺少右括号", formula)
		}
		operation = strings.TrimSpace(text[:open])
		argument = strings.TrimSpace(text[open+1 : len(text)-1])
		argument = strings.Trim(argument, "{}")
		argument = strings.Trim(argument, "'\"")
	}
	operation = strings.ToUpper(operation)
	switch operation {
	case "COUNT", "COUNTIF", "ROWS", "行数", "COUNTNONEMPTY", "COUNT_NON_EMPTY", "COUNTA", "非空",
		"SUM", "TOTAL", "合计", "求和", "TOTALPRICE", "AVG", "AVERAGE", "MEAN", "平均", "平均值",
		"MIN", "最小", "最小值", "MAX", "最大", "最大值":
		return operation, argument, nil
	default:
		return "", "", fmt.Errorf("不支持的聚合函数 %q；可用：SUM、AVG、COUNT、COUNT_NON_EMPTY、MIN、MAX", formula)
	}
}

// ---------------------------------------------------------------------------
// Script parsing
// ---------------------------------------------------------------------------

// parseSpreadsheetScript turns the line based script language into steps.
func parseSpreadsheetScript(script string) (*SpreadsheetScriptProgram, error) {
	program := &SpreadsheetScriptProgram{Steps: make([]SpreadsheetScriptStep, 0)}
	lines := strings.Split(strings.ReplaceAll(script, "\r\n", "\n"), "\n")
	for index, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, "//") {
			continue
		}
		line = strings.TrimSuffix(line, ";")
		step, err := parseSpreadsheetScriptLine(line)
		if err != nil {
			return nil, fmt.Errorf("第 %d 行 %q: %w", index+1, line, err)
		}
		step.Line = index + 1
		program.Steps = append(program.Steps, step)
	}
	return program, nil
}

func parseSpreadsheetScriptLine(line string) (SpreadsheetScriptStep, error) {
	fields := strings.Fields(line)
	if len(fields) == 0 {
		return SpreadsheetScriptStep{}, fmt.Errorf("空语句")
	}
	verb := strings.ToLower(fields[0])

	// `set col = value` and `compute name = SUM(col)` split on the first '='.
	if verb == "set" {
		left, right, ok := splitOnce(line[len(fields[0]):], "=")
		if !ok {
			return SpreadsheetScriptStep{}, fmt.Errorf("set 语句需要写成 `set 列 = 值`")
		}
		column := strings.TrimSpace(left)
		if column == "" {
			return SpreadsheetScriptStep{}, fmt.Errorf("set 缺少列名")
		}
		return SpreadsheetScriptStep{Op: "set", Set: map[string]any{column: parseScriptLiteral(strings.TrimSpace(right))}}, nil
	}
	if verb == "compute" || verb == "aggregate" {
		left, right, ok := splitOnce(line[len(fields[0]):], "=")
		if !ok {
			return SpreadsheetScriptStep{}, fmt.Errorf("compute 语句需要写成 `compute 列 = SUM(列名)`")
		}
		column := strings.TrimSpace(left)
		formula := strings.TrimSpace(right)
		if column == "" || formula == "" {
			return SpreadsheetScriptStep{}, fmt.Errorf("compute 需要列名和聚合函数")
		}
		return SpreadsheetScriptStep{Op: "compute", Column: column, Formula: formula}, nil
	}

	// `sort by col [desc|asc]`
	if verb == "sort" {
		rest := strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
		rest = strings.TrimSpace(strings.TrimPrefix(rest, "by"))
		parts := strings.Fields(rest)
		if len(parts) == 0 {
			return SpreadsheetScriptStep{}, fmt.Errorf("sort 缺少列名：`sort by 列 [desc]`")
		}
		descending := false
		for _, part := range parts[1:] {
			switch strings.ToLower(part) {
			case "desc", "descending", "降序":
				descending = true
			case "asc", "ascending", "升序":
				descending = false
			default:
				return SpreadsheetScriptStep{}, fmt.Errorf("sort 不支持的方向 %q", part)
			}
		}
		return SpreadsheetScriptStep{Op: "sort", Column: parts[0], Descending: descending}, nil
	}

	// `select where ...` / `filter where ...` / `where ...`
	if verb == "select" || verb == "filter" || verb == "where" {
		rest := strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
		rest = strings.TrimSpace(strings.TrimPrefix(rest, "where"))
		if rest == "" {
			return SpreadsheetScriptStep{}, fmt.Errorf("%s 缺少条件：`%s where 列 = 值`", verb, verb)
		}
		conditions, err := parseScriptConditions(rest)
		if err != nil {
			return SpreadsheetScriptStep{}, err
		}
		op := "filter"
		if verb == "select" {
			op = "select"
		}
		return SpreadsheetScriptStep{Op: op, Condition: conditions}, nil
	}

	return SpreadsheetScriptStep{}, fmt.Errorf("不支持的关键字 %q；可用：select、filter、sort、compute、set", fields[0])
}

// parseScriptConditions parses `a = 1 and b contains "x"`.
func parseScriptConditions(input string) ([]filterCondition, error) {
	clauses := splitScriptAnd(input)
	conditions := make([]filterCondition, 0, len(clauses))
	for _, clause := range clauses {
		clause = strings.TrimSpace(clause)
		if clause == "" {
			continue
		}
		for _, operator := range []string{">=", "<=", "!=", ">", "<", "="} {
			if left, right, ok := splitOnce(clause, operator); ok {
				column := strings.TrimSpace(left)
				if column == "" {
					return nil, fmt.Errorf("条件 %q 缺少列名", clause)
				}
				op := map[string]string{">=": "gte", "<=": "lte", "!=": "not_equals", ">": "gt", "<": "lt", "=": "equals"}[operator]
				conditions = append(conditions, filterCondition{
					ColumnKey: column, Op: op, Value: parseScriptLiteral(strings.TrimSpace(right)),
				})
				goto next
			}
		}
		for _, keyword := range []string{"contains", "包含", "starts_with", "startswith", "前缀"} {
			if left, right, ok := splitOnceFold(clause, keyword); ok {
				op := "contains"
				switch keyword {
				case "starts_with", "startswith", "前缀":
					op = "starts_with"
				}
				conditions = append(conditions, filterCondition{
					ColumnKey: strings.TrimSpace(left), Op: op, Value: parseScriptLiteral(strings.TrimSpace(right)),
				})
				goto next
			}
		}
		{
			return nil, fmt.Errorf("条件 %q 无法解析；请使用 `列 = 值`、`列 > 值`、`列 contains 文本`，多个条件用 and 连接", clause)
		}
	next:
	}
	if len(conditions) == 0 {
		return nil, fmt.Errorf("没有解析出任何条件")
	}
	return conditions, nil
}

func splitScriptAnd(input string) []string {
	lower := strings.ToLower(input)
	result := make([]string, 0, 2)
	start := 0
	depth := 0
	inQuote := rune(0)
	runes := []rune(input)
	lowerRunes := []rune(lower)
	for index := 0; index < len(runes); index++ {
		character := runes[index]
		if inQuote != 0 {
			if character == inQuote {
				inQuote = 0
			}
			continue
		}
		switch character {
		case '"', '\'':
			inQuote = character
		case '“', '”', '‘', '’':
			// Normalise the CJK quote pairs so a Chinese input method works too.
			if inQuote == 0 {
				inQuote = character
			} else {
				inQuote = 0
			}
		case '(':
			depth++
		case ')':
			depth--
		}
		if depth != 0 || inQuote != 0 {
			continue
		}
		// Look for a standalone `and` / `且` separator.
		if strings.HasPrefix(string(lowerRunes[index:]), " and ") || strings.HasPrefix(string(lowerRunes[index:]), "且") {
			length := 5
			if !strings.HasPrefix(string(lowerRunes[index:]), " and ") {
				length = 1
			}
			result = append(result, string(runes[start:index]))
			start = index + length
			index += length - 1
		}
	}
	result = append(result, string(runes[start:]))
	return result
}

// parseScriptLiteral converts a script literal to a Go value. Quoted strings,
// numbers, booleans and null are recognised; anything else stays a string.
func parseScriptLiteral(raw string) any {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if trimmed != "" {
		runes := []rune(trimmed)
		if len(runes) >= 2 {
			first, last := runes[0], runes[len(runes)-1]
			if (first == '"' && last == '"') || (first == '\'' && last == '\'') || (first == '“' && last == '”') {
				return strings.TrimSpace(string(runes[1 : len(runes)-1]))
			}
		}
	}
	switch strings.ToLower(trimmed) {
	case "true", "yes", "是":
		return true
	case "false", "no", "否":
		return false
	case "null", "nil", "none", "空":
		return ""
	}
	if number, err := strconv.ParseFloat(trimmed, 64); err == nil {
		return number
	}
	return trimmed
}

// splitOnce splits on the first occurrence of separator.
func splitOnce(input, separator string) (string, string, bool) {
	index := strings.Index(input, separator)
	if index < 0 {
		return "", "", false
	}
	return input[:index], input[index+len(separator):], true
}

// splitOnceFold is splitOnce but case-insensitive and word-boundary aware.
func splitOnceFold(input, separator string) (string, string, bool) {
	lowerInput := strings.ToLower(input)
	lowerSeparator := strings.ToLower(separator)
	index := strings.Index(lowerInput, lowerSeparator)
	if index < 0 {
		return "", "", false
	}
	return input[:index], input[index+len(separator):], true
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

func ensureZeroBasedSheetRows(rows []model.Row) error {
	if getSheetRowBase(rows) != 0 {
		return fmt.Errorf("工作表的原始行索引不是从 0 开始；为避免覆盖错误数据，已拒绝批量写入")
	}
	return nil
}

// readSheetRowValues retains each original row coordinate. Compacting a
// sparse sheet into a slice of maps silently writes to the wrong data row.
func (s *AIService) readSheetRowValues(userID int64, sheet *model.Sheet, columns []sheetColumnPayload, rows []model.Row) ([]aiPreviewRow, error) {
	return s.buildVisiblePreviewRows(userID, sheet, columns, rows)
}

// ensureReadColumnsVisible prevents a hidden value from being treated as an
// empty cell in a filter, aggregate, or dedupe condition. All row coordinates
// are kept intact; missing cells with no stored value remain legitimate blanks.
func ensureReadColumnsVisible(original, visible []aiPreviewRow, keys []string) error {
	if len(keys) == 0 {
		return nil
	}
	byRow := make(map[int]map[string]any, len(visible))
	for _, row := range visible {
		byRow[row.Row] = row.Data
	}
	for _, row := range original {
		shown := byRow[row.Row]
		for _, key := range keys {
			if _, hasValue := row.Data[key]; hasValue {
				if _, allowed := shown[key]; !allowed {
					return fmt.Errorf("第 %d 行的 %s 列不可读取，无法准确筛选或统计", row.Row+1, key)
				}
			}
		}
	}
	return nil
}

// describeColumnKeys renders the column keys of a sheet for error messages so
// the model can correct itself without another round trip.
func describeColumnKeys(columns []sheetColumnPayload) string {
	keys := make([]string, 0, len(columns))
	for _, column := range columns {
		keys = append(keys, column.Key)
	}
	return strings.Join(keys, ", ")
}

// ensureSheetEditAccess is the shared entry check for the advanced write tools.
func (s *AIService) ensureSheetEditAccess(userID, sheetID int64) error {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return err
	}
	if !matrix.Sheet.CanEdit {
		return fmt.Errorf("当前账号没有该工作表的编辑权限")
	}
	return nil
}

func boolArg(args map[string]any, key string) bool {
	value, exists := args[key]
	if !exists {
		return false
	}
	switch typed := value.(type) {
	case bool:
		return typed
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "true", "1", "yes", "是":
			return true
		}
	}
	return false
}
