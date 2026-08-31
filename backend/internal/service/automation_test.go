package service

import (
	"encoding/json"
	"testing"

	"yaerp/internal/model"
)

func TestEvaluateAutomationCondition(t *testing.T) {
	tests := []struct {
		name     string
		actual   any
		operator string
		expected any
		matched  bool
	}{
		{name: "numeric string equals number", actual: "12.50", operator: "eq", expected: 12.5, matched: true},
		{name: "greater than", actual: 15, operator: "gt", expected: "12", matched: true},
		{name: "case insensitive contains", actual: "Pending Review", operator: "contains", expected: "review", matched: true},
		{name: "not contains", actual: "approved", operator: "not_contains", expected: "pending", matched: true},
		{name: "comma separated list", actual: "采购部", operator: "in", expected: "销售部, 采购部", matched: true},
		{name: "safe regexp", actual: "PO-2026-018", operator: "regex", expected: `^PO-\d{4}-\d+$`, matched: true},
		{name: "empty whitespace", actual: "  ", operator: "is_empty", matched: true},
		{name: "non empty zero", actual: 0, operator: "not_empty", matched: true},
		{name: "incomparable blank", actual: "", operator: "gte", expected: 1, matched: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if actual := evaluateAutomationCondition(test.actual, test.operator, test.expected); actual != test.matched {
				t.Fatalf("evaluateAutomationCondition() = %v, want %v", actual, test.matched)
			}
		})
	}
}

func TestEvaluateAutomationConditionsLogic(t *testing.T) {
	conditions := []model.AutomationCondition{
		{Column: "status", Operator: "eq", Value: "待审批"},
		{Column: "amount", Operator: "gte", Value: 1000},
	}
	row := map[string]any{"status": "待审批", "amount": 800}
	if evaluateAutomationConditions(conditions, "all", row) {
		t.Fatal("all logic should require every condition")
	}
	if !evaluateAutomationConditions(conditions, "any", row) {
		t.Fatal("any logic should match one condition")
	}
	if !evaluateAutomationConditions(nil, "all", row) {
		t.Fatal("empty conditions should match")
	}
}

func TestAutomationRowFingerprintStable(t *testing.T) {
	rule := &model.AutomationRule{
		WatchedColumns: []string{"amount", "status"},
		Conditions:     []model.AutomationCondition{{Column: "department", Operator: "eq", Value: "采购部"}},
	}
	first := map[string]any{"status": "待审批", "amount": 1200, "department": "采购部", "ignored": "one"}
	second := map[string]any{"department": "采购部", "amount": 1200, "status": "待审批", "ignored": "two"}
	firstFingerprint, err := automationRowFingerprint(rule, first)
	if err != nil {
		t.Fatal(err)
	}
	secondFingerprint, err := automationRowFingerprint(rule, second)
	if err != nil {
		t.Fatal(err)
	}
	if firstFingerprint != secondFingerprint {
		t.Fatalf("irrelevant fields or map order changed fingerprint: %q != %q", firstFingerprint, secondFingerprint)
	}
	second["amount"] = 1201
	changedFingerprint, err := automationRowFingerprint(rule, second)
	if err != nil {
		t.Fatal(err)
	}
	if firstFingerprint == changedFingerprint {
		t.Fatal("watched field change should update fingerprint")
	}
}

func TestRenderAutomationTemplateAndActionValue(t *testing.T) {
	variables := map[string]string{
		"workbook.name": "采购台账",
		"row.amount":    "1280.5",
		"row.status":    "已审批",
	}
	rendered := renderAutomationTemplate("{{ workbook.name }}：{{row.status}}，金额 {{ row.amount }}", variables)
	if rendered != "采购台账：已审批，金额 1280.5" {
		t.Fatalf("unexpected rendered template: %q", rendered)
	}

	numeric, err := automationActionValue(model.AutomationAction{ValueTemplate: "{{row.amount}}"}, variables)
	if err != nil {
		t.Fatal(err)
	}
	var numericValue any
	if err := json.Unmarshal(numeric, &numericValue); err != nil {
		t.Fatal(err)
	}
	if numericValue != float64(1280.5) {
		t.Fatalf("numeric template value = %#v", numericValue)
	}

	text, err := automationActionValue(model.AutomationAction{ValueTemplate: "状态：{{row.status}}"}, variables)
	if err != nil {
		t.Fatal(err)
	}
	var textValue string
	if err := json.Unmarshal(text, &textValue); err != nil {
		t.Fatal(err)
	}
	if textValue != "状态：已审批" {
		t.Fatalf("text template value = %q", textValue)
	}
}

func TestWatchedColumnsIntersect(t *testing.T) {
	changed := map[string]any{"status": "已审批"}
	if !watchedColumnsIntersect(nil, changed) {
		t.Fatal("empty watch list should match every change")
	}
	if !watchedColumnsIntersect([]string{"amount", "status"}, changed) {
		t.Fatal("matching watched column was not detected")
	}
	if watchedColumnsIntersect([]string{"amount"}, changed) {
		t.Fatal("unrelated watched column should not match")
	}
}

func TestAutomationApprovalRangeMatchesExactRowsAndColumns(t *testing.T) {
	start, end := 2, 4
	rule := &model.AutomationRule{
		HoldChanges:    true,
		WatchedColumns: []string{"status", "amount"},
		ApprovalRanges: []model.AutomationApprovalRange{{StartRow: &start, EndRow: &end, Columns: []string{"status"}}},
	}
	if !automationApprovalRangeMatches(rule, 3, "status") {
		t.Fatal("expected exact approval range to match")
	}
	if automationApprovalRangeMatches(rule, 1, "status") {
		t.Fatal("row outside approval range should not match")
	}
	if automationApprovalRangeMatches(rule, 3, "amount") {
		t.Fatal("column outside approval range should not match")
	}

	rule.ApprovalRanges = []model.AutomationApprovalRange{{Columns: []string{"amount"}}}
	if !automationApprovalRangeMatches(rule, 99, "amount") {
		t.Fatal("range without row bounds should cover every data row")
	}
}

func TestValidateAutomationApprovalRanges(t *testing.T) {
	columns := map[string]struct{}{"status": {}, "amount": {}}
	start, end := 0, 10
	if err := validateAutomationApprovalRanges([]model.AutomationApprovalRange{{StartRow: &start, EndRow: &end, Columns: []string{"status"}}}, columns); err != nil {
		t.Fatalf("valid approval range rejected: %v", err)
	}
	badEnd := -1
	if err := validateAutomationApprovalRanges([]model.AutomationApprovalRange{{StartRow: &start, EndRow: &badEnd, Columns: []string{"status"}}}, columns); err == nil {
		t.Fatal("invalid row range was accepted")
	}
	if err := validateAutomationApprovalRanges([]model.AutomationApprovalRange{{Columns: []string{"missing"}}}, columns); err == nil {
		t.Fatal("unknown approval column was accepted")
	}
}
