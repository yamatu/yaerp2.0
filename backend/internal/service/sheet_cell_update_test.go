package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestCollapseCellChangesUsesLastValueAndStableLockOrder(t *testing.T) {
	changes := []model.CellUpdate{
		{SheetID: 2, Row: 0, Col: "C", Value: json.RawMessage(`"third"`)},
		{SheetID: 1, Row: 3, Col: " B ", Value: json.RawMessage(`1`)},
		{SheetID: 1, Row: 0, Col: "A"},
		{SheetID: 1, Row: 3, Col: "B", Value: json.RawMessage(`2`)},
	}

	collapsed, err := collapseCellChanges(changes)
	if err != nil {
		t.Fatal(err)
	}
	if len(collapsed) != 3 {
		t.Fatalf("got %d changes, want 3", len(collapsed))
	}

	want := []struct {
		sheetID int64
		row     int
		col     string
		value   string
	}{
		{sheetID: 1, row: 0, col: "A", value: "null"},
		{sheetID: 1, row: 3, col: "B", value: "2"},
		{sheetID: 2, row: 0, col: "C", value: `"third"`},
	}
	for index, expected := range want {
		change := collapsed[index]
		if change.SheetID != expected.sheetID || change.Row != expected.row || change.Col != expected.col || string(change.Value) != expected.value {
			t.Fatalf("change %d = %#v, want %#v", index, change, expected)
		}
	}
}

func TestCollapseCellChangesRejectsInvalidInput(t *testing.T) {
	tests := []model.CellUpdate{
		{SheetID: 0, Row: 0, Col: "A", Value: json.RawMessage(`1`)},
		{SheetID: 1, Row: -1, Col: "A", Value: json.RawMessage(`1`)},
		{SheetID: 1, Row: 0, Col: " ", Value: json.RawMessage(`1`)},
		{SheetID: 1, Row: 0, Col: "A", Value: json.RawMessage(`not-json`)},
	}

	for _, change := range tests {
		if _, err := collapseCellChanges([]model.CellUpdate{change}); err == nil {
			t.Fatalf("invalid change was accepted: %#v", change)
		}
	}
}

func TestRestoreWorksheetCellValuesKeepsOfficialValue(t *testing.T) {
	existing := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"official","s":"old-style"}}}}}`)
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"draft","s":"new-style"}}}}}`)
	columns := json.RawMessage(`[{"key":"status","name":"状态","type":"text"}]`)

	restored, err := restoreWorksheetCellValues(existing, next, columns, []model.CellUpdate{{SheetID: 1, Row: 0, Col: "status", Value: json.RawMessage(`"official"`)}})
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		UniverSheetData struct {
			CellData map[string]map[string]struct {
				Value string `json:"v"`
				Style string `json:"s"`
			} `json:"cellData"`
		} `json:"univerSheetData"`
	}
	if err := json.Unmarshal(restored, &payload); err != nil {
		t.Fatal(err)
	}
	cell := payload.UniverSheetData.CellData["1"]["0"]
	if cell.Value != "official" || cell.Style != "old-style" {
		t.Fatalf("restored cell = %#v", cell)
	}
}
