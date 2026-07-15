package service

import (
	"reflect"
	"testing"

	"yaerp/internal/model"
)

func TestNormalizeProtectionAccessUsesStrongestPermission(t *testing.T) {
	req := &model.UpdateProtectionRequest{
		ReadonlyUserIDs:         []int64{2, 3, 4},
		EditableUserIDs:         []int64{2},
		ViewHiddenUserIDs:       []int64{2, 3},
		ReadonlyDepartmentIDs:   []int64{7, 8, 9},
		EditableDepartmentIDs:   []int64{7},
		ViewHiddenDepartmentIDs: []int64{7, 8},
	}

	access := normalizeProtectionAccess(req, 1)
	if !reflect.DeepEqual(access.EditableUserIDs, []int64{2}) {
		t.Fatalf("unexpected editable users: %#v", access.EditableUserIDs)
	}
	if !reflect.DeepEqual(access.ViewHiddenUserIDs, []int64{3}) {
		t.Fatalf("unexpected view-hidden users: %#v", access.ViewHiddenUserIDs)
	}
	if !reflect.DeepEqual(access.ReadonlyUserIDs, []int64{4}) {
		t.Fatalf("unexpected readonly users: %#v", access.ReadonlyUserIDs)
	}
	if !reflect.DeepEqual(access.EditableDepartmentIDs, []int64{7}) {
		t.Fatalf("unexpected editable departments: %#v", access.EditableDepartmentIDs)
	}
	if !reflect.DeepEqual(access.ViewHiddenDepartmentIDs, []int64{8}) {
		t.Fatalf("unexpected view-hidden departments: %#v", access.ViewHiddenDepartmentIDs)
	}
	if !reflect.DeepEqual(access.ReadonlyDepartmentIDs, []int64{9}) {
		t.Fatalf("unexpected readonly departments: %#v", access.ReadonlyDepartmentIDs)
	}
}

func TestNormalizeProtectionAccessExcludesOwner(t *testing.T) {
	req := &model.UpdateProtectionRequest{
		ReadonlyUserIDs:   []int64{1, 2},
		EditableUserIDs:   []int64{1, 3},
		ViewHiddenUserIDs: []int64{1, 4},
	}

	access := normalizeProtectionAccess(req, 1)
	for _, userIDs := range [][]int64{access.ReadonlyUserIDs, access.EditableUserIDs, access.ViewHiddenUserIDs} {
		for _, userID := range userIDs {
			if userID == 1 {
				t.Fatal("protection owner must not be duplicated in a whitelist")
			}
		}
	}
}

func TestMergeProtectionWhitelistPermissions(t *testing.T) {
	matrix := emptyPermissionMatrix()
	protections := protectionMaps{
		Rows: map[string]protectionOwner{
			"2": {ReadonlyDepartmentIDs: []int64{8}},
		},
		Columns: map[string]protectionOwner{
			"amount": {EditableDepartmentIDs: []int64{8}},
		},
		Cells: map[string]protectionOwner{
			"2:amount": {ViewHiddenUserIDs: []int64{5}},
		},
	}

	if !mergeProtectionWhitelistPermissions(matrix, protections, 5, map[int64]struct{}{8: {}}) {
		t.Fatal("expected visual whitelist rules to be merged")
	}
	if matrix.UserOverrides.Cells["2:amount"] != "read" {
		t.Fatalf("expected direct view-hidden rule to become a read override: %#v", matrix.UserOverrides.Cells)
	}
	if matrix.DepartmentOverrides.Rows["2"] != "read" {
		t.Fatalf("expected department readonly rule: %#v", matrix.DepartmentOverrides.Rows)
	}
	if matrix.DepartmentOverrides.Columns["amount"] != "write" {
		t.Fatalf("expected department edit rule: %#v", matrix.DepartmentOverrides.Columns)
	}
	if permissionMatrixAllowsCell(matrix, "amount", 2, "write") {
		t.Fatal("direct user read rule must override department write permission")
	}
}

func TestProtectionWhitelistDepartmentConflictIsRestrictive(t *testing.T) {
	info := protectionOwner{
		EditableDepartmentIDs: []int64{7},
		ReadonlyDepartmentIDs: []int64{8},
	}
	permission, directUser, allowed := protectionWhitelistPermission(info, 5, map[int64]struct{}{7: {}, 8: {}})
	if !allowed || directUser || permission != "read" {
		t.Fatalf("expected restrictive department permission, got permission=%q direct=%v allowed=%v", permission, directUser, allowed)
	}
}

func TestFlattenProtectionMapIncludesEffectiveUserState(t *testing.T) {
	items := map[string]protectionOwner{
		"amount": {
			OwnerID:           1,
			OwnerName:         "owner",
			Hidden:            true,
			ReadonlyUserIDs:   []int64{2},
			ViewHiddenUserIDs: []int64{3},
			EditableUserIDs:   []int64{4},
		},
	}

	readonly := flattenProtectionMap("column", items, 2, false, nil)
	if len(readonly) != 1 || readonly[0].CanEdit || !readonly[0].MaskedForCurrentUser {
		t.Fatalf("unexpected readonly state: %#v", readonly)
	}

	viewHidden := flattenProtectionMap("column", items, 3, false, nil)
	if len(viewHidden) != 1 || viewHidden[0].CanEdit || viewHidden[0].MaskedForCurrentUser {
		t.Fatalf("unexpected view-hidden state: %#v", viewHidden)
	}

	editable := flattenProtectionMap("column", items, 4, false, nil)
	if len(editable) != 1 || !editable[0].CanEdit || editable[0].MaskedForCurrentUser {
		t.Fatalf("unexpected editable state: %#v", editable)
	}
}

func TestProtectionLockEditingIsBackwardCompatible(t *testing.T) {
	legacy := protectionOwner{OwnerID: 1}
	if !protectionLocksEditing(legacy) {
		t.Fatal("legacy protection without lockEditing must remain locked")
	}

	disabled := false
	maskOnly := protectionOwner{OwnerID: 1, LockEditing: &disabled, Hidden: true}
	if protectionLocksEditing(maskOnly) {
		t.Fatal("explicitly disabled edit lock must allow editing")
	}
}

func TestFlattenProtectionMapSupportsMaskOnlyRule(t *testing.T) {
	disabled := false
	items := map[string]protectionOwner{
		"salary": {
			OwnerID:     1,
			OwnerName:   "owner",
			LockEditing: &disabled,
			Hidden:      true,
		},
	}

	result := flattenProtectionMap("column", items, 2, false, nil)
	if len(result) != 1 || result[0].LockEditing || !result[0].CanEdit || !result[0].MaskedForCurrentUser {
		t.Fatalf("unexpected mask-only state: %#v", result)
	}
}

func TestApplyProtectionRequestRequiresMaskOrLock(t *testing.T) {
	disabled := false
	columnKey := "salary"
	protections := protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{},
		Cells:   map[string]protectionOwner{},
	}
	request := &model.UpdateProtectionRequest{
		Action:      "lock",
		Scope:       "column",
		ColumnKey:   &columnKey,
		LockEditing: &disabled,
		Hidden:      &disabled,
	}

	err := applyProtectionRequest(&protections, map[string]interface{}{}, map[string]bool{}, request, 1, "owner", false)
	if err == nil {
		t.Fatal("expected an empty protection rule to be rejected")
	}
	if len(protections.Columns) != 0 {
		t.Fatalf("invalid rule must not be persisted: %#v", protections.Columns)
	}
}
