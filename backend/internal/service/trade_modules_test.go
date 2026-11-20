package service

import (
	"math"
	"testing"

	"yaerp/internal/model"
)

func TestEnabledTradeStagesSkipSwitchedOffModules(t *testing.T) {
	modules := model.DefaultTradeModules()
	cases := map[string]string{
		model.TradeStageInquiry:    model.TradeStagePurchase,
		model.TradeStageQuotation:  model.TradeStagePurchase,
		model.TradeStagePurchase:   model.TradeStageReceiving,
		model.TradeStageShipment:   model.TradeStageCompleted,
		model.TradeStageCompleted:  "",
		model.TradeStageInspection: model.TradeStagePacking,
	}
	for stage, want := range cases {
		if got := nextEnabledTradeStage(stage, modules); got != want {
			t.Fatalf("next(%s) = %q, want %q", stage, got, want)
		}
	}
	if got := prevEnabledTradeStage(model.TradeStagePurchase, modules); got != "" {
		t.Fatalf("purchase must not return to switched-off quoting, got %q", got)
	}
	modules.Packing = false
	modules.Inspection = false
	if got := nextEnabledTradeStage(model.TradeStageReceiving, modules); got != model.TradeStageShipment {
		t.Fatalf("receiving should skip inspection and packing, got %q", got)
	}
	if got := prevEnabledTradeStage(model.TradeStageShipment, modules); got != model.TradeStageReceiving {
		t.Fatalf("shipment should return to receiving, got %q", got)
	}
	if got := nextEnabledTradeStage(model.TradeStageQuotation, model.AllTradeModules()); got != model.TradeStagePurchase {
		t.Fatalf("all modules keep the full flow, got %q", got)
	}
}

func TestConfirmedOrderStartStage(t *testing.T) {
	if got := confirmedOrderStartStage(model.AllTradeModules()); got != model.TradeStagePurchase {
		t.Fatalf("start with every module = %q, want purchase", got)
	}
	modules := model.TradeModules{Shipment: true}
	if got := confirmedOrderStartStage(modules); got != model.TradeStageShipment {
		t.Fatalf("start with only shipment = %q", got)
	}
	if got := confirmedOrderStartStage(model.TradeModules{}); got != model.TradeStageCompleted {
		t.Fatalf("start with no modules = %q, want completed", got)
	}
}

func TestBlockersIgnoreSwitchedOffStages(t *testing.T) {
	order := &model.TradeOrder{ID: 1, Stage: model.TradeStageQuotation, Items: []model.TradeOrderItem{
		{ID: 1, LineNo: 1, SKU: "A", Quantity: 2, QuotedPrice: 10},
	}}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.AllTradeModules()); len(blockers) != 1 {
		t.Fatalf("quotation needs an accepted quote when quoting is on, got %#v", blockers)
	}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.DefaultTradeModules()); len(blockers) != 0 {
		t.Fatalf("an old quote must convert freely when quoting is off, got %#v", blockers)
	}

	order.Stage = model.TradeStageShipment
	order.Shipment = &model.TradeShipment{Carrier: "DHL", BookingNo: "B1", ShippingStatus: "已发货"}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.AllTradeModules()); len(blockers) != 1 {
		t.Fatalf("quoting on still requires a payment proof, got %#v", blockers)
	}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.DefaultTradeModules()); len(blockers) != 0 {
		t.Fatalf("confirmed orders are already paid, got %#v", blockers)
	}
}

func TestApplyTradeItemPricing(t *testing.T) {
	item := &model.TradeOrderItem{Status: "客户确认"}
	applyTradeItemPricing(item, model.TradeOrderPricingItem{SalesPrice: 100, FreightAmount: 12, SupplierName: " 工厂A ", PurchasePrice: 60}, true, model.TradeStageInquiry)
	if item.QuotedPrice != 100 || item.FreightAmount != 12 || item.PurchasePrice != 60 || item.PurchaseCurrency != "CNY" || item.SupplierName != "工厂A" {
		t.Fatalf("pricing not applied: %#v", item)
	}
	if item.Status != "已下单" || tradeWorkflowString(item, "purchase_status") != "已下单" {
		t.Fatalf("a line with supplier and cost should count as ordered: %#v", item)
	}

	received := &model.TradeOrderItem{Status: "已到货", WorkflowData: map[string]any{"purchase_status": "已完成"}}
	applyTradeItemPricing(received, model.TradeOrderPricingItem{SalesPrice: 5, SupplierName: "B", PurchaseCurrency: "CNY", PurchasePrice: 3}, true, model.TradeStageReceiving)
	if received.Status != "已到货" || tradeWorkflowString(received, "purchase_status") != "已完成" {
		t.Fatalf("editing prices must not reset later progress: %#v", received)
	}

	noCost := &model.TradeOrderItem{}
	applyTradeItemPricing(noCost, model.TradeOrderPricingItem{SalesPrice: 8, SupplierName: "C", PurchaseCurrency: "CNY", PurchasePrice: 4}, false, model.TradeStageInquiry)
	if noCost.QuotedPrice != 8 || noCost.PurchasePrice != 0 || noCost.SupplierName != "" {
		t.Fatalf("users without cost access must not write cost: %#v", noCost)
	}
}

