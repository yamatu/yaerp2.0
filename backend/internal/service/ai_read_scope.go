package service

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

// agentReadScopeArg carries an agentReadScope into tool calls. It is set by
// the server after the model's arguments are parsed, so a model can never
// widen its own scope.
const agentReadScopeArg = "_read_scope"

// agentSheetRange is a worksheet range: 0-based, inclusive, worksheet rows
// (row 0 is the header row). -1 means unbounded.
type agentSheetRange struct {
	StartRow, EndRow       int
	StartColumn, EndColumn int
	A1                     string
}

// agentReadScope limits a read-only agent run to some sheets, optionally to a
// range of each. Sheets that are not listed cannot be read.
type agentReadScope struct {
	sheets map[int64]*agentSheetRange
	labels map[int64]string
}

func newAgentReadScope() *agentReadScope {
	return &agentReadScope{sheets: map[int64]*agentSheetRange{}, labels: map[int64]string{}}
}

func (scope *agentReadScope) add(sheetID int64, label string, sheetRange *agentSheetRange) {
	if existing, ok := scope.sheets[sheetID]; ok && existing == nil {
		return // the whole sheet is already allowed
	}
	scope.sheets[sheetID] = sheetRange
	scope.labels[sheetID] = label
}

func (scope *agentReadScope) describe() string {
	parts := make([]string, 0, len(scope.labels))
	for id, label := range scope.labels {
		if sheetRange := scope.sheets[id]; sheetRange != nil {
			parts = append(parts, fmt.Sprintf("%s（%s）", label, sheetRange.A1))
		} else {
			parts = append(parts, label)
		}
	}
	return strings.Join(parts, "、")
}

func agentReadScopeFromArgs(args map[string]any) *agentReadScope {
	scope, _ := args[agentReadScopeArg].(*agentReadScope)
	return scope
}

// checkAgentReadScope rejects a tool call on a sheet outside the scope.
func checkAgentReadScope(args map[string]any) error {
	scope := agentReadScopeFromArgs(args)
	if scope == nil {
		return nil
	}
	ids := uniquePositiveInt64s(intSliceArg(args, "sheet_ids"), 64)
	if id, ok := toInt64(args["sheet_id"]); ok && id > 0 {
		ids = append(ids, id)
	}
	for _, id := range ids {
		if _, ok := scope.sheets[id]; !ok {
			return fmt.Errorf("本次分析只能读取所选范围：%s；工作表 %d 不在范围内", scope.describe(), id)
		}
	}
	return nil
}

// scopeAgentRead clips what a read tool loaded to the range selected for the
// sheet. Columns outside the range are dropped together with their values, so
// they can neither be read nor referenced. The sheet's snapshot is clipped as
// well, because previews read cells from it: rows outside the range go, and the
// kept columns move to the front, since snapshot cells map to columns by
// position (column 0 is columns[0]). Row numbers stay as they are. The sheet
// must be a copy owned by the caller.
func scopeAgentRead(args map[string]any, sheet *model.Sheet, columns []sheetColumnPayload, rows []model.Row) ([]sheetColumnPayload, []model.Row, error) {
	scope := agentReadScopeFromArgs(args)
	if scope == nil {
		return columns, rows, nil
	}
	sheetRange, ok := scope.sheets[sheet.ID]
	if !ok {
		return nil, nil, fmt.Errorf("本次分析只能读取所选范围：%s", scope.describe())
	}
	if sheetRange == nil {
		return columns, rows, nil
	}
	clipped, err := clipSheetSnapshot(sheet.Config, sheetRange)
	if err != nil {
		return nil, nil, err
	}
	sheet.Config = clipped
	keptColumns := make([]sheetColumnPayload, 0, len(columns))
	allowedKeys := make(map[string]bool, len(columns))
	for index, column := range columns {
		if sheetRange.StartColumn >= 0 && index < sheetRange.StartColumn {
			continue
		}
		if sheetRange.EndColumn >= 0 && index > sheetRange.EndColumn {
			continue
		}
		keptColumns = append(keptColumns, column)
		allowedKeys[column.Key] = true
	}
	keptRows := make([]model.Row, 0, len(rows))
	for _, row := range rows {
		// Data row N is worksheet row N+1 (worksheet row 0 holds the headers).
		worksheetRow := row.RowIndex + 1
		if sheetRange.StartRow >= 0 && worksheetRow < sheetRange.StartRow {
			continue
		}
		if sheetRange.EndRow >= 0 && worksheetRow > sheetRange.EndRow {
			continue
		}
		if len(keptColumns) < len(columns) {
			var data map[string]any
			if err := json.Unmarshal(row.Data, &data); err == nil {
				for key := range data {
					if !allowedKeys[key] {
						delete(data, key)
					}
				}
				if encoded, err := json.Marshal(data); err == nil {
					row.Data = encoded
				}
			}
		}
		keptRows = append(keptRows, row)
	}
	return keptColumns, keptRows, nil
}

