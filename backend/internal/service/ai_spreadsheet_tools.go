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

	cellUpdates := make([]model.CellUpdate, 0, len(updates))
	applied := make([]map[string]any, 0, len(updates))
	for index, update := range updates {
		if update.Row == nil {
			return nil, fmt.Errorf("第 %d 项缺少 row", index+1)
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

	writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai")
	if err != nil {
		return nil, err
	}
	if len(writeResult.AppliedChanges) > 0 {
		if err := s.invalidateSheetByID(userID, sheetID); err != nil {
			return nil, err
		}
	}

	pending := len(writeResult.PendingStates) > 0
	summary := fmt.Sprintf("已批量更新 %d 个单元格（%d 行）", len(applied), distinctRowCount(applied))
	changedSheetIDs := []int64{sheetID}
	if pending {
		summary = fmt.Sprintf("已将 %d 个单元格提交审批，全部通过后才会写入", len(applied))
		changedSheetIDs = nil
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":               true,
			"sheet_id":         sheetID,
			"updated_cells":    len(applied),
			"updated_rows":     distinctRowCount(applied),
			"pending_approval": pending,
			"approval_states":  writeResult.PendingStates,
		},
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDs,
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

	operation := SpreadsheetOperation{
		Kind:            "fill_formula",
		SheetID:         sheetID,
		ColumnKey:       columnKey,
		FormulaTemplate: template,
		StartRow:        &startRow,
		EndRow:          &endRow,
	}
	touched, err := s.executeSpreadsheetOperations(userID, []SpreadsheetOperation{operation})
	if err != nil {
		return nil, err
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":         true,
			"sheet_id":   sheetID,
			"column_key": columnKey,
			"formula":    template,
			"start_row":  startRow,
			"end_row":    endRow,
			"row_count":  endRow - startRow + 1,
		},
		TouchedSheetIDs: touched,
		ChangedSheetIDs: touched,
		Summary:         fmt.Sprintf("已在 %s 列的 %d 行写入公式", columnKey, endRow-startRow+1),
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
	startRow, endRow := 0, len(rows)-1
	if value, ok := intPtrArg(args, "start_row"); ok && value != nil {
		startRow = *value
	}
	if value, ok := intPtrArg(args, "end_row"); ok && value != nil {
		endRow = *value
	}
	if endRow < startRow {
		return 0, 0, fmt.Errorf("end_row(%d) 不能小于 start_row(%d)", endRow, startRow)
	}
	if startRow < 0 {
		startRow = 0
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
	values, err := s.readSheetRowValues(userID, sheetID, rows)
	if err != nil {
		return nil, err
	}
	if endRow >= len(values) {
		endRow = len(values) - 1
	}
	if startRow > endRow {
		return nil, fmt.Errorf("选区没有可排序的数据行")
	}

	// Every row of the range must be writable or the sort would half-apply.
	for row := startRow; row <= endRow; row++ {
		if err := s.validateRowWriteAccess(userID, sheetID, row); err != nil {
			return nil, fmt.Errorf("第 %d 行不可写，排序会破坏数据一致性: %w", row+1, err)
		}
	}

	order := make([]int, 0, endRow-startRow+1)
	for row := startRow; row <= endRow; row++ {
		order = append(order, row)
	}
	sort.SliceStable(order, func(i, j int) bool {
		left := values[order[i]][key]
		right := values[order[j]][key]
		comparison := compareSheetValues(left, right)
		if descending {
			return comparison > 0
		}
		return comparison < 0
	})

	changed := false
	for index, row := range order {
		if row != startRow+index {
			changed = true
			break
		}
	}
	if !changed {
		return &toolExecutionResult{
			Data:            map[string]any{"ok": true, "sheet_id": sheetID, "sorted": false},
			TouchedSheetIDs: []int64{sheetID},
			Summary:         "数据已经按该列排序，无需调整",
		}, nil
	}

	cellUpdates := make([]model.CellUpdate, 0, (endRow-startRow+1)*len(columns))
	for index, sourceRow := range order {
		targetRow := startRow + index
		for _, column := range columns {
			value, exists := values[sourceRow][column.Key]
			if !exists {
				continue
			}
			raw, err := json.Marshal(value)
			if err != nil {
				continue
			}
			cellUpdates = append(cellUpdates, model.CellUpdate{SheetID: sheetID, Row: targetRow, Col: column.Key, Value: raw})
		}
	}

	if _, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai"); err != nil {
		return nil, err
	}
	if err := s.invalidateSheetByID(userID, sheetID); err != nil {
		return nil, err
	}

	direction := "升序"
	if descending {
		direction = "降序"
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"ok":         true,
			"sheet_id":   sheetID,
			"column_key": key,
			"sorted":     true,
			"start_row":  startRow,
			"end_row":    endRow,
			"row_count":  endRow - startRow + 1,
		},
		TouchedSheetIDs: []int64{sheetID},
		ChangedSheetIDs: []int64{sheetID},
		Summary:         fmt.Sprintf("已按 %s 列%s重排 %d 行", key, direction, endRow-startRow+1),
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
	visible, err := s.readSheetRowValues(userID, sheetID, rows)
	if err != nil {
		return nil, err
	}

	matches := make([]map[string]any, 0, limit)
	total := 0
	for row, values := range visible {
		if !sheetValuesMatch(values, conditions) {
			continue
		}
		total++
		if len(matches) >= limit {
			continue
		}
		entry := map[string]any{"row": row, "display_row": row + 2}
		for key, value := range values {
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
	visible, err := s.readSheetRowValues(userID, sheetID, rows)
	if err != nil {
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
	for row, values := range visible {
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
	if apply && len(duplicateRows) > 0 {
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
		if _, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai"); err != nil {
			return nil, err
		}
		if err := s.invalidateSheetByID(userID, sheetID); err != nil {
			return nil, err
		}
	}

	data := map[string]any{
		"ok":              true,
		"sheet_id":        sheetID,
		"key_columns":     keys,
		"duplicate_rows":  duplicateRows,
		"duplicate_count": len(duplicateRows),
		"groups":          duplicateGroups,
		"applied":         apply && len(duplicateRows) > 0,
	}
	summary := fmt.Sprintf("按 %s 发现 %d 行重复数据", strings.Join(keys, "+"), len(duplicateRows))
	if data["applied"] == true {
		summary = fmt.Sprintf("已按 %s 标记并清理 %d 行重复数据", strings.Join(keys, "+"), len(duplicateRows))
	}
	return &toolExecutionResult{
		Data:             data,
		TouchedSheetIDs:  []int64{sheetID},
		ChangedSheetIDs:  changedSheetIDsWhen(data["applied"] == true, sheetID),
		ResourcesChanged: false,
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
	visible, err := s.readSheetRowValues(userID, sheetID, rows)
	if err != nil {
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
		for _, values := range visible {
			text := strings.TrimSpace(fmt.Sprint(normalizeComparableValue(values[column.Key])))
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
		for _, reference := range append([]string{step.Column}, step.Columns...) {
			if strings.TrimSpace(reference) == "" {
				continue
			}
			key, _ := resolveColumnReference(reference, columns)
			if key == "" {
				return nil, fmt.Errorf("第 %d 行引用的列 %q 不存在；可用列：%s", index+1, reference, describeColumnKeys(columns))
			}
			program.Steps[index].Column = key
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
	visible, err := s.readSheetRowValues(userID, sheetID, rows)
	if err != nil {
		return nil, err
	}

	selection := make([]int, 0, len(visible))
	for row := range visible {
		selection = append(selection, row)
	}
	sort.Ints(selection)

	reports := make([]map[string]any, 0)
	cellUpdates := make([]model.CellUpdate, 0)

	for index, step := range program.Steps {
		switch step.Op {
		case "select", "filter":
			filtered := make([]int, 0, len(selection))
			for _, row := range selection {
				if sheetValuesMatch(visible[row], step.Condition) {
					filtered = append(filtered, row)
				}
			}
			selection = filtered
			reports = append(reports, map[string]any{
				"line": index + 1, "op": step.Op, "remaining_rows": len(selection),
			})
		case "sort":
			sort.SliceStable(selection, func(i, j int) bool {
				comparison := compareSheetValues(visible[selection[i]][step.Column], visible[selection[j]][step.Column])
				if step.Descending {
					return comparison > 0
				}
				return comparison < 0
			})
			reports = append(reports, map[string]any{"line": index + 1, "op": step.Op, "column": step.Column, "descending": step.Descending})
		case "compute":
			value, err := computeSelectionAggregate(visible, selection, step.Column, step.Formula)
			if err != nil {
				return nil, fmt.Errorf("第 %d 行: %w", index+1, err)
			}
			reports = append(reports, map[string]any{"line": index + 1, "op": step.Op, "column": step.Column, "formula": step.Formula, "value": value})
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
					if err := s.validateCellWriteAccess(userID, sheetID, row, key); err != nil {
						return nil, fmt.Errorf("第 %d 行（第 %d 行数据 %s）：%w", index+1, row+1, key, err)
					}
					raw, err := json.Marshal(step.Set[key])
					if err != nil {
						return nil, err
					}
					cellUpdates = append(cellUpdates, model.CellUpdate{SheetID: sheetID, Row: row, Col: key, Value: raw})
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

	changedSheetIDs := []int64(nil)
	if len(cellUpdates) > 0 {
		writeResult, err := s.sheetService.UpdateCellsWithSourceDetailed(userID, cellUpdates, "ai")
		if err != nil {
			return nil, err
		}
		if len(writeResult.AppliedChanges) > 0 {
			if err := s.invalidateSheetByID(userID, sheetID); err != nil {
				return nil, err
			}
			changedSheetIDs = []int64{sheetID}
		}
	}

	return &toolExecutionResult{
		Data: map[string]any{
			"ok":            true,
			"sheet_id":      sheetID,
			"steps":         len(program.Steps),
			"matched_rows":  len(selection),
			"written_cells": len(cellUpdates),
			"reports":       reports,
		},
		TouchedSheetIDs: []int64{sheetID},
		ChangedSheetIDs: changedSheetIDs,
		Summary:         fmt.Sprintf("脚本执行完成：匹配 %d 行，写入 %d 个单元格", len(selection), len(cellUpdates)),
	}, nil
}

// computeSelectionAggregate evaluates SUM/AVG/COUNT/MIN/MAX over a column.
//
// The column comes from the formula argument when present, so
// `compute total = SUM({{amount}})` and `compute n = COUNT_NON_EMPTY(note)`
// both read the right column regardless of the result column name.
func computeSelectionAggregate(visible []map[string]any, selection []int, column, formula string) (any, error) {
	operation := strings.TrimSpace(formula)
	operation = strings.TrimSpace(strings.TrimPrefix(operation, "="))
	operation = strings.TrimSuffix(operation, "()")
	// Split before upper-casing: the argument is a column key and column keys
	// are case-sensitive, so upper-casing it would break the lookup.
	if open := strings.Index(operation, "("); open >= 0 {
		argument := strings.TrimSpace(operation[open+1:])
		argument = strings.TrimSuffix(argument, ")")
		argument = strings.TrimSpace(argument)
		argument = strings.Trim(argument, "{}")
		argument = strings.Trim(argument, "'\"")
		if argument != "" {
			column = argument
		}
		operation = strings.TrimSpace(operation[:open])
	}
	operation = strings.ToUpper(operation)

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

// readSheetRowValues returns the full visible data of a sheet keyed by column,
// indexed by 0-based data row. Rows the account cannot see are omitted.
func (s *AIService) readSheetRowValues(userID, sheetID int64, rows []model.Row) ([]map[string]any, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}
	visible, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return nil, err
	}
	values := make([]map[string]any, 0, len(visible))
	for _, row := range visible {
		values = append(values, row.Data)
	}
	return values, nil
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
