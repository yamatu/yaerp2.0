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

func decodeMergedCellData(t *testing.T, raw json.RawMessage) map[string]map[string]map[string]interface{} {
	t.Helper()
	var payload struct {
		UniverSheetData struct {
			CellData map[string]map[string]map[string]interface{} `json:"cellData"`
		} `json:"univerSheetData"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		t.Fatalf("unmarshal merged config: %v", err)
	}
	return payload.UniverSheetData.CellData
}

func TestMergeConcurrentCellValuesKeepsRemoteEdit(t *testing.T) {
	columns := json.RawMessage(`[{"key":"a"},{"key":"b"}]`)
	// The server already holds the collaborator's edit to a1.
	existing := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-server"}},"2":{"1":{"v":"B"}}}}}`)
	// The local client's stale snapshot still shows the old a1 value and its own b2 edit.
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-stale"}},"2":{"1":{"v":"B2"}}}}}`)

	merged, err := mergeConcurrentCellValues(existing, next, columns, []model.CellUpdate{{SheetID: 1, Row: 1, Col: "b", Value: json.RawMessage(`"B2"`)}})
	if err != nil {
		t.Fatal(err)
	}
	cells := decodeMergedCellData(t, merged)
	if got := cells["1"]["0"]["v"]; got != "A-server" {
		t.Fatalf("concurrent edit was overwritten: a1 = %#v, want A-server", got)
	}
	if got := cells["2"]["1"]["v"]; got != "B2" {
		t.Fatalf("local edit was not applied: b2 = %#v, want B2", got)
	}
}

func TestMergeConcurrentCellValuesKeepsLocalValueAndStyle(t *testing.T) {
	columns := json.RawMessage(`[{"key":"a"},{"key":"b"}]`)
	existing := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-server","s":"old-style"}}}}}`)
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-local","s":"new-style"}},"2":{"1":{"v":"B2"}}}}}`)

	merged, err := mergeConcurrentCellValues(existing, next, columns, []model.CellUpdate{
		{SheetID: 1, Row: 0, Col: "a", Value: json.RawMessage(`"A-local"`)},
		{SheetID: 1, Row: 1, Col: "b", Value: json.RawMessage(`"B2"`)},
	})
	if err != nil {
		t.Fatal(err)
	}
	cells := decodeMergedCellData(t, merged)
	if got := cells["1"]["0"]["v"]; got != "A-local" {
		t.Fatalf("local value edit was not kept: a1 = %#v", got)
	}
	if got := cells["1"]["0"]["s"]; got != "new-style" {
		t.Fatalf("local style edit was not kept: a1 style = %#v", got)
	}
}

func TestMergeConcurrentCellValuesRestoresDroppedCell(t *testing.T) {
	columns := json.RawMessage(`[{"key":"a"},{"key":"b"}]`)
	existing := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-server"}}}}}`)
	// The stale client dropped a1 entirely, but it never edited that cell.
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"2":{"1":{"v":"B2"}}}}}`)

	merged, err := mergeConcurrentCellValues(existing, next, columns, []model.CellUpdate{{SheetID: 1, Row: 1, Col: "b", Value: json.RawMessage(`"B2"`)}})
	if err != nil {
		t.Fatal(err)
	}
	cells := decodeMergedCellData(t, merged)
	if got := cells["1"]["0"]["v"]; got != "A-server" {
		t.Fatalf("dropped concurrent cell was not restored: a1 = %#v", got)
	}
}

func TestMergeConcurrentCellValuesRestoresServerWithoutLocalChanges(t *testing.T) {
	columns := json.RawMessage(`[{"key":"a"}]`)
	existing := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-server"}}}}}`)
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"A-stale","s":"local-style"}}}}}`)

	merged, err := mergeConcurrentCellValues(existing, next, columns, nil)
	if err != nil {
		t.Fatal(err)
	}
	cells := decodeMergedCellData(t, merged)
	if got := cells["1"]["0"]["v"]; got != "A-server" {
		t.Fatalf("style-only save must not clobber server value: a1 = %#v", got)
	}
	if got := cells["1"]["0"]["s"]; got != "local-style" {
		t.Fatalf("local style must be preserved: a1 style = %#v", got)
	}
}

func TestPrepareSheetCellChangesMergesStyleOnlySave(t *testing.T) {
	service := &SheetService{}
	existing := &model.Sheet{
		ID:      1,
		Columns: json.RawMessage(`[{"key":"a"}]`),
		Config:  json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"server"}}}}}`),
	}
	next := &model.Sheet{
		ID:      1,
		Columns: json.RawMessage(`[{"key":"a"}]`),
		Config:  json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"stale","s":"style"}}}}}`),
	}

	result, err := service.PrepareSheetCellChanges(1, existing, next, nil, "web")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.AppliedChanges) != 0 {
		t.Fatalf("unexpected applied changes: %#v", result.AppliedChanges)
	}
	cells := decodeMergedCellData(t, next.Config)
	if got := cells["1"]["0"]["v"]; got != "server" {
		t.Fatalf("stale value survived style-only save: a1 = %#v", got)
	}
	if got := cells["1"]["0"]["s"]; got != "style" {
		t.Fatalf("local style was lost: a1 style = %#v", got)
	}
}
