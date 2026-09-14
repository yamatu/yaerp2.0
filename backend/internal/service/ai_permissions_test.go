package service

import (
	"reflect"
	"testing"

	"yaerp/internal/model"
)

func TestNormalizePermissionVerb(t *testing.T) {
	cases := map[string]string{
		"write":     "write",
		"WRITE":     "write",
		" edit ":    "write",
		"rw":        "write",
		"read":      "read",
		"readonly":  "read",
		"read_only": "read",
		"view":      "read",
		"none":      "none",
		"deny":      "none",
		"hidden":    "none",
		"something": "",
		"":          "",
	}
	for input, want := range cases {
		if got := normalizePermissionVerb(input); got != want {
			t.Fatalf("normalizePermissionVerb(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestClassifyColumnPermissions(t *testing.T) {
	writable, readOnly, denied := classifyColumnPermissions(map[string]string{
		"qty":     "write",
		"cost":    "read",
		"secret":  "none",
		"comment": "write",
		"unknown": "",
	})

	if !reflect.DeepEqual(writable, []string{"comment", "qty"}) {
		t.Fatalf("writable = %v", writable)
	}
	if !reflect.DeepEqual(readOnly, []string{"cost"}) {
		t.Fatalf("readOnly = %v", readOnly)
	}
	if !reflect.DeepEqual(denied, []string{"secret"}) {
		t.Fatalf("denied = %v", denied)
	}
}

func TestClassifyRowPermissionsSortsNumerically(t *testing.T) {
	rules, count := classifyRowPermissions(map[string]string{
		"10": "read",
		"2":  "write",
		"1":  "none",
	})
	if count != 3 {
		t.Fatalf("count = %d, want 3", count)
	}
	want := []map[string]string{
		{"row": "1", "permission": "none"},
		{"row": "2", "permission": "write"},
		{"row": "10", "permission": "read"},
	}
	if !reflect.DeepEqual(rules, want) {
		t.Fatalf("rules = %v, want %v", rules, want)
	}
}

func TestClassifyCellPermissionsCountsEveryRule(t *testing.T) {
	rules, count := classifyCellPermissions(map[string]string{
		"0:qty":  "write",
		"1:cost": "read",
		"2:cost": "none",
	})
	if count != 3 {
		t.Fatalf("count = %d, want 3", count)
	}
	if len(rules) != 3 {
		t.Fatalf("len(rules) = %d, want 3", len(rules))
	}
	for _, rule := range rules {
		if rule["cell"] == "" || rule["permission"] == "" {
			t.Fatalf("rule %v is missing fields", rule)
		}
	}
}

func TestDescribeOverrideLayer(t *testing.T) {
	layer := model.ScopedPermissionLayer{
		Columns: map[string]string{"cost": "read"},
		Rows:    map[string]string{"1": "read", "2": "none"},
		Cells:   map[string]string{"0:qty": "write"},
	}
	if got := describeOverrideLayer(layer); got != "1 列、2 行、1 单元格" {
		t.Fatalf("describeOverrideLayer = %q", got)
	}
	if got := describeOverrideLayer(model.ScopedPermissionLayer{}); got != "" {
		t.Fatalf("empty layer should describe nothing, got %q", got)
	}
}

func TestBuildFeatureAccessFollowsAdminGroup(t *testing.T) {
	service := &AIService{}

	member := service.buildFeatureAccess(false)
	if member["admin_console"] != false {
		t.Fatalf("member must not get the admin console: %v", member["admin_console"])
	}
	if member["manage_permissions"] != false || member["configure_ai"] != false {
		t.Fatalf("member must not get admin capabilities: %v", member)
	}
	if member["use_ai_assistant"] != true || member["create_workbook"] != true || member["view_permissions"] != true {
		t.Fatalf("member keeps the authenticated capabilities: %v", member)
	}

	admin := service.buildFeatureAccess(true)
	if admin["admin_console"] != true || admin["manage_users"] != true || admin["manage_backup"] != true {
		t.Fatalf("admin capabilities missing: %v", admin)
	}
}
