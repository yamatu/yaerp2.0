package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestParseAgentA1Range(t *testing.T) {
	cases := map[string]agentSheetRange{
		"A1:F200": {StartRow: 0, EndRow: 199, StartColumn: 0, EndColumn: 5},
		"b2:d10":  {StartRow: 1, EndRow: 9, StartColumn: 1, EndColumn: 3},
		"$C$5":    {StartRow: 4, EndRow: 4, StartColumn: 2, EndColumn: 2},
		"B:D":     {StartRow: -1, EndRow: -1, StartColumn: 1, EndColumn: 3},
		"2:50":    {StartRow: 1, EndRow: 49, StartColumn: -1, EndColumn: -1},
		"F20:A2":  {StartRow: 1, EndRow: 19, StartColumn: 0, EndColumn: 5},
	}
	for input, want := range cases {
		got, err := parseAgentA1Range(input)
		if err != nil || got == nil {
			t.Fatalf("parseAgentA1Range(%q) error %v", input, err)
		}
		if got.StartRow != want.StartRow || got.EndRow != want.EndRow || got.StartColumn != want.StartColumn || got.EndColumn != want.EndColumn {
			t.Errorf("parseAgentA1Range(%q) = %+v, want %+v", input, *got, want)
		}
	}
	if got, err := parseAgentA1Range("  "); err != nil || got != nil {
		t.Fatalf("empty range should mean the whole sheet, got %+v %v", got, err)
	}
	for _, bad := range []string{"A1:B", "hello", "A1;B2", "1A:2B"} {
		if _, err := parseAgentA1Range(bad); err == nil {
			t.Errorf("parseAgentA1Range(%q) should fail", bad)
		}
	}
}

func scopeTestRows(t *testing.T) ([]sheetColumnPayload, []model.Row) {
	t.Helper()
	columns := []sheetColumnPayload{{Key: "name"}, {Key: "qty"}, {Key: "price"}, {Key: "note"}}
	rows := make([]model.Row, 0, 6)
	for index := 0; index < 6; index++ {
		data, _ := json.Marshal(map[string]any{"name": index, "qty": index * 10, "price": 5, "note": "x"})
		rows = append(rows, model.Row{SheetID: 7, RowIndex: index, Data: data})
	}
	return columns, rows
}

func TestScopeAgentReadClipsRowsAndColumns(t *testing.T) {
	columns, rows := scopeTestRows(t)
	sheetRange, _ := parseAgentA1Range("B3:C5") // worksheet rows 3-5 = data rows 1-3
	scope := newAgentReadScope()
	scope.add(7, "S", sheetRange)
	args := map[string]any{agentReadScopeArg: scope}

	keptColumns, keptRows, err := scopeAgentRead(args, &model.Sheet{ID: 7}, columns, rows)
	if err != nil {
		t.Fatal(err)
	}
	if len(keptColumns) != 2 || keptColumns[0].Key != "qty" || keptColumns[1].Key != "price" {
		t.Fatalf("columns = %+v, want qty, price", keptColumns)
	}
	if len(keptRows) != 3 || keptRows[0].RowIndex != 1 || keptRows[2].RowIndex != 3 {
		t.Fatalf("rows = %d (first %d), want data rows 1-3", len(keptRows), keptRows[0].RowIndex)
	}
	if strings.Contains(string(keptRows[0].Data), "name") || strings.Contains(string(keptRows[0].Data), "note") {
		t.Fatalf("values outside the range were kept: %s", keptRows[0].Data)
	}
	if err := ensureColumnsInScope(args, keptColumns, []string{"name"}); err == nil {
		t.Fatal("a column outside the range must be rejected")
	}
	if err := ensureColumnsInScope(args, keptColumns, []string{"qty"}); err != nil {
		t.Fatalf("a column in the range was rejected: %v", err)
	}
}

