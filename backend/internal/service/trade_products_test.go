package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestApplyTradeHistoryCostConvertsToCNY(t *testing.T) {
	record := model.TradeQuoteHistoryRecord{Currency: "USD", UnitPrice: 2, ExchangeRateCNY: 7}
	item := &model.TradeOrderItem{PurchaseCurrency: "CNY", PurchasePrice: 10, SupplierName: "工厂A"}

	applyTradeHistoryCost(&record, item)

	if !record.CostComplete {
		t.Fatalf("expected cost to be complete")
	}
	if record.UnitPriceCNY != 14 || record.UnitCostCNY != 10 || record.UnitProfitCNY != 4 {
		t.Fatalf("unexpected CNY values: %+v", record)
	}
	if record.ProfitMargin < 28.57 || record.ProfitMargin > 28.58 {
		t.Fatalf("unexpected margin %.4f", record.ProfitMargin)
	}
	if record.SupplierName != "工厂A" {
		t.Fatalf("supplier should be exposed to cost viewers")
	}
}

func TestApplyTradeHistoryCostIncompleteWithoutRate(t *testing.T) {
	record := model.TradeQuoteHistoryRecord{Currency: "USD", UnitPrice: 2}
	applyTradeHistoryCost(&record, &model.TradeOrderItem{PurchaseCurrency: "CNY", PurchasePrice: 10})
	if record.CostComplete || record.UnitProfitCNY != 0 {
		t.Fatalf("missing quote rate must not produce a profit: %+v", record)
	}
}

func TestTradeHistoryMatchesSKUAndOrder(t *testing.T) {
	record := model.TradeQuoteHistoryRecord{SKU: "AB-1001", OrderNo: "TR2026-0001", Specification: "黑色"}
	for _, search := range []string{"ab-10", "tr2026", "黑色"} {
		if !tradeHistoryMatches(search, record) {
			t.Fatalf("expected %q to match", search)
		}
	}
	if tradeHistoryMatches("zz", record) {
		t.Fatalf("unexpected match")
	}
}
