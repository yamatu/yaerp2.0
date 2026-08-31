package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestProtectionHidesCell(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true, EditableUserIDs: []int64{3}},
		},
		Cells: map[string]protectionOwner{},
	}

	if !protectionHidesCell(protections, 0, "salary", 2, false, nil) {
		t.Fatal("expected hidden column to be masked for another user")
	}
	if protectionHidesCell(protections, 0, "salary", 1, false, nil) {
		t.Fatal("owner must be able to view hidden data")
	}
	if protectionHidesCell(protections, 0, "salary", 3, false, nil) {
		t.Fatal("allowed user must be able to view hidden data")
	}
	if protectionHidesCell(protections, 0, "salary", 2, true, nil) {
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

	matrix := fullAccessMatrix()
	masked, err := maskUniverSheetConfig(config, []string{"name", "salary"}, protections, matrix, 2, false, nil)
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

func TestMaskUniverHeaderCellProtection(t *testing.T) {
	config := json.RawMessage(`{
		"univerSheetData": {
			"cellData": {
				"0": {"0": {"v": "供应商"}, "1": {"v": "采购金额"}},
				"1": {"0": {"v": "示例公司"}, "1": {"v": 12000}}
			}
		}
	}`)
	protections := protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{},
		Cells: map[string]protectionOwner{
			"-1:amount": {OwnerID: 1, Hidden: true},
		},
	}

	masked, err := maskUniverSheetConfig(config, []string{"supplier", "amount"}, protections, fullAccessMatrix(), 2, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(masked, &payload); err != nil {
		t.Fatal(err)
	}
	header := nestedCellData(payload)["0"].(map[string]interface{})
	if header["0"].(map[string]interface{})["v"] != "供应商" {
		t.Fatalf("unprotected header changed: %#v", header["0"])
	}
	if header["1"].(map[string]interface{})["v"] != hiddenCellPlaceholder {
		t.Fatalf("protected header was not masked: %#v", header["1"])
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
	if protectionHidesCell(protections, 0, "salary", 2, false, nil) {
		t.Fatal("existing protection without hidden flag must remain visible")
	}
}

func TestMaskOnlyProtectionDoesNotPreventEditing(t *testing.T) {
	disabled := false
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, LockEditing: &disabled, Hidden: true},
		},
		Cells: map[string]protectionOwner{},
	}

	if !protectionHidesCell(protections, 0, "salary", 2, false, nil) {
		t.Fatal("mask-only rule must still hide the original value")
	}
	if protectionPreventsCellEdit(protections, 0, "salary", 2, nil) {
		t.Fatal("mask-only rule must not block editing")
	}
}

func TestDepartmentCanViewHiddenProtection(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true, EditableDepartmentIDs: []int64{8}},
		},
		Cells: map[string]protectionOwner{},
	}
	if protectionHidesCell(protections, 0, "salary", 2, false, map[int64]struct{}{8: {}}) {
		t.Fatal("department member must be able to view hidden protected data")
	}
}

func TestViewHiddenWhitelistDoesNotGrantEdit(t *testing.T) {
	info := protectionOwner{
		OwnerID:                 1,
		Hidden:                  true,
		ViewHiddenUserIDs:       []int64{2},
		ViewHiddenDepartmentIDs: []int64{8},
	}
	protections := protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{"salary": info},
		Cells:   map[string]protectionOwner{},
	}

	if protectionHidesCell(protections, 0, "salary", 2, false, nil) {
		t.Fatal("view-hidden user must receive the original value")
	}
	if protectionAllowsUser(info, 2, nil) {
		t.Fatal("view-hidden user must not receive edit permission")
	}
	if protectionHidesCell(protections, 0, "salary", 3, false, map[int64]struct{}{8: {}}) {
		t.Fatal("view-hidden department member must receive the original value")
	}
	if protectionAllowsUser(info, 3, map[int64]struct{}{8: {}}) {
		t.Fatal("view-hidden department member must not receive edit permission")
	}
}

func TestReadonlyWhitelistKeepsHiddenValueMasked(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true, ReadonlyUserIDs: []int64{2}, ReadonlyDepartmentIDs: []int64{8}},
		},
		Cells: map[string]protectionOwner{},
	}

	if !protectionHidesCell(protections, 0, "salary", 2, false, nil) {
		t.Fatal("readonly user must not bypass data masking")
	}
	if !protectionHidesCell(protections, 0, "salary", 3, false, map[int64]struct{}{8: {}}) {
		t.Fatal("readonly department member must not bypass data masking")
	}
}

func TestFilterRealtimeCellChangesMasksBeforeBroadcast(t *testing.T) {
	protections := protectionMaps{
		Rows: map[string]protectionOwner{},
		Columns: map[string]protectionOwner{
			"salary": {OwnerID: 1, Hidden: true, EditableDepartmentIDs: []int64{8}},
		},
		Cells: map[string]protectionOwner{},
	}
	changes := []model.CellUpdate{
		{SheetID: 99, Row: 0, Col: "name", Value: json.RawMessage(`"张三"`)},
		{SheetID: 99, Row: 0, Col: "salary", Value: json.RawMessage(`12000`)},
	}

	masked := filterRealtimeCellChanges(7, 2, changes, false, protections, fullAccessMatrix(), nil)
	if len(masked) != 2 {
		t.Fatalf("expected two realtime changes, got %d", len(masked))
	}
	if string(masked[0].Value) != `"张三"` {
		t.Fatalf("visible realtime value changed: %s", masked[0].Value)
	}
	if string(masked[1].Value) != `"`+hiddenCellPlaceholder+`"` {
		t.Fatalf("hidden realtime value leaked: %s", masked[1].Value)
	}
	if masked[1].SheetID != 7 {
		t.Fatalf("expected target sheet id 7, got %d", masked[1].SheetID)
	}

	departmentVisible := filterRealtimeCellChanges(7, 2, changes, false, protections, fullAccessMatrix(), map[int64]struct{}{8: {}})
	if string(departmentVisible[1].Value) != `12000` {
		t.Fatalf("authorized department should receive the original value: %s", departmentVisible[1].Value)
	}
	adminVisible := filterRealtimeCellChanges(7, 3, changes, true, protectionMaps{}, nil, nil)
	if string(adminVisible[1].Value) != `12000` {
		t.Fatalf("admin should receive the original value: %s", adminVisible[1].Value)
	}
}

func TestFilterRealtimeCellChangesMasksPermissionRestrictedCell(t *testing.T) {
	matrix := fullAccessMatrix()
	matrix.Cells["0:salary"] = "none"
	changes := []model.CellUpdate{{SheetID: 7, Row: 0, Col: "salary", Value: json.RawMessage(`12000`)}}

	filtered := filterRealtimeCellChanges(7, 2, changes, false, protectionMaps{}, matrix, nil)
	if len(filtered) != 1 || string(filtered[0].Value) != `"`+hiddenCellPlaceholder+`"` {
		t.Fatalf("permission-restricted value leaked in realtime payload: %#v", filtered)
	}
}
