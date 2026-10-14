package service

import (
	"encoding/json"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func hiddenFormulaTestProtections() protectionMaps {
	unlocked := false
	return protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{"price": {OwnerID: 1, HideFormula: true, LockEditing: &unlocked, ViewHiddenUserIDs: []int64{4}}},
		Cells:   map[string]protectionOwner{},
	}
}

func TestMaskUniverSheetConfigStripsHiddenFormulas(t *testing.T) {
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "成本"}, "1": {"v": "售价"}, "2": {"v": "备注"}},
				"1": {"0": {"v": 10}, "1": {"v": 13, "f": "=A2*1.3", "si": "g1"}, "2": {"v": 13, "f": "=B2"}},
				"2": {"0": {"v": 20}, "1": {"v": 26, "si": "g1"}, "2": {"v": 26, "si": "g2"}},
				"3": {"0": {"v": 30}, "1": {"v": 39, "si": "g1"}}
			}
		}
	}`)
	columns := []string{"cost", "price", "note"}

	masked, err := maskUniverSheetConfig(config, columns, hiddenFormulaTestProtections(), fullAccessMatrix(), 2, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(masked), "1.3") {
		t.Fatalf("hidden formula leaked to the employee: %s", masked)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(masked, &payload); err != nil {
		t.Fatal(err)
	}
	cells := nestedCellData(payload)
	price := cells["3"].(map[string]interface{})["1"].(map[string]interface{})
	if price["v"].(float64) != 39 || price["f"] != nil || price["si"] != nil {
		t.Fatalf("expected the result without formula, got %#v", price)
	}
	note := cells["1"].(map[string]interface{})["2"].(map[string]interface{})
	if note["f"] != "=B2" {
		t.Fatalf("visible formula must stay, got %#v", note)
	}

	for _, viewer := range []struct {
		userID  int64
		isAdmin bool
	}{{1, false}, {4, false}, {2, true}} {
		unmasked, err := maskUniverSheetConfig(config, columns, hiddenFormulaTestProtections(), fullAccessMatrix(), viewer.userID, viewer.isAdmin, nil)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(unmasked), "A2*1.3") {
			t.Fatalf("user %d (admin=%v) must still see the formula", viewer.userID, viewer.isAdmin)
		}
	}
}

func TestRecomputeHiddenFormulaResults(t *testing.T) {
	// The employee changed A3 to 50: the hidden B3 (=A3*1.3) is stale at 26.
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "成本"}, "1": {"v": "售价"}, "2": {"v": "合计"}},
				"1": {"0": {"v": 10, "t": 2}, "1": {"v": 13, "f": "=A2*1.3", "si": "g1", "t": 2}},
				"2": {"0": {"v": 50, "t": 2}, "1": {"v": 26, "si": "g1", "t": 2}},
				"3": {"2": {"v": 39, "f": "=SUM(B2:B3)", "t": 2}}
			}
		}
	}`)
	protections := hiddenFormulaTestProtections()
	result, err := recomputeHiddenFormulaResults(config, "报价", []string{"cost", "price", "total"}, protections, 2, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if result == nil || len(result.values) != 1 {
		t.Fatalf("expected one recalculated cell, got %#v", result)
	}
	change := result.values[0]
	if change.Row != 1 || change.Col != "price" || string(change.Value) != "65" {
		t.Fatalf("unexpected recalculated change %+v value=%s", change, change.Value)
	}
	if formula := string(result.formulas[0].Value); formula != `"=A3*1.3"` {
		t.Fatalf("broadcast must carry the formula, got %s", formula)
	}
	cells, err := decodeRawCellData(result.config)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(cells["2"]["1"]), `"v":65`) || !strings.Contains(string(cells["2"]["1"]), `"si":"g1"`) {
		t.Fatalf("stored cell must keep the formula and the new result: %s", cells["2"]["1"])
	}

	// Nothing is recalculated for users who can see the formula.
	if result, err := recomputeHiddenFormulaResults(config, "报价", []string{"cost", "price", "total"}, protections, 1, nil, nil); err != nil || result != nil {
		t.Fatalf("owner save must not trigger a recalculation, got %#v %v", result, err)
	}
}

func TestProtectionPreventsEditingHiddenFormula(t *testing.T) {
	protections := hiddenFormulaTestProtections()
	if !protectionPreventsCellEdit(protections, 3, "price", 2, nil) {
		t.Fatal("a user who cannot see the formula must not overwrite it")
	}
	if protectionPreventsCellEdit(protections, 3, "price", 4, nil) {
		t.Fatal("a whitelisted user can see and edit the formula")
	}
}

func TestFilterRealtimeHiddenFormulaUsesStoredResult(t *testing.T) {
	protections := hiddenFormulaTestProtections()
	filter := &realtimeCellFilter{
		sheetID:      1,
		loaded:       true,
		protections:  protections,
		storedValues: map[string]json.RawMessage{"1:price": json.RawMessage(`65`)},
	}
	changes := []model.CellUpdate{{Row: 1, Col: "price", Value: json.RawMessage(`"=A3*1.3"`)}}
	filtered := filterRealtimeCellChanges(1, 2, changes, false, protections, fullAccessMatrix(), nil)
	for index := range filtered {
		change := &filtered[index]
		if protectionHidesFormula(filter.protections, change.Row, change.Col, 2, false, nil) {
			change.Value = filter.storedValues["1:price"]
		}
	}
	if string(filtered[0].Value) != "65" {
		t.Fatalf("expected the stored result, got %s", filtered[0].Value)
	}
}
