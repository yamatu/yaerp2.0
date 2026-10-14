package service

import (
	"errors"
	"testing"

	"yaerp/internal/model"
)

func TestMapStructureIndexMatchesUniverMoves(t *testing.T) {
	// Moving rows 2-3 down before row 6: 4,5 slide up, the block lands at 4-5.
	down := model.SheetStructureOp{Kind: "move", Axis: "row", Start: 2, Count: 2, Target: 6}
	for from, want := range map[int]int{0: 0, 2: 4, 3: 5, 4: 2, 5: 3, 6: 6} {
		if got, _ := mapStructureIndex(down, from); got != want {
			t.Fatalf("move down: %d -> %d, want %d", from, got, want)
		}
	}
	// Moving rows 5-6 up before row 1: 1-4 slide down by 2.
	up := model.SheetStructureOp{Kind: "move", Axis: "row", Start: 5, Count: 2, Target: 1}
	for from, want := range map[int]int{0: 0, 1: 3, 4: 6, 5: 1, 6: 2, 7: 7} {
		if got, _ := mapStructureIndex(up, from); got != want {
			t.Fatalf("move up: %d -> %d, want %d", from, got, want)
		}
	}
}

func TestRemapProtectionsFollowsInsertedRowsAndColumns(t *testing.T) {
	owner := protectionOwner{OwnerID: 1, Hidden: true}
	protections := protectionMaps{
		Rows:    map[string]protectionOwner{"4": owner},
		Columns: map[string]protectionOwner{"col_b": owner},
		Cells:   map[string]protectionOwner{"9:col_c": owner},
	}
	current := []string{"col_a", "col_b", "col_c"}
	next := []string{"col_a", "col_b", "col_c", "col_4"}
	ops := []model.SheetStructureOp{
		{Kind: "insert", Axis: "row", Start: 3, Count: 2},  // above data row 4 (worksheet 5)
		{Kind: "insert", Axis: "column", Start: 0, Count: 1}, // before column A
	}

	got, _, err := remapProtectionsForStructureOps(protections, nil, current, next, ops)
	if err != nil {
		t.Fatalf("remap: %v", err)
	}
	if _, ok := got.Rows["6"]; !ok || len(got.Rows) != 1 {
		t.Fatalf("row protection did not follow the insert: %#v", got.Rows)
	}
	if _, ok := got.Columns["col_c"]; !ok || len(got.Columns) != 1 {
		t.Fatalf("column protection did not follow the insert: %#v", got.Columns)
	}
	if _, ok := got.Cells["11:col_4"]; !ok || len(got.Cells) != 1 {
		t.Fatalf("cell protection did not follow both inserts: %#v", got.Cells)
	}
}

func TestRemapProtectionsRejectsDeletingProtectedRowOrColumn(t *testing.T) {
	owner := protectionOwner{OwnerID: 1, Hidden: true}
	columns := []string{"col_a", "col_b"}

	rowProtected := protectionMaps{Cells: map[string]protectionOwner{"2:col_a": owner}}
	_, _, err := remapProtectionsForStructureOps(rowProtected, nil, columns, columns, []model.SheetStructureOp{{Kind: "remove", Axis: "row", Start: 3, Count: 1}})
	if !errors.Is(err, ErrProtectionDenied) {
		t.Fatalf("expected removing a masked row to fail, got %v", err)
	}

	columnProtected := protectionMaps{Columns: map[string]protectionOwner{"col_b": owner}}
	_, _, err = remapProtectionsForStructureOps(columnProtected, nil, columns, columns, []model.SheetStructureOp{{Kind: "remove", Axis: "column", Start: 1, Count: 1}})
	if !errors.Is(err, ErrProtectionDenied) {
		t.Fatalf("expected removing a masked column to fail, got %v", err)
	}

	// Removing another row moves the protection up instead.
	got, _, err := remapProtectionsForStructureOps(rowProtected, nil, columns, columns, []model.SheetStructureOp{{Kind: "remove", Axis: "row", Start: 1, Count: 1}})
	if err != nil {
		t.Fatalf("removing an unprotected row: %v", err)
	}
	if _, ok := got.Cells["1:col_a"]; !ok {
		t.Fatalf("cell protection did not move up: %#v", got.Cells)
	}
}

func TestValidateStructureOpsRejectsMalformedMoves(t *testing.T) {
	if err := validateStructureOps([]model.SheetStructureOp{{Kind: "move", Axis: "row", Start: 2, Count: 3, Target: 3}}); err == nil {
		t.Fatal("expected a move into its own block to be rejected")
	}
	if err := validateStructureOps([]model.SheetStructureOp{{Kind: "drop", Axis: "row", Start: 0, Count: 1}}); err == nil {
		t.Fatal("expected an unknown kind to be rejected")
	}
}
