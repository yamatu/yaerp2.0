package service

import (
	"strings"
	"time"

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

func TestQuoteRoundTotalsFollowPurchasedLines(t *testing.T) {
	round := &model.TradeCustomerQuoteRound{
		FreightMode: "quoted", FreightAmount: 99, ExchangeRateCNY: 7,
		Items: []model.TradeCustomerQuoteItem{
			{OrderItemID: 1, Quantity: 2, UnitPrice: 10, Amount: 20, FreightAmount: 5, MarginPercent: 12},
			{OrderItemID: 2, Quantity: 1, UnitPrice: 50, Amount: 50, FreightAmount: 8, MarginPercent: 30, Declined: true},
		},
	}
	round.ApplyItemTotals()
	if round.GoodsAmount != 20 || round.FreightAmount != 5 || round.TotalAmount != 25 || round.TotalAmountCNY != 175 {
		t.Fatalf("totals must only count purchased lines and their freight: %#v", round)
	}
	if len(round.PurchasedItems()) != 1 {
		t.Fatalf("one purchased line expected")
	}

	legacy := &model.TradeCustomerQuoteRound{FreightMode: "quoted", FreightAmount: 30, ExchangeRateCNY: 1,
		Items: []model.TradeCustomerQuoteItem{{OrderItemID: 1, Amount: 100}}}
	legacy.ApplyItemTotals()
	if legacy.FreightAmount != 30 || legacy.TotalAmount != 130 {
		t.Fatalf("a round without line freight keeps its single freight: %#v", legacy)
	}

	forwarder := &model.TradeCustomerQuoteRound{FreightMode: "customer_forwarder", FreightAmount: 30,
		Items: []model.TradeCustomerQuoteItem{{OrderItemID: 1, Amount: 100, FreightAmount: 9}}}
	forwarder.ApplyItemTotals()
	if forwarder.FreightAmount != 0 || forwarder.TotalAmount != 100 {
		t.Fatalf("customer forwarder rounds carry no freight: %#v", forwarder)
	}
}

func TestDeclinedItemsLeaveLaterStages(t *testing.T) {
	items := []model.TradeOrderItem{
		{ID: 1, LineNo: 1, SKU: "A", Quantity: 10, QuotedPrice: 20, PurchaseCurrency: "CNY", PurchasePrice: 10},
		{ID: 2, LineNo: 2, SKU: "B", Quantity: 5, QuotedPrice: 30},
	}
	setTradeWorkflowValue(&items[1], tradeItemDeclinedKey, true)
	order := &model.TradeOrder{ID: 3, Stage: model.TradeStagePurchase, Currency: "CNY", Items: items}
	order.Items[0].SupplierName = "S"
	order.Items[0].Status = "已下单"
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("a product the customer did not buy must not block purchasing, got %#v", blockers)
	}
	profit := buildTradeProfitSummary(order, items)
	if profit.GoodsRevenue != 200 || profit.ProductCost != 100 || len(profit.Lines) != 1 {
		t.Fatalf("profit must only count purchased products: %#v", profit)
	}
	setTradeWorkflowValue(&order.Items[0], tradeItemDeclinedKey, true)
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 {
		t.Fatalf("an order without purchased products must be blocked, got %#v", blockers)
	}
}

func TestPIListsOnlyPurchasedProducts(t *testing.T) {
	quote := &model.TradeCustomerQuoteRound{
		Currency: "USD", FreightMode: "quoted", ExchangeRateCNY: 7,
		Items: []model.TradeCustomerQuoteItem{
			{OrderItemID: 1, SKU: "BUY-ME", Quantity: 2, UnitPrice: 10, Amount: 20, FreightAmount: 3},
			{OrderItemID: 2, SKU: "NOT-BOUGHT", Quantity: 1, UnitPrice: 99, Amount: 99, FreightAmount: 9, Declined: true},
		},
	}
	quote.ApplyItemTotals()
	html := renderTradePIHTML(&tradePIDocument{Order: &model.TradeOrder{OrderNo: "T-1"}, Quote: quote, IssueDate: time.Now(), ValidUntil: time.Now()})
	if !strings.Contains(html, "BUY-ME") || strings.Contains(html, "NOT-BOUGHT") {
		t.Fatalf("the PI must list purchased products only")
	}
	if !strings.Contains(html, "USD 23.00") || strings.Contains(html, "USD 131.00") {
		t.Fatalf("the PI total must be the purchased goods plus their freight")
	}
}
