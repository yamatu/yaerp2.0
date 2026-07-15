package service

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestColumnLayoutRequiresStructureGate(t *testing.T) {
	tests := []struct {
		name    string
		current []string
		next    []string
		want    bool
	}{
		{name: "same layout", current: []string{"a", "b"}, next: []string{"a", "b"}, want: false},
		{name: "append only", current: []string{"a", "b"}, next: []string{"a", "b", "c"}, want: false},
		{name: "insert before protected indexes", current: []string{"a", "b"}, next: []string{"a", "c", "b"}, want: true},
		{name: "remove column", current: []string{"a", "b"}, next: []string{"a"}, want: true},
		{name: "reorder columns", current: []string{"a", "b"}, next: []string{"b", "a"}, want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := columnLayoutRequiresStructureGate(test.current, test.next); got != test.want {
				t.Fatalf("columnLayoutRequiresStructureGate() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestPermissionMatrixAllowsStructureMutation(t *testing.T) {
	matrix := fullAccessMatrix()
	if !permissionMatrixAllowsStructureMutation(matrix) {
		t.Fatal("full write access should allow structural changes")
	}
	matrix.Columns["salary"] = "none"
	if permissionMatrixAllowsStructureMutation(matrix) {
		t.Fatal("a hidden column must block structural changes")
	}
}

func TestEnsureProtectionOwnershipBlocksOtherUsers(t *testing.T) {
	config := json.RawMessage(`{
		"protections": {
			"rows": {},
			"columns": {"salary": {"ownerId": 1, "ownerName": "owner", "hidden": true}},
			"cells": {}
		}
	}`)

	if err := ensureProtectionOwnership(config, 1, "delete"); err != nil {
		t.Fatalf("protection owner should be allowed: %v", err)
	}
	if err := ensureProtectionOwnership(config, 2, "delete"); !errors.Is(err, ErrProtectionDenied) {
		t.Fatalf("expected protection denial for another user, got %v", err)
	}
}

func TestRemoveColumnProtectionState(t *testing.T) {
	config := json.RawMessage(`{
		"protections": {
			"rows": {"0": {"ownerId": 1}},
			"columns": {"salary": {"ownerId": 1}, "name": {"ownerId": 1}},
			"cells": {"0:salary": {"ownerId": 1}, "0:name": {"ownerId": 1}}
		},
		"lockedCells": {"0:salary": true, "0:name": true}
	}`)

	updated, err := removeColumnProtectionState(config, map[string]struct{}{"salary": {}})
	if err != nil {
		t.Fatal(err)
	}
	_, protections, legacyLocks, err := parseSheetConfigProtection(updated)
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := protections.Columns["salary"]; exists {
		t.Fatal("removed column protection was retained")
	}
	if _, exists := protections.Cells["0:salary"]; exists {
		t.Fatal("removed column cell protection was retained")
	}
	if legacyLocks["0:salary"] {
		t.Fatal("removed column legacy lock was retained")
	}
	if _, exists := protections.Columns["name"]; !exists || !legacyLocks["0:name"] {
		t.Fatal("unrelated protection state was removed")
	}
	if _, exists := protections.Rows["0"]; !exists {
		t.Fatal("row protection should remain")
	}
}