var agentA1RangePattern = regexp.MustCompile(`^(?i)\$?([A-Z]{0,3})\$?([0-9]{0,7})(?::\$?([A-Z]{0,3})\$?([0-9]{0,7}))?$`)

// parseAgentA1Range parses "B2:F200", "A:C" (whole columns), "2:50" (whole
// rows) or a single cell "C5".
func parseAgentA1Range(value string) (*agentSheetRange, error) {
	value = strings.ToUpper(strings.ReplaceAll(strings.TrimSpace(value), " ", ""))
	if value == "" {
		return nil, nil
	}
	match := agentA1RangePattern.FindStringSubmatch(value)
	if match == nil || (match[1] == "" && match[2] == "") {
		return nil, fmt.Errorf("区域 %q 格式不正确，示例：A1:F200、B:D、2:50", value)
	}
	startColumn, startRow := match[1], match[2]
	endColumn, endRow := match[3], match[4]
	if !strings.Contains(value, ":") {
		endColumn, endRow = startColumn, startRow
	}
	parseRow := func(text string) int {
		if text == "" {
			return -1
		}
		number, _ := strconv.Atoi(text)
		return number - 1
	}
	parseColumn := func(text string) int {
		if text == "" {
			return -1
		}
		return columnLettersToIndex(text)
	}
	result := &agentSheetRange{
		StartRow: parseRow(startRow), EndRow: parseRow(endRow),
		StartColumn: parseColumn(startColumn), EndColumn: parseColumn(endColumn),
		A1: value,
	}
	if (startRow == "") != (endRow == "") || (startColumn == "") != (endColumn == "") {
		return nil, fmt.Errorf("区域 %q 格式不正确，示例：A1:F200、B:D、2:50", value)
	}
	if result.StartRow > result.EndRow {
		result.StartRow, result.EndRow = result.EndRow, result.StartRow
	}
	if result.StartColumn > result.EndColumn {
		result.StartColumn, result.EndColumn = result.EndColumn, result.StartColumn
	}
	if (startRow != "" && result.StartRow < 0) || result.EndColumn > 1000 {
		return nil, fmt.Errorf("区域 %q 超出表格范围", value)
	}
	return result, nil
}

// ensureColumnsInScope rejects column keys that the read scope removed, so a
// condition or group on a column outside the selected range is an error
// instead of silently reading blanks.
func ensureColumnsInScope(args map[string]any, columns []sheetColumnPayload, keys []string) error {
	scope := agentReadScopeFromArgs(args)
	if scope == nil {
		return nil
	}
	allowed := make(map[string]bool, len(columns))
	for _, column := range columns {
		allowed[column.Key] = true
	}
	for _, key := range keys {
		if key != "" && !allowed[key] {
			return fmt.Errorf("列 %q 不在本次分析所选的区域内；可用列：%s", key, describeColumnKeys(columns))
		}
	}
	return nil
}

// clipSheetSnapshot keeps the header row and the rows of the range in the
// snapshot's cellData, and only the range's columns, shifted to start at 0.
func clipSheetSnapshot(config json.RawMessage, sheetRange *agentSheetRange) (json.RawMessage, error) {
	if len(config) == 0 {
		return config, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, fmt.Errorf("parse sheet config: %w", err)
	}
	rawSheetData, ok := payload["univerSheetData"]
	if !ok {
		return config, nil
	}
	var sheetData map[string]json.RawMessage
	if err := json.Unmarshal(rawSheetData, &sheetData); err != nil || sheetData == nil {
		return config, nil
	}
	var cellData map[string]map[string]json.RawMessage
	if raw, ok := sheetData["cellData"]; !ok || json.Unmarshal(raw, &cellData) != nil {
		return config, nil
	}
	shift := 0
	if sheetRange.StartColumn > 0 {
		shift = sheetRange.StartColumn
	}
	clipped := make(map[string]map[string]json.RawMessage, len(cellData))
	for rowKey, cells := range cellData {
		row, err := strconv.Atoi(rowKey)
		if err != nil {
			continue
		}
		if row != 0 && ((sheetRange.StartRow >= 0 && row < sheetRange.StartRow) || (sheetRange.EndRow >= 0 && row > sheetRange.EndRow)) {
			continue
		}
		kept := make(map[string]json.RawMessage, len(cells))
		for columnKey, cell := range cells {
			column, err := strconv.Atoi(columnKey)
			if err != nil {
				continue
			}
			if (sheetRange.StartColumn >= 0 && column < sheetRange.StartColumn) || (sheetRange.EndColumn >= 0 && column > sheetRange.EndColumn) {
				continue
			}
			kept[strconv.Itoa(column-shift)] = cell
		}
		clipped[rowKey] = kept
	}
	encodedCells, err := json.Marshal(clipped)
	if err != nil {
		return nil, err
	}
	sheetData["cellData"] = encodedCells
	// Merges and column widths refer to the original columns; drop them.
	delete(sheetData, "mergeData")
	delete(sheetData, "columnData")
	if payload["univerSheetData"], err = json.Marshal(sheetData); err != nil {
		return nil, err
	}
	return json.Marshal(payload)
}
