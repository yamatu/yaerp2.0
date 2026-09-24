package repo

import (
	"errors"
	"testing"
)

func invariantFixture() (map[int64]SheetWriteStats, map[int64]SheetWriteStats, SheetWriteInvariant) {
	before := map[int64]SheetWriteStats{
		1: {Total: 1800, Counts: map[string]int{"qty": 1800, "price": 1800, "weight": 1750}},
	}
	after := map[int64]SheetWriteStats{
		1: {Total: 1800, Counts: map[string]int{"qty": 1800, "price": 1772, "weight": 1750}},
	}
	invariant := SheetWriteInvariant{
		ColumnsBySheet: map[int64][]string{1: {"qty", "price", "weight"}},
		TargetColumns:  map[int64]map[string]struct{}{1: {"price": {}}},
	}
	return before, after, invariant
}

func TestVerifySheetWriteInvariantAcceptsTargetedChange(t *testing.T) {
	before, after, invariant := invariantFixture()
	if err := VerifySheetWriteInvariant(before, after, invariant); err != nil {
		t.Fatalf("targeted column change should pass, got %v", err)
	}
}

func TestVerifySheetWriteInvariantRejectsUntouchedColumnLoss(t *testing.T) {
	before, after, invariant := invariantFixture()
	after[1].Counts["weight"] = 1200

	err := VerifySheetWriteInvariant(before, after, invariant)
	if err == nil {
		t.Fatal("expected a violation when an untouched column loses cells")
	}
	var violation *WriteInvariantViolation
	if !errors.As(err, &violation) {
		t.Fatalf("error type = %T, want *WriteInvariantViolation", err)
	}
	if violation.Column != "weight" || violation.Before != 1750 || violation.After != 1200 {
		t.Fatalf("unexpected violation: %#v", violation)
	}
}

func TestVerifySheetWriteInvariantRejectsRowShrink(t *testing.T) {
	before, after, invariant := invariantFixture()
	stats := after[1]
	stats.Total = 28
	after[1] = stats

	err := VerifySheetWriteInvariant(before, after, invariant)
	if err == nil {
		t.Fatal("expected a violation when the row registry shrinks")
	}
	var violation *WriteInvariantViolation
	if !errors.As(err, &violation) {
		t.Fatalf("error type = %T, want *WriteInvariantViolation", err)
	}
	if violation.Column != "" || violation.Before != 1800 || violation.After != 28 {
		t.Fatalf("unexpected violation: %#v", violation)
	}
}

func TestVerifySheetWriteInvariantIgnoresTargetedColumnLoss(t *testing.T) {
	before, after, invariant := invariantFixture()
	// The batch is allowed to clear the price column it targets.
	after[1].Counts["price"] = 0
	if err := VerifySheetWriteInvariant(before, after, invariant); err != nil {
		t.Fatalf("targeted column clear should pass, got %v", err)
	}
}
