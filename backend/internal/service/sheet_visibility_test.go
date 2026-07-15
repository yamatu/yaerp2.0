package service

import (
	"encoding/json"
	"testing"
)

func TestProtectionHidesCell(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true, EditableUserIDs: []int64{3}},
		},
		Cells: map[string]protectionOwner{},
	}

	if !protectionHidesCell(protections, 0, "salary", 2, false) {
		t.Fatal("expected hidden column to be masked for another user")
	}
	if protectionHidesCell(protections, 0, "salary", 1, false) {
		t.Fatal("owner must be able to view hidden data")
	}
	if protectionHidesCell(protections, 0, "salary", 3, false) {
		t.Fatal("allowed user must be able to view hidden data")
	}
	if protectionHidesCell(protections, 0, "salary", 2, true) {
		t.Fatal("admin must be able to view hidden data")
	}
}

func TestMaskUniverSheetConfig(t *testing.T) {
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "姓名"}, "1": {"v": "工资"}},
				"1": {"0": {"v": "张三"}, "1": {"v": 12000, "f": "=6000*2", "s": "salary-style"}}
			}
		}
	}`)
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true},
		},
		Cells: map[string]protectionOwner{},
	}

	masked, err := maskUniverSheetConfig(config, []string{"name", "salary"}, protections, 2, false)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(masked, &payload); err != nil {
		t.Fatal(err)
	}
	cellData := nestedCellData(payload)
	dataRow := cellData["1"].(map[string]interface{})
	nameCell := dataRow["0"].(map[string]interface{})
	salaryCell := dataRow["1"].(map[string]interface{})
	if nameCell["v"] != "张三" {
		t.Fatalf("visible cell changed: %#v", nameCell)
	}
	if salaryCell["v"] != hiddenCellPlaceholder {
		t.Fatalf("hidden value was not masked: %#v", salaryCell)
	}
	if _, exists := salaryCell["f"]; exists {
		t.Fatalf("hidden formula leaked: %#v", salaryCell)
	}
	if salaryCell["s"] != "salary-style" {
		t.Fatalf("cell style should be preserved: %#v", salaryCell)
	}
}

func TestLegacyProtectionDoesNotHideCell(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1},
		},
		Cells: map[string]protectionOwner{},
	}
	if protectionHidesCell(protections, 0, "salary", 2, false) {
		t.Fatal("existing protection without hidden flag must remain visible")
	}
}