func TestScopeAgentReadKeepsWholeSheetsAndRejectsOthers(t *testing.T) {
	columns, rows := scopeTestRows(t)
	scope := newAgentReadScope()
	scope.add(7, "S", nil)
	args := map[string]any{agentReadScopeArg: scope}
	keptColumns, keptRows, err := scopeAgentRead(args, &model.Sheet{ID: 7}, columns, rows)
	if err != nil || len(keptColumns) != 4 || len(keptRows) != 6 {
		t.Fatalf("whole sheet was clipped: %d columns %d rows %v", len(keptColumns), len(keptRows), err)
	}
	if _, _, err := scopeAgentRead(args, &model.Sheet{ID: 8}, columns, rows); err == nil {
		t.Fatal("a sheet outside the scope must not be readable")
	}
	if err := checkAgentReadScope(map[string]any{agentReadScopeArg: scope, "sheet_id": float64(8)}); err == nil {
		t.Fatal("a tool call on another sheet must be rejected")
	}
	if err := checkAgentReadScope(map[string]any{agentReadScopeArg: scope, "sheet_id": float64(7)}); err != nil {
		t.Fatalf("a tool call on the scoped sheet was rejected: %v", err)
	}
	// No scope: unchanged.
	if keptColumns, keptRows, err := scopeAgentRead(map[string]any{}, &model.Sheet{ID: 8}, columns, rows); err != nil || len(keptColumns) != 4 || len(keptRows) != 6 {
		t.Fatal("reads without a scope must be unchanged")
	}
}

// A range that does not start at column A must not shift values onto the
// wrong columns: snapshot cells map to columns by position.
func TestScopeAgentReadSnapshotKeepsColumnsAligned(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "name", Name: "产品"}, {Key: "qty", Name: "销量"}, {Key: "price", Name: "单价"}, {Key: "note", Name: "备注"}}
	cellData := map[string]any{"0": map[string]any{"0": map[string]any{"v": "产品"}, "1": map[string]any{"v": "销量"}, "2": map[string]any{"v": "单价"}, "3": map[string]any{"v": "备注"}}}
	for row := 1; row <= 6; row++ {
		cellData[strconv.Itoa(row)] = map[string]any{
			"0": map[string]any{"v": fmt.Sprintf("产品%d", row)}, "1": map[string]any{"v": row * 10},
			"2": map[string]any{"v": row * 100}, "3": map[string]any{"v": "机密"},
		}
	}
	config, _ := json.Marshal(map[string]any{"univerSheetData": map[string]any{"cellData": cellData}})
	sheet := &model.Sheet{ID: 7, Config: config}
	sheetRange, _ := parseAgentA1Range("B3:C5")
	scope := newAgentReadScope()
	scope.add(7, "S", sheetRange)

	keptColumns, keptRows, err := scopeAgentRead(map[string]any{agentReadScopeArg: scope}, sheet, columns, nil)
	if err != nil {
		t.Fatal(err)
	}
	preview := make([]aiPreviewRow, 0, 3)
	for _, row := range buildAIPreviewRows(sheet, keptColumns, keptRows) {
		if len(row.Data) > 0 { // leading blank rows are padded with an empty entry
			preview = append(preview, row)
		}
	}
	if len(preview) != 3 {
		t.Fatalf("preview rows = %d, want 3 (worksheet rows 3-5): %+v", len(preview), preview)
	}
	for _, row := range preview {
		worksheetRow := row.Row + 1
		if row.Data["qty"] != float64(worksheetRow*10) || row.Data["price"] != float64(worksheetRow*100) {
			t.Fatalf("row %d is misaligned: %v", row.Row, row.Data)
		}
		if _, leaked := row.Data["name"]; leaked {
			t.Fatalf("column outside the range leaked: %v", row.Data)
		}
		if _, leaked := row.Data["note"]; leaked {
			t.Fatalf("column outside the range leaked: %v", row.Data)
		}
	}
}
