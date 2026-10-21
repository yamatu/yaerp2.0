package service

import (
	"encoding/json"
	"fmt"
	"strconv"
	"testing"
)

func TestShiftFormulaRowsForInsert(t *testing.T) {
	cases := []struct{ formula, want string }{
		{"=M5*N5", "=M6*N6"},
		{"=M4*N4", "=M4*N4"},
		{"=SUM(M2:M100)", "=SUM(M2:M101)"},
		{"=SUM($M$5:$M$9)+$A$1", "=SUM($M$6:$M$10)+$A$1"},
		{"=IF(A5=\"M5*N5\",B5,LOG10(C5))", "=IF(A6=\"M5*N5\",B6,LOG10(C6))"},
		{"=Sheet2!A5+A5", "=Sheet2!A5+A6"},
		{"='Other Sheet'!A5:B9+Sheet1!A5", "='Other Sheet'!A5:B9+Sheet1!A6"},
		{"=SUM(A:A)+A7", "=SUM(A:A)+A8"},
		{"plain text M5", "plain text M5"},
	}
	for _, tc := range cases {
		if got := shiftFormulaRowsForInsert(tc.formula, "Sheet1", 5, 1); got != tc.want {
			t.Errorf("insert at row 5: %s => %s, want %s", tc.formula, got, tc.want)
		}
	}
}

func TestShiftFormulaRowsForDelete(t *testing.T) {
	cases := []struct{ formula, want string }{
		{"=M5*N5", "=#REF!*#REF!"},
		{"=M6*N6", "=M5*N5"},
		{"=M4*N4", "=M4*N4"},
		{"=SUM(M2:M100)", "=SUM(M2:M99)"},
		{"=SUM(M5:M100)", "=SUM(M5:M99)"},
		{"=SUM(M2:M5)", "=SUM(M2:M4)"},
		{"=SUM(M5:M5)", "=SUM(#REF!)"},
		{"=Sheet2!A6+A6", "=Sheet2!A6+A5"},
	}
	for _, tc := range cases {
		if got := shiftFormulaRowsForDelete(tc.formula, "Sheet1", 5); got != tc.want {
			t.Errorf("delete row 5: %s => %s, want %s", tc.formula, got, tc.want)
		}
	}
}

func TestMoveFormulaRelativeRefs(t *testing.T) {
	if got := moveFormulaRelativeRefs("=M2*$N$2+Sheet2!A2", 1, 3); got != "=N5*$N$2+Sheet2!B5" {
		t.Fatalf("unexpected moved formula: %s", got)
	}
	if got := moveFormulaRelativeRefs("=A1", 0, -1); got != "=#REF!" {
		t.Fatalf("moving above the sheet should give #REF!, got %s", got)
	}
}

// fillDownSnapshot builds a sheet with a header and `rows` data rows where
// O = M*N. Column O is a shared formula group (owner + `si` members) and column
// P repeats the formula explicitly, like the two ways the editor stores a
// drag-filled column.
func fillDownSnapshot(rows int) json.RawMessage {
	cellData := map[string]map[string]any{"0": {"12": map[string]any{"v": "数量"}, "13": map[string]any{"v": "单价"}}}
	for row := 1; row <= rows; row++ {
		line := map[string]any{
			"0":  map[string]any{"v": fmt.Sprintf("item-%d", row)},
			"12": map[string]any{"v": row},
			"13": map[string]any{"v": 10},
			"15": map[string]any{"f": fmt.Sprintf("=M%d*N%d", row+1, row+1), "v": row * 10},
		}
		if row == 1 {
			line["14"] = map[string]any{"f": "=M2*N2", "si": "grp1", "v": 10}
		} else {
			line["14"] = map[string]any{"si": "grp1", "v": row * 10}
		}
		cellData[strconv.Itoa(row)] = line
	}
	config := map[string]any{
		"univerSheetData": map[string]any{
			"id":        "sheet-1",
			"name":      "Sheet1",
			"rowCount":  rows + 10,
			"cellData":  cellData,
			"rowData":   map[string]any{"3": map[string]any{"h": 40}},
			"mergeData": []map[string]int{{"startRow": 4, "endRow": 5, "startColumn": 0, "endColumn": 1}},
		},
		"protections": map[string]any{},
	}
	encoded, _ := json.Marshal(config)
	return encoded
}

type decodedSnapshot struct {
	UniverSheetData struct {
		RowCount  int                                  `json:"rowCount"`
		CellData  map[string]map[string]map[string]any `json:"cellData"`
		RowData   map[string]map[string]any            `json:"rowData"`
		MergeData []map[string]int                     `json:"mergeData"`
	} `json:"univerSheetData"`
}

func decodeSnapshot(t *testing.T, config json.RawMessage) decodedSnapshot {
	t.Helper()
	var decoded decodedSnapshot
	if err := json.Unmarshal(config, &decoded); err != nil {
		t.Fatalf("decode shifted config: %v", err)
	}
	return decoded
}