func TestConfirmedOrderProfitUsesCNYCostAndRate(t *testing.T) {
	order := &model.TradeOrder{Currency: "USD", QuoteExchangeRateCNY: 7, QuotedGoodsAmount: 1000, TotalAmount: 1000}
	items := []model.TradeOrderItem{{ID: 1, LineNo: 1, SKU: "A", Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "CNY", PurchasePrice: 350}}
	summary := buildTradeProfitSummary(order, items)
	if !summary.CostComplete || !summary.CNYComplete {
		t.Fatalf("summary should be complete: %#v", summary)
	}
	if math.Abs(summary.ProfitAmountCNY-3500) > 1e-6 || math.Abs(summary.ProfitAmount-500) > 1e-6 || math.Abs(summary.ProfitMargin-50) > 1e-6 {
		t.Fatalf("profit = %v USD / %v CNY / %v%%, want 500 / 3500 / 50", summary.ProfitAmount, summary.ProfitAmountCNY, summary.ProfitMargin)
	}
}

func TestProfitCountsLineFreightAndPaymentFee(t *testing.T) {
	// Customer pays goods 1000 + freight 80 + PayPal fee 20 = 1100 USD.
	order := &model.TradeOrder{Currency: "USD", QuoteExchangeRateCNY: 7, PaymentFeeAmount: 20, TotalAmount: 1100}
	items := []model.TradeOrderItem{
		{ID: 1, LineNo: 1, SKU: "A", Quantity: 10, QuotedPrice: 80, FreightAmount: 50, PurchaseCurrency: "CNY", PurchasePrice: 300},
		{ID: 2, LineNo: 2, SKU: "B", Quantity: 1, QuotedPrice: 200, FreightAmount: 30, PurchaseCurrency: "CNY", PurchasePrice: 900},
	}
	summary := buildTradeProfitSummary(order, items)
	if !near(summary.FreightRevenue, 80) || !near(summary.FeeRevenue, 20) || !near(summary.Revenue, 1100) {
		t.Fatalf("revenue parts = goods %v freight %v fee %v total %v", summary.GoodsRevenue, summary.FreightRevenue, summary.FeeRevenue, summary.Revenue)
	}
	if !near(summary.ProfitAmountCNY, 1100*7-3900) || !summary.CostComplete {
		t.Fatalf("profit CNY = %v (complete %v, %v), want %v", summary.ProfitAmountCNY, summary.CostComplete, summary.Warnings, 1100*7-3900)
	}
}

func near(a, b float64) bool { return math.Abs(a-b) < 1e-6 }

func TestPurchaseNeedsOnlyCostWithoutQuoting(t *testing.T) {
	item := model.TradeOrderItem{ID: 1, LineNo: 1, SKU: "A", Quantity: 1, QuotedPrice: 10}
	applyTradeItemPricing(&item, model.TradeOrderPricingItem{SalesPrice: 10, PurchasePrice: 6}, true, model.TradeStagePurchase)
	order := &model.TradeOrder{ID: 1, Stage: model.TradeStagePurchase, Items: []model.TradeOrderItem{item}}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.DefaultTradeModules()); len(blockers) != 0 {
		t.Fatalf("cost alone should be enough without quoting, got %#v", blockers)
	}
	if blockers := tradeOrderAdvanceBlockersWith(order, model.AllTradeModules()); len(blockers) != 1 {
		t.Fatalf("with quoting the adopted supplier is still required, got %#v", blockers)
	}
}
