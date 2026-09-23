package service

import (
	"encoding/json"
	"fmt"
	"reflect"
	"sort"

	"yaerp/internal/model"
)

// planSheetSort builds a complete, validated value permutation. Rows retain
// their coordinates and IDs; sparse ranges and unreadable cells are rejected
// rather than silently sorting only the visible portion of a record.
func planSheetSort(sheetID int64, original, visible []aiPreviewRow, columns []sheetColumnPayload, start, end int, key string, descending bool) ([]model.CellUpdate, error) {
	if start < 0 || end < start {
		return nil, fmt.Errorf("排序范围无效")
	}
	knownColumns := make(map[string]bool, len(columns))
	for _, column := range columns {
		knownColumns[column.Key] = true
	}
	rawByRow := make(map[int]aiPreviewRow, len(original))
	visibleByRow := make(map[int]aiPreviewRow, len(visible))
	for _, row := range original {
		rawByRow[row.Row] = row
	}
	for _, row := range visible {
		visibleByRow[row.Row] = row
	}
	order := make([]int, 0, end-start+1)
	for row := start; row <= end; row++ {
		raw, rawExists := rawByRow[row]
		view, viewExists := visibleByRow[row]
		if !rawExists || !viewExists {
			return nil, fmt.Errorf("第 %d 行不存在，不能跨空缺行排序", row+1)
		}
		for columnKey := range raw.Data {
			if !knownColumns[columnKey] {
				return nil, fmt.Errorf("第 %d 行含有未登记的列 %s，无法安全移动完整数据行", row+1, columnKey)
			}
		}
		for _, column := range columns {
			if _, exists := raw.Data[column.Key]; exists {
				if _, readable := view.Data[column.Key]; !readable {
					return nil, fmt.Errorf("第 %d 行 %s 列不可读取；排序必须移动完整数据行", row+1, column.Key)
				}
			}
		}
		order = append(order, row)
	}
	sort.SliceStable(order, func(i, j int) bool {
		comparison := compareSheetValues(visibleByRow[order[i]].Data[key], visibleByRow[order[j]].Data[key])
		if descending {
			return comparison > 0
		}
		return comparison < 0
	})

	updates := make([]model.CellUpdate, 0)
	for index, sourceRow := range order {
		targetRow := start + index
		if sourceRow == targetRow {
			continue
		}
		source, target := visibleByRow[sourceRow].Data, visibleByRow[targetRow].Data
		for _, column := range columns {
			if column.Formula != "" || isSheetFormula(source[column.Key]) || isSheetFormula(target[column.Key]) {
				return nil, fmt.Errorf("%s 列含有公式，直接置换值会破坏相对引用；请先转换公式或缩小排序范围", column.Key)
			}
		}
		for _, column := range columns {
			value, sourceExists := source[column.Key]
			prior, targetExists := target[column.Key]
			if sourceExists == targetExists && reflect.DeepEqual(value, prior) {
				continue
			}
			// A blank source cell must clear the old value of the destination.
			// Skipping it would duplicate the previous row's data.
			raw, err := json.Marshal(value)
			if err != nil {
				return nil, fmt.Errorf("第 %d 行 %s 列无法编码: %w", sourceRow+1, column.Key, err)
			}
			updates = append(updates, model.CellUpdate{SheetID: sheetID, Row: targetRow, Col: column.Key, Value: raw})
		}
	}
	return updates, nil
}

// Univer may cache a formula's displayed value in `v`, so the visible row
// preview alone cannot reveal that the original cell has a formula in `f`.
func hasSheetSnapshotFormulas(config json.RawMessage) bool {
	var payload struct {
		Sheet struct {
			CellData map[string]map[string]json.RawMessage `json:"cellData"`
		} `json:"univerSheetData"`
	}
	if err := json.Unmarshal(config, &payload); err != nil {
		return len(config) > 0 // unknown snapshot shape: fail closed
	}
	for _, row := range payload.Sheet.CellData {
		for _, raw := range row {
			var cell map[string]any
			if json.Unmarshal(raw, &cell) == nil {
				if formula, ok := cell["f"].(string); ok && formula != "" {
					return true
				}
			}
		}
	}
	return false
}

func isSheetFormula(value any) bool {
	text, ok := value.(string)
	return ok && len(text) > 0 && text[0] == '='
}
