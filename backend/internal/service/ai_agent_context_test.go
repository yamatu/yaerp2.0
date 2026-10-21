package service

import (
	"encoding/json"
	"strings"
	"testing"
)

func findToolDefinition(t *testing.T, name string) openAIToolDefinition {
	t.Helper()
	for _, definition := range (&AIService{}).buildToolDefinitions() {
		if definition.Function.Name == name {
			return definition
		}
	}
	t.Fatalf("tool %q is not defined", name)
	return openAIToolDefinition{}
}

func TestCheckWriteToolArgumentsRejectsMisspelledArguments(t *testing.T) {
	definition := findToolDefinition(t, "batch_update_cells")
	err := checkWriteToolArguments(definition, map[string]any{"sheet_id": 1, "cells": []any{}})
	if err == nil || !strings.Contains(err.Error(), "cells") || !strings.Contains(err.Error(), "updates") {
		t.Fatalf("expected an error naming the bad and the valid arguments, got %v", err)
	}
	if err := checkWriteToolArguments(definition, map[string]any{"sheet_id": 1, "updates": []any{}, "disable_formula": true, "_open_workbook_id": 3}); err != nil {
		t.Fatalf("declared and injected arguments must pass: %v", err)
	}
	if err := checkWriteToolArguments(findToolDefinition(t, "insert_row"), map[string]any{"sheet_id": 1, "row": 0, "values": map[string]any{}}); err != nil {
		t.Fatalf("accepted alias must pass: %v", err)
	}
}

func TestEveryToolSchemaKeepsArgumentsInsideProperties(t *testing.T) {
	allowed := map[string]bool{"type": true, "properties": true, "required": true}
	for _, definition := range (&AIService{}).buildToolDefinitions() {
		for key := range definition.Function.Parameters {
			if !allowed[key] {
				t.Errorf("tool %s declares %q outside properties, so the model never sees it", definition.Function.Name, key)
			}
		}
	}
}

func TestPreviewSheetIDsPrefersSelectionThenPinnedSheets(t *testing.T) {
	got := previewSheetIDs(&ChatContext{SheetIDs: []int64{4, 5, 6}, Selection: &ChatSelectionContext{SheetID: 5}}, nil)
	if len(got) != 2 || got[0] != 5 || got[1] != 4 {
		t.Fatalf("preview sheets = %v, want [5 4]", got)
	}
	if got := previewSheetIDs(&ChatContext{}, []int64{9}); len(got) != 1 || got[0] != 9 {
		t.Fatalf("single-sheet workbook preview = %v", got)
	}
	if got := previewSheetIDs(&ChatContext{}, []int64{9, 10}); len(got) != 0 {
		t.Fatalf("multi-sheet workbook without a pinned sheet must not guess: %v", got)
	}
}

func TestInheritedRowFormulasFollowsConsistentNeighbours(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "qty", Type: "number"}, {Key: "price", Type: "number"},
		{Key: "amount", Type: "number"}, {Key: "note", Type: "text"}, {Key: "total", Type: "formula"},
	}
	// Worksheet rows 1-2 are data, row 3 is the freshly inserted blank row,
	// row 4 is the data that moved down. Column 3 has a one-off formula.
	config := json.RawMessage(`{"univerSheetData":{"cellData":{
		"1":{"2":{"f":"=A2*B2","v":2},"3":{"f":"=NOW()"},"4":{"f":"=C2+1"}},
		"2":{"2":{"f":"=A3*B3"},"4":{"f":"=C3+1"}},
		"4":{"2":{"f":"=A5*B5"},"4":{"f":"=C5+1"}}}}}`)
	got := inheritedRowFormulas(config, columns, 2, map[string]any{})
	if got["amount"] != "=A4*B4" || got["total"] != "=C4+1" {
		t.Fatalf("inherited = %v", got)
	}
	if _, copied := got["note"]; copied {
		t.Fatal("a one-off formula must not be copied")
	}
	if got := inheritedRowFormulas(config, columns, 2, map[string]any{"amount": 5}); got["amount"] != nil {
		t.Fatalf("explicit values win: %v", got)
	}

	// Appending under a single formula row: only declared formula columns extend.
	single := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"2":{"f":"=A2*B2"},"4":{"f":"=C2+1"}}}}}`)
	got = inheritedRowFormulas(single, columns, 1, nil)
	if got["total"] != "=C3+1" || got["amount"] != nil {
		t.Fatalf("append inherited = %v", got)
	}
}
