package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestBuildAIPreviewRowsPrefersSnapshotData(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "name", Name: "姓名", Type: "text"},
		{Key: "score", Name: "分数", Type: "number"},
	}

	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {
					"0": {"v": "姓名"},
					"1": {"v": "分数"}
				},
				"1": {
					"0": {"v": "快照张三"},
					"1": {"v": 99}
				}
			}
		}
	}`)

	rowsTableData, _ := json.Marshal(map[string]any{
		"name":  "数据库张三",
		"score": 60,
	})

	sheet := &model.Sheet{
		Config: config,
	}
	rows := []model.Row{
		{RowIndex: 0, Data: rowsTableData},
	}

	previewRows := buildAIPreviewRows(sheet, columns, rows)
	if len(previewRows) != 1 {
		t.Fatalf("buildAIPreviewRows() returned %d rows, want 1", len(previewRows))
	}
	if got := previewRows[0].Data["name"]; got != "快照张三" {
		t.Fatalf("preview row name = %v, want 快照张三", got)
	}
	if got := previewRows[0].Row; got != 0 {
		t.Fatalf("preview row index = %d, want 0", got)
	}
	if got := previewRows[0].DisplayRow; got != 2 {
		t.Fatalf("preview display row = %d, want 2", got)
	}
}

func TestBuildAIPreviewRowsMergesPartialSnapshotWithStoredRows(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "name", Name: "姓名", Type: "text"},
		{Key: "score", Name: "分数", Type: "number"},
	}
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "姓名"}, "1": {"v": "分数"}},
				"1": {"0": {"v": "快照张三"}}
			}
		}
	}`)
	storedRows := []model.Row{
		{RowIndex: 0, Data: json.RawMessage(`{"name":"数据库张三","score":60}`)},
		{RowIndex: 1, Data: json.RawMessage(`{"name":"李四","score":88}`)},
		{RowIndex: 2, Data: json.RawMessage(`{"name":"王五","score":92}`)},
	}

	previewRows := buildAIPreviewRows(&model.Sheet{Config: config}, columns, storedRows)
	if len(previewRows) != 3 {
		t.Fatalf("buildAIPreviewRows() returned %d rows, want 3", len(previewRows))
	}
	if got := previewRows[0].Data["name"]; got != "快照张三" {
		t.Fatalf("merged first row name = %v, want 快照张三", got)
	}
	if got := previewRows[0].Data["score"]; got != float64(60) {
		t.Fatalf("merged first row score = %v, want 60", got)
	}
	if got := previewRows[2].Data["name"]; got != "王五" {
		t.Fatalf("third row name = %v, want 王五", got)
	}
}

func TestBuildAIPreviewRowsAlignsSnapshotWithNonZeroStoredRowBase(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "name", Name: "姓名", Type: "text"}}
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "姓名"}},
				"6": {"0": {"v": "快照首行"}}
			}
		}
	}`)
	storedRows := []model.Row{
		{RowIndex: 5, Data: json.RawMessage(`{"name":"数据库首行"}`)},
		{RowIndex: 6, Data: json.RawMessage(`{"name":"数据库第二行"}`)},
	}

	previewRows := buildAIPreviewRows(&model.Sheet{Config: config}, columns, storedRows)
	if len(previewRows) != 2 {
		t.Fatalf("buildAIPreviewRows() returned %d rows, want 2", len(previewRows))
	}
	if got := previewRows[0].Data["name"]; got != "快照首行" {
		t.Fatalf("aligned first row name = %v, want 快照首行", got)
	}
	if previewRows[0].Row != 0 || previewRows[0].DisplayRow != 2 {
		t.Fatalf("aligned row coordinates = row %d display %d", previewRows[0].Row, previewRows[0].DisplayRow)
	}
}

func TestBuildAIPreviewRowsKeepsFormulaWithoutCachedValue(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "amount", Name: "金额", Type: "formula"}}
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "金额"}},
				"1": {"0": {"f": "SUM(B2:C2)"}}
			}
		}
	}`)

	previewRows := buildAIPreviewRows(&model.Sheet{Config: config}, columns, nil)
	if len(previewRows) != 1 {
		t.Fatalf("buildAIPreviewRows() returned %d rows, want 1", len(previewRows))
	}
	if got := previewRows[0].Data["amount"]; got != "=SUM(B2:C2)" {
		t.Fatalf("formula value = %v, want =SUM(B2:C2)", got)
	}
}

func TestBuildAISheetProfileUsesAllVisibleRows(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "department", Name: "部门", Type: "select"},
		{Key: "amount", Name: "金额", Type: "number"},
	}
	rows := []aiPreviewRow{
		{Row: 0, Data: map[string]interface{}{"department": "采购部", "amount": 10}},
		{Row: 1, Data: map[string]interface{}{"department": "采购部", "amount": 20}},
		{Row: 2, Data: map[string]interface{}{"department": "销售部", "amount": 30}},
	}

	profile := buildAISheetProfile(columns, rows, nil)
	if got := profile["total_rows"]; got != 3 {
		t.Fatalf("profile total_rows = %v, want 3", got)
	}
	columnProfiles, ok := profile["column_profiles"].([]map[string]any)
	if !ok || len(columnProfiles) != 2 {
		t.Fatalf("column_profiles = %#v", profile["column_profiles"])
	}
	numeric, ok := columnProfiles[1]["numeric"].(map[string]any)
	if !ok {
		t.Fatalf("numeric profile missing: %#v", columnProfiles[1])
	}
	if got := numeric["sum"]; got != float64(60) {
		t.Fatalf("numeric sum = %v, want 60", got)
	}
}

func TestCompactAITraceDataTruncatesLargeCollections(t *testing.T) {
	rows := make([]map[string]any, 0, 12)
	for index := 0; index < 12; index++ {
		rows = append(rows, map[string]any{"row": index})
	}
	compacted, ok := compactAITraceData(map[string]any{"rows": rows}).(map[string]any)
	if !ok {
		t.Fatalf("compacted trace type = %T", compactAITraceData(map[string]any{"rows": rows}))
	}
	previewRows, ok := compacted["rows"].([]any)
	if !ok || len(previewRows) != 5 {
		t.Fatalf("compacted rows = %#v", compacted["rows"])
	}
	if _, ok := compacted["_trace_truncated"].(map[string]any); !ok {
		t.Fatalf("trace truncation metadata missing: %#v", compacted)
	}
}
