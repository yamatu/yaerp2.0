package service

import (
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestResolveERPOrderItemPrefersExactSKU(t *testing.T) {
	items := []model.TradeOrderItem{
		{ID: 1, SKU: "A06B-0373-B177", ProductName: "Drive"},
		{ID: 2, SKU: "A06B-0373-B177-ALT", ProductName: "Drive spare"},
	}
	item, err := resolveERPOrderItem(items, 0, "A06B-0373-B177")
	if err != nil {
		t.Fatalf("resolve exact SKU: %v", err)
	}
	if item.ID != 1 {
		t.Fatalf("resolved item ID = %d, want 1", item.ID)
	}
}

func TestResolveERPOrderItemRejectsAmbiguousProduct(t *testing.T) {
	items := []model.TradeOrderItem{
		{ID: 1, SKU: "MOTOR-1", ProductName: "Servo motor"},
		{ID: 2, SKU: "MOTOR-2", ProductName: "Servo motor"},
	}
	_, err := resolveERPOrderItem(items, 0, "Servo motor")
	if err == nil || !strings.Contains(err.Error(), "匹配到多个") {
		t.Fatalf("error = %v, want ambiguous match", err)
	}
}

func TestMergeERPTradeCustomerUpdatePreservesAndClearsFields(t *testing.T) {
	current := &model.TradeCustomer{
		ID: 8, Name: "Old Name", CompanyName: "Old Co", Country: "Italy",
		ContactName: "Alice", Email: "alice@example.com", Phone: "123",
		Source: "manual", Status: "lead", CustomerLevel: "B", Notes: "old note",
		Tags: []string{"VIP"},
	}
	request, details, err := mergeERPTradeCustomerUpdate(current, map[string]any{
		"name":  "New Name",
		"notes": "",
	})
	if err != nil {
		t.Fatalf("merge customer update: %v", err)
	}
	if request.Name != "New Name" || request.CompanyName != "Old Co" || request.Country != "Italy" || request.Notes != "" {
		t.Fatalf("merged request = %#v", request)
	}
	if len(details) != 2 {
		t.Fatalf("details = %#v, want 2 entries", details)
	}
}

func TestERPOrderNextStepUsesPermissionRedactedBlockers(t *testing.T) {
	order := &model.TradeOrder{
		Stage:           model.TradeStageSupplierQuote,
		AdvanceBlockers: []string{"第 1 行尚未录入供应商报价", "尚未采用采购方案"},
	}
	next := erpOrderNextStep(order)
	if !strings.Contains(next, "供应商询价") || !strings.Contains(next, "尚未采用采购方案") {
		t.Fatalf("next step = %q", next)
	}
}

func TestERPActionToolSchemaRequiresOneAction(t *testing.T) {
	schema := erpActionToolSchema()
	required, ok := schema["required"].([]string)
	if !ok || len(required) != 1 || required[0] != "action" {
		t.Fatalf("schema required = %#v", schema["required"])
	}
}
