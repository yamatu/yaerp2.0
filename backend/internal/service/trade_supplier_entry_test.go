package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestUnavailableItemsSkipSupplierQuoteBlocker(t *testing.T) {
	items := []model.TradeOrderItem{
		{ID: 1, LineNo: 1, SKU: "SKU-A", Quantity: 10},
		{ID: 2, LineNo: 2, SKU: "SKU-B", Quantity: 20},
	}
	setTradeItemAvailability(&items[1], true, "缺货")
	order := &model.TradeOrder{ID: 9, Stage: model.TradeStageSupplierQuote, Items: items}
	order.SupplierQuotes = []model.TradeSupplierQuote{{OrderItemID: 1, IsSelected: true}}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("an unavailable item must not block the stage, got %#v", blockers)
	}

	setTradeItemAvailability(&order.Items[0], true, "")
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 {
		t.Fatalf("an order without any quotable item must be blocked, got %#v", blockers)
	}

	setTradeItemAvailability(&order.Items[0], false, "")
	if tradeItemUnavailable(&order.Items[0]) || len(order.Items[0].WorkflowData) != 0 {
		t.Fatalf("restoring an item must clear its markers: %#v", order.Items[0].WorkflowData)
	}
}

func TestUnavailableItemsAreLeftOutOfProfit(t *testing.T) {
	order := &model.TradeOrder{Stage: model.TradeStageQuotation, Currency: "CNY"}
	items := []model.TradeOrderItem{
		{ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "CNY", PurchasePrice: 60},
		{ID: 2, LineNo: 2, Quantity: 5},
	}
	setTradeItemAvailability(&items[1], true, "停产")
	profit := buildTradeProfitSummary(order, items)
	if !profit.CostComplete || len(profit.Warnings) != 0 || len(profit.Lines) != 1 {
		t.Fatalf("unavailable line must not add warnings or lines: %#v", profit)
	}
	if profit.GoodsRevenue != 1000 || profit.ProductCost != 600 {
		t.Fatalf("unexpected totals: %#v", profit)
	}
}
