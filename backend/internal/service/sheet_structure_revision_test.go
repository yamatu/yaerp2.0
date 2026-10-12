package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"testing"

	"yaerp/internal/model"
)

// priceSheetConfig builds header + rows where A is the item, B the price and
// C = B*2. Many rows share the same price, like real order sheets do.
func priceSheetConfig(items []string, prices []int, rowCount int, revision int64) json.RawMessage {
	cellData := map[string]map[string]any{"0": {"0": map[string]any{"v": "item"}}}
	for index, item := range items {
		if item == "" {
			continue
		}
		row := index + 1
		cellData[strconv.Itoa(row)] = map[string]any{
			"0": map[string]any{"v": item},
			"1": map[string]any{"v": prices[index]},
			"2": map[string]any{"f": fmt.Sprintf("=B%d*2", row+1), "v": prices[index] * 2},
		}
	}
	config := map[string]any{"univerSheetData": map[string]any{"rowCount": rowCount, "cellData": cellData}}
	if revision > 0 {
		config["structureRevision"] = revision
	}
	encoded, _ := json.Marshal(config)
	return encoded
}

func priceSheetRows(t *testing.T, config json.RawMessage) map[string]string {
	t.Helper()
	cells := decodeMergedCellData(t, config)
	rows := make(map[string]string)
	for rowKey, row := range cells {
		if rowKey == "0" {
			continue
		}
		rows[rowKey] = fmt.Sprintf("%v|%v|%v", row["0"]["v"], row["1"]["v"], row["2"]["f"])
	}
	return rows
}

var priceColumns = json.RawMessage(`[{"key":"item"},{"key":"price"},{"key":"total"}]`)

// The client inserted a row above "c" while the server holds a price edit for
// "c" the client never received. The client only lists cells whose content
// differs by position, so the equal-priced neighbours are not in its change
// set - and the positional merge used to keep the server value of the *old*
// row index, attaching another item's price to row 4.
func structuralSaveFixture() (existing, next *model.Sheet, changes []model.CellUpdate) {
	// Server: a=10, b=10, c=99 (edited by a collaborator), d=10.
	existing = &model.Sheet{ID: 1, Columns: priceColumns, Config: priceSheetConfig([]string{"a", "b", "c", "d"}, []int{10, 10, 99, 10}, 20, 3)}
	// Client (still believes c=10) inserted an empty row before "b".
	next = &model.Sheet{ID: 1, Columns: priceColumns, Config: priceSheetConfig([]string{"a", "", "b", "c", "d"}, []int{10, 0, 10, 10, 10}, 21, 3)}
	raw := func(value any) json.RawMessage { encoded, _ := json.Marshal(value); return encoded }
	// Diff against the client's belief (a,b,c,d all 10): prices at rows 3 and 4
	// are unchanged by position, so only items, formulas and the tail are sent.
	changes = []model.CellUpdate{
		{SheetID: 1, Row: 1, Col: "item", Value: raw("")}, {SheetID: 1, Row: 1, Col: "price", Value: raw("")}, {SheetID: 1, Row: 1, Col: "total", Value: raw("")},
		{SheetID: 1, Row: 2, Col: "item", Value: raw("b")}, {SheetID: 1, Row: 2, Col: "total", Value: raw("=B4*2")},
		{SheetID: 1, Row: 3, Col: "item", Value: raw("c")}, {SheetID: 1, Row: 3, Col: "total", Value: raw("=B5*2")},
		{SheetID: 1, Row: 4, Col: "item", Value: raw("d")}, {SheetID: 1, Row: 4, Col: "price", Value: raw(10)}, {SheetID: 1, Row: 4, Col: "total", Value: raw("=B6*2")},
	}
	return existing, next, changes
}

func TestPositionalMergeMisalignsRowsAfterStructuralChange(t *testing.T) {
	service := &SheetService{}
	existing, next, changes := structuralSaveFixture()
	if _, err := service.PrepareSheetCellChanges(1, existing, next, changes, "web"); err != nil {
		t.Fatal(err)
	}
	rows := priceSheetRows(t, next.Config)
	// Documents the root cause: without the structural flag the collaborator's
	// price for "c" (99) is restored at row index 3, which now holds "b".
	if rows["3"] != "b|99|=B4*2" {
		t.Fatalf("expected the legacy positional merge to misalign row 3, got %q", rows["3"])
	}
}