// assertRowsComputeThemselves fails when a formula of column O/P does not
// reference its own row - the misalignment reported from production.
func assertRowsComputeThemselves(t *testing.T, decoded decodedSnapshot, skip map[int]bool) {
	t.Helper()
	for rowKey, row := range decoded.UniverSheetData.CellData {
		worksheetRow, _ := strconv.Atoi(rowKey)
		if worksheetRow == 0 || skip[worksheetRow] {
			continue
		}
		want := fmt.Sprintf("=M%d*N%d", worksheetRow+1, worksheetRow+1)
		for _, column := range []string{"14", "15"} {
			cell := row[column]
			if cell == nil {
				t.Errorf("row %d column %s lost its formula cell", worksheetRow+1, column)
				continue
			}
			if got, _ := cell["f"].(string); got != want {
				t.Errorf("row %d column %s formula = %q, want %q", worksheetRow+1, column, got, want)
			}
			if _, shared := cell["si"]; shared && cell["f"] == nil {
				t.Errorf("row %d column %s is still a shared formula member", worksheetRow+1, column)
			}
		}
	}
}

func TestShiftSnapshotRowsInsertKeepsFormulasOnTheirRow(t *testing.T) {
	const rows = 3000
	// Insert a new worksheet row 1500 (0-based) in the middle of a large sheet.
	shifted, err := shiftSnapshotRowsInConfig(fillDownSnapshot(rows), "Sheet1", 1500, true)
	if err != nil {
		t.Fatalf("shift snapshot: %v", err)
	}
	decoded := decodeSnapshot(t, shifted)
	cells := decoded.UniverSheetData.CellData
	if len(cells) != rows+1 {
		t.Fatalf("expected %d rows with cells, got %d", rows+1, len(cells))
	}
	if _, exists := cells["1500"]; exists {
		t.Fatalf("the inserted row must be empty")
	}
	if got := cells["1501"]["0"]["v"]; got != "item-1500" {
		t.Fatalf("row below the insert should hold item-1500, got %v", got)
	}
	if got := cells[strconv.Itoa(rows+1)]["0"]["v"]; got != fmt.Sprintf("item-%d", rows) {
		t.Fatalf("last row should move down, got %v", got)
	}
	assertRowsComputeThemselves(t, decoded, nil)
	if decoded.UniverSheetData.RowCount != rows+11 {
		t.Fatalf("rowCount = %d, want %d", decoded.UniverSheetData.RowCount, rows+11)
	}
}

func TestShiftSnapshotRowsInsertMovesRowMetadata(t *testing.T) {
	shifted, err := shiftSnapshotRowsInConfig(fillDownSnapshot(20), "Sheet1", 2, true)
	if err != nil {
		t.Fatalf("shift snapshot: %v", err)
	}
	decoded := decodeSnapshot(t, shifted)
	if decoded.UniverSheetData.RowData["4"]["h"] != float64(40) || decoded.UniverSheetData.RowData["3"] != nil {
		t.Fatalf("row height did not move with its row: %+v", decoded.UniverSheetData.RowData)
	}
	merge := decoded.UniverSheetData.MergeData[0]
	if merge["startRow"] != 5 || merge["endRow"] != 6 {
		t.Fatalf("merge did not move with its rows: %+v", merge)
	}
	// The cached value of a rewritten formula is dropped so it is recalculated.
	if _, cached := decoded.UniverSheetData.CellData["5"]["15"]["v"]; cached {
		t.Fatalf("rewritten formula kept a stale cached value")
	}
	if _, cached := decoded.UniverSheetData.CellData["1"]["15"]["v"]; !cached {
		t.Fatalf("untouched formula lost its cached value")
	}
}

func TestShiftSnapshotRowsDeleteKeepsFormulasOnTheirRow(t *testing.T) {
	const rows = 3000
	// Delete worksheet row 1 - the row that owns the shared formula group.
	shifted, err := shiftSnapshotRowsInConfig(fillDownSnapshot(rows), "Sheet1", 1, false)
	if err != nil {
		t.Fatalf("shift snapshot: %v", err)
	}
	decoded := decodeSnapshot(t, shifted)
	cells := decoded.UniverSheetData.CellData
	if len(cells) != rows {
		t.Fatalf("expected %d rows with cells, got %d", rows, len(cells))
	}
	if got := cells["1"]["0"]["v"]; got != "item-2" {
		t.Fatalf("row 2 should move up, got %v", got)
	}
	assertRowsComputeThemselves(t, decoded, nil)
}

