package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestValidateFormulaColumnWriteRejectsLiteral(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "amount", Name: "金额", Type: "formula"},
		{Key: "note", Name: "备注", Type: "text"},
	}

	cases := []struct {
		name    string
		key     string
		value   string
		wantErr bool
	}{
		{name: "literal number into formula column", key: "amount", value: `100`, wantErr: true},
		{name: "literal text into formula column", key: "amount", value: `"现金"`, wantErr: true},
		{name: "null into formula column", key: "amount", value: `null`, wantErr: true},
		{name: "formula into formula column", key: "amount", value: `"=SUM(B2:C2)"`, wantErr: false},
		{name: "formula with leading space", key: "amount", value: `"  =A2+B2"`, wantErr: false},
		{name: "literal into text column", key: "note", value: `"hello"`, wantErr: false},
		{name: "unknown column is not this guard's job", key: "missing", value: `1`, wantErr: false},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := validateFormulaColumnWrite(columns, 7, testCase.key, json.RawMessage(testCase.value), false)
			if testCase.wantErr {
				if err == nil {
					t.Fatalf("expected a rejection for %s=%s", testCase.key, testCase.value)
				}
				if !errors.Is(err, ErrFormulaColumnLiteral) {
					t.Fatalf("error %v does not wrap ErrFormulaColumnLiteral", err)
				}
				if !strings.Contains(err.Error(), FormulaColumnCode) {
					t.Fatalf("error %q is missing the %s code", err.Error(), FormulaColumnCode)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected rejection: %v", err)
			}
		})
	}
}

func TestValidateFormulaColumnWriteAllowsExplicitOverride(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "amount", Name: "金额", Type: "formula"}}
	if err := validateFormulaColumnWrite(columns, 7, "amount", json.RawMessage(`123`), true); err != nil {
		t.Fatalf("override should allow a literal write, got %v", err)
	}
}

func TestValidateFormulaColumnWriteMatchesColumnKeyCaseInsensitively(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "Amount", Name: "金额", Type: "FORMULA"}}
	if err := validateFormulaColumnWrite(columns, 7, "amount", json.RawMessage(`1`), false); err == nil {
		t.Fatal("case-insensitive formula column should reject a literal")
	}
}

func TestDistinctColumnKeysIsSorted(t *testing.T) {
	changes := []model.CellUpdate{
		{SheetID: 1, Row: 0, Col: "price"},
		{SheetID: 1, Row: 1, Col: "qty"},
		{SheetID: 1, Row: 2, Col: "price"},
		{SheetID: 1, Row: 3, Col: "  "},
	}
	got := distinctColumnKeys(changes)
	if len(got) != 2 || got[0] != "price" || got[1] != "qty" {
		t.Fatalf("distinctColumnKeys = %#v, want [price qty]", got)
	}
}

func TestBuildSheetWriteInvariantMarksTargetColumns(t *testing.T) {
	columnsBySheet := map[int64][]sheetColumnPayload{
		1: {{Key: "qty"}, {Key: "price"}},
	}
	changes := []model.CellUpdate{{SheetID: 1, Row: 0, Col: "price"}}

	invariant := buildSheetWriteInvariant(changes, columnsBySheet)
	if got := invariant.ColumnsBySheet[1]; len(got) != 2 {
		t.Fatalf("ColumnsBySheet = %#v", invariant.ColumnsBySheet)
	}
	if _, ok := invariant.TargetColumns[1]["price"]; !ok {
		t.Fatal("price should be a target column")
	}
	if _, ok := invariant.TargetColumns[1]["qty"]; ok {
		t.Fatal("qty must not be marked as a target column")
	}
}