func TestStructuralSaveKeepsRowsConsistent(t *testing.T) {
	service := &SheetService{}
	existing, next, changes := structuralSaveFixture()
	base := int64(3)
	result, err := service.PrepareSheetCellChangesWithOptions(1, existing, next, changes, "web", SheetSaveOptions{StructureChanged: true, BaseStructureRevision: &base})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.AppliedChanges) != len(changes) {
		t.Fatalf("applied %d changes, want %d", len(result.AppliedChanges), len(changes))
	}
	rows := priceSheetRows(t, next.Config)
	want := map[string]string{"1": "a|10|=B2*2", "3": "b|10|=B4*2", "4": "c|10|=B5*2", "5": "d|10|=B6*2"}
	for rowKey, expected := range want {
		if rows[rowKey] != expected {
			t.Errorf("row %s = %q, want %q", rowKey, rows[rowKey], expected)
		}
	}
	if _, exists := rows["2"]; exists {
		t.Errorf("inserted row must stay empty, got %q", rows["2"])
	}
	if got := SheetStructureRevision(next.Config); got != 4 {
		t.Fatalf("structure revision = %d, want 4", got)
	}
}

func TestSaveBasedOnOldStructureIsRejected(t *testing.T) {
	service := &SheetService{}
	existing, next, changes := structuralSaveFixture()
	stale := int64(2)
	// A plain cell edit addressed with the row indexes of an older layout.
	_, err := service.PrepareSheetCellChangesWithOptions(1, existing, next, changes[:1], "web", SheetSaveOptions{BaseStructureRevision: &stale})
	if !errors.Is(err, ErrSheetStructureConflict) {
		t.Fatalf("expected a structure conflict, got %v", err)
	}
}

func TestNonStructuralSaveKeepsRevisionAndMerge(t *testing.T) {
	service := &SheetService{}
	existing := &model.Sheet{ID: 1, Columns: priceColumns, Config: priceSheetConfig([]string{"a", "b"}, []int{10, 20}, 20, 5)}
	// The client echoes a stale revision and a stale price for "b".
	next := &model.Sheet{ID: 1, Columns: priceColumns, Config: priceSheetConfig([]string{"a", "b"}, []int{11, 7}, 20, 1)}
	base := int64(5)
	change := model.CellUpdate{SheetID: 1, Row: 0, Col: "price", Value: json.RawMessage(`11`)}
	if _, err := service.PrepareSheetCellChangesWithOptions(1, existing, next, []model.CellUpdate{change}, "web", SheetSaveOptions{BaseStructureRevision: &base}); err != nil {
		t.Fatal(err)
	}
	rows := priceSheetRows(t, next.Config)
	if rows["1"] != "a|11|=B2*2" || rows["2"] != "b|20|=B3*2" {
		t.Fatalf("unexpected merge result: %+v", rows)
	}
	if got := SheetStructureRevision(next.Config); got != 5 {
		t.Fatalf("structure revision = %d, want 5", got)
	}
}

func TestStructuralSaveDoesNotSendMovedCellsToApproval(t *testing.T) {
	existing, next, changes := structuralSaveFixture()
	var intercepted []model.CellUpdate
	service := &SheetService{}
	service.SetCellApprovalInterceptor(func(_ int64, edits []model.CellUpdate, _ string) (*model.CellUpdateResult, error) {
		intercepted = edits
		// An approval rule on every column: everything it sees is reverted.
		return &model.CellUpdateResult{RevertedChanges: edits}, nil
	})
	if _, err := service.PrepareSheetCellChangesWithOptions(1, existing, next, changes, "web", SheetSaveOptions{StructureChanged: true}); err != nil {
		t.Fatal(err)
	}
	if len(intercepted) != 0 {
		t.Fatalf("moved cells were treated as edits: %+v", intercepted)
	}
	rows := priceSheetRows(t, next.Config)
	if rows["3"] != "b|10|=B4*2" || rows["5"] != "d|10|=B6*2" {
		t.Fatalf("rows were reverted by position: %+v", rows)
	}
}

func TestSheetStructureRevisionRoundTrip(t *testing.T) {
	if got := SheetStructureRevision(json.RawMessage(`{"univerSheetData":{}}`)); got != 0 {
		t.Fatalf("missing revision should be 0, got %d", got)
	}
	bumped, err := bumpSheetStructureRevision(json.RawMessage(`{"univerSheetData":{"rowCount":3}}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := SheetStructureRevision(bumped); got != 1 {
		t.Fatalf("bumped revision = %d, want 1", got)
	}
	if snapshotRowCount(bumped) != 3 {
		t.Fatalf("bumping the revision changed the snapshot: %s", bumped)
	}
}