func TestShiftSnapshotRowsDeleteMarksBrokenReferences(t *testing.T) {
	config := json.RawMessage(`{"univerSheetData":{"name":"Sheet1","cellData":{"1":{"0":{"v":1}},"2":{"0":{"v":2}},"3":{"0":{"f":"=A2+A3","v":3},"1":{"f":"=SUM(A2:A3)","v":3}}}}}`)
	shifted, err := shiftSnapshotRowsInConfig(config, "Sheet1", 1, false)
	if err != nil {
		t.Fatalf("shift snapshot: %v", err)
	}
	decoded := decodeSnapshot(t, shifted)
	if got := decoded.UniverSheetData.CellData["2"]["0"]["f"]; got != "=#REF!+A2" {
		t.Fatalf("deleted reference = %v", got)
	}
	if got := decoded.UniverSheetData.CellData["2"]["1"]["f"]; got != "=SUM(A2:A2)" {
		t.Fatalf("shrunk range = %v", got)
	}
}

func TestShiftSnapshotRowsLeavesConfigWithoutSnapshotAlone(t *testing.T) {
	config := json.RawMessage(`{"protections":{}}`)
	shifted, err := shiftSnapshotRowsInConfig(config, "Sheet1", 3, true)
	if err != nil || string(shifted) != string(config) {
		t.Fatalf("config without snapshot changed: %s (%v)", shifted, err)
	}
}

func TestInsertShiftsProtectionOfTheRowBelow(t *testing.T) {
	// Insert after data row 4: the new row is 5, the old row 5 becomes 6.
	if next, keep := shiftProtectedRowIndex(5, 5, true); !keep || next != 6 {
		t.Fatalf("row at the insert position should move down, got %d %v", next, keep)
	}
	if next, keep := shiftProtectedRowIndex(4, 5, true); !keep || next != 4 {
		t.Fatalf("row above the insert must stay, got %d %v", next, keep)
	}
}

func TestShiftFormulaColumnsForInsert(t *testing.T) {
	cases := []struct{ formula, want string }{
		{"=B2*C2", "=B2*D2"},
		{"=SUM(A2:C2)", "=SUM(A2:D2)"},
		{"=$C$1+A1", "=$D$1+A1"},
		{"=Other!C2+C2", "=Other!C2+D2"},
		{"=\"C2\"&C2", "=\"C2\"&D2"},
	}
	for _, tc := range cases {
		if got := shiftFormulaColumnsForInsert(tc.formula, "Sheet1", 2); got != tc.want {
			t.Errorf("insert at column C: %s => %s, want %s", tc.formula, got, tc.want)
		}
	}
}

func TestShiftSnapshotColumnsInConfigMovesCellsAndSetsHeader(t *testing.T) {
	config := json.RawMessage(`{"other":1,"univerSheetData":{"name":"Sheet1","columnCount":3,
		"cellData":{"0":{"0":{"v":"A"},"1":{"v":"B"},"2":{"v":"C"}},"1":{"0":{"v":1},"1":{"v":2},"2":{"f":"=A2*B2","v":2}}},
		"columnData":{"1":{"w":80},"2":{"w":90}},
		"mergeData":[{"startRow":3,"endRow":3,"startColumn":0,"endColumn":2}]}}`)
	next, err := shiftSnapshotColumnsInConfig(config, "Sheet1", 1, "新列")
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Other int `json:"other"`
		Sheet struct {
			ColumnCount int                                  `json:"columnCount"`
			CellData    map[string]map[string]map[string]any `json:"cellData"`
			ColumnData  map[string]map[string]float64        `json:"columnData"`
			MergeData   []map[string]int                     `json:"mergeData"`
		} `json:"univerSheetData"`
	}
	if err := json.Unmarshal(next, &payload); err != nil {
		t.Fatal(err)
	}
	sheet := payload.Sheet
	if payload.Other != 1 || sheet.ColumnCount != 4 {
		t.Fatalf("config = %s", next)
	}
	if sheet.CellData["0"]["1"]["v"] != "新列" || sheet.CellData["0"]["2"]["v"] != "B" || sheet.CellData["0"]["3"]["v"] != "C" {
		t.Fatalf("header = %v", sheet.CellData["0"])
	}
	if sheet.CellData["1"]["0"]["v"] != float64(1) || sheet.CellData["1"]["2"]["v"] != float64(2) {
		t.Fatalf("data row = %v", sheet.CellData["1"])
	}
	if formula := sheet.CellData["1"]["3"]["f"]; formula != "=A2*C2" {
		t.Fatalf("formula = %v, want =A2*C2", formula)
	}
	if sheet.ColumnData["2"]["w"] != 80 || sheet.ColumnData["3"]["w"] != 90 {
		t.Fatalf("column data = %v", sheet.ColumnData)
	}
	if merge := sheet.MergeData[0]; merge["startColumn"] != 0 || merge["endColumn"] != 3 {
		t.Fatalf("merge = %v", merge)
	}
}

func TestShiftSnapshotColumnsInConfigWithoutSnapshot(t *testing.T) {
	config := json.RawMessage(`{"protections":[]}`)
	next, err := shiftSnapshotColumnsInConfig(config, "Sheet1", 0, "x")
	if err != nil || string(next) != string(config) {
		t.Fatalf("config without snapshot changed: %s %v", next, err)
	}
}
