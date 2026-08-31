package service

import (
	"strings"
	"testing"
)

func TestHeuristicAITradeOrderDraftParsesMessySample(t *testing.T) {
	draft := heuristicAITradeOrderDraft(strings.TrimSpace(`A860-0309-T302 $104 卖3个
104*3=$312
Shipping cost:$78
Total:$390
Pay MXN:6942.00
墨西哥Cristain
供应商汤米 A860-0309-T302 原装3500 单价`))
	if len(draft.Items) != 1 {
		t.Fatalf("items = %d, want 1", len(draft.Items))
	}
	item := draft.Items[0]
	if item.SKU != "A860-0309-T302" || item.Quantity != 3 || item.SalesUnitPrice != 104 {
		t.Fatalf("item = %#v", item)
	}
	if item.PurchaseUnitPrice != 3500 || item.SupplierName != "汤米" {
		t.Fatalf("purchase fields = %#v", item)
	}
	if draft.GoodsAmount != 312 || draft.ShippingCost != 78 || draft.TotalAmount != 390 {
		t.Fatalf("amounts = goods %.2f freight %.2f total %.2f", draft.GoodsAmount, draft.ShippingCost, draft.TotalAmount)
	}
	if draft.SettlementCurrency != "MXN" || draft.SettlementAmount != 6942 || draft.CustomerName != "Cristain" {
		t.Fatalf("customer/payment = %#v", draft)
	}
}

func TestNormalizeAITradeOrderDraftPreservesSemanticMissingFields(t *testing.T) {
	draft := &AITradeOrderImportDraft{
		CustomerID:    1,
		Currency:      "USD",
		MissingFields: []string{"报价币种"},
		Items: []AITradeOrderImportItem{{
			SKU: "A860-0309-T302", ProductName: "A860-0309-T302",
			Quantity: 3, Unit: "件", SalesUnitPrice: 104,
			SupplierName: "汤米", PurchaseUnitPrice: 3500,
		}},
	}

	(&AIService{}).normalizeAITradeOrderDraft(1, draft)

	missing := strings.Join(draft.MissingFields, "|")
	for _, expected := range []string{"报价币种", "第1项产品名称", "第1项采购币种"} {
		if !strings.Contains(missing, expected) {
			t.Fatalf("missing fields = %q, want %q", missing, expected)
		}
	}
}
