package service

import (
	"math"
	"testing"
	"time"

	"yaerp/internal/model"
)

func tradeBossFixture(now time.Time) ([]model.TradeOrder, []model.TradeOrderItem) {
	june := time.Date(2026, time.June, 10, 9, 0, 0, 0, time.Local)
	orders := []model.TradeOrder{
		{ID: 1, OrderNo: "USD-COMPLETE", CustomerName: "Acme", OwnerName: "Lily", Stage: model.TradeStageCompleted,
			StageUpdatedAt: now, UpdatedAt: now, Currency: "USD", TotalAmount: 100,
			QuoteExchangeRateCNY: 7, FreightMode: "customer_forwarder"},
		{ID: 2, OrderNo: "CNY-COMPLETE", CustomerName: "Beta", OwnerName: "Lily", Stage: model.TradeStageCompleted,
			StageUpdatedAt: now, UpdatedAt: now, Currency: "CNY", TotalAmount: 1000,
			QuoteExchangeRateCNY: 1, FreightMode: "customer_forwarder"},
		{ID: 3, OrderNo: "USD-ACTIVE", Stage: model.TradeStagePurchase, StageUpdatedAt: now, UpdatedAt: now,
			Currency: "USD", TotalAmount: 100, QuoteExchangeRateCNY: 7, FreightMode: "customer_forwarder"},
		{ID: 4, OrderNo: "EUR-INCOMPLETE", Stage: model.TradeStageCompleted, StageUpdatedAt: now, UpdatedAt: now,
			Currency: "EUR", TotalAmount: 100, FreightMode: "customer_forwarder"},
		{ID: 5, OrderNo: "CANCELLED", Stage: model.TradeStageCancelled, StageUpdatedAt: now, UpdatedAt: now,
			Currency: "CNY", TotalAmount: 99999, QuoteExchangeRateCNY: 1, FreightMode: "customer_forwarder"},
		{ID: 6, OrderNo: "JUNE", CustomerName: "Acme", OwnerName: "Tom", Stage: model.TradeStageCompleted,
			StageUpdatedAt: june, UpdatedAt: june, Currency: "CNY", TotalAmount: 500,
			QuoteExchangeRateCNY: 1, FreightMode: "customer_forwarder"},
	}
	items := []model.TradeOrderItem{
		{OrderID: 1, ID: 11, LineNo: 1, SKU: "A", Quantity: 1, QuotedPrice: 100, PurchaseCurrency: "CNY", PurchasePrice: 420},
		{OrderID: 2, ID: 21, LineNo: 1, SKU: "B", Quantity: 1, QuotedPrice: 500, PurchaseCurrency: "CNY", PurchasePrice: 300},
		{OrderID: 2, ID: 22, LineNo: 2, SKU: "b", Quantity: 1, QuotedPrice: 500, PurchaseCurrency: "CNY", PurchasePrice: 300},
		{OrderID: 3, ID: 31, LineNo: 1, Quantity: 1, QuotedPrice: 100, PurchaseCurrency: "USD", PurchasePrice: 1},
		{OrderID: 4, ID: 41, LineNo: 1, Quantity: 1, QuotedPrice: 100, PurchaseCurrency: "EUR", PurchasePrice: 60},
		{OrderID: 5, ID: 51, LineNo: 1, Quantity: 1, QuotedPrice: 99999, PurchaseCurrency: "CNY", PurchasePrice: 1},
		{OrderID: 6, ID: 61, LineNo: 1, SKU: "A", Quantity: 1, QuotedPrice: 500, PurchaseCurrency: "CNY", PurchasePrice: 300},
	}
	return orders, items
}

func closeTo(a, b float64) bool { return math.Abs(a-b) < 0.0001 }

func TestTradeBossMonthReport(t *testing.T) {
	now := time.Date(2026, time.July, 27, 12, 0, 0, 0, time.Local)
	orders, items := tradeBossFixture(now)
	report, err := buildTradeBossReport(orders, items, "month", 2026, 7, now)
	if err != nil {
		t.Fatal(err)
	}
	summary := report.Summary
	if summary.CompletedOrders != 3 || summary.FinalizedOrders != 2 || summary.IncompleteOrders != 1 ||
		!closeTo(summary.RevenueCNY, 1700) || !closeTo(summary.TotalCostCNY, 1020) || !closeTo(summary.ProfitAmountCNY, 680) {
		t.Fatalf("unexpected month summary: %#v", summary)
	}
	if report.Previous.FinalizedOrders != 1 || !closeTo(report.Previous.ProfitAmountCNY, 200) {
		t.Fatalf("previous month should hold the June order: %#v", report.Previous)
	}
	if len(report.Trend) != 31 || !closeTo(report.Trend[26].ProfitAmountCNY, 680) || report.Trend[26].CompletedOrders != 3 {
		t.Fatalf("daily trend should put the orders on the 27th: %#v", report.Trend[26])
	}
	if report.ActiveOrders != 1 || len(report.Orders) != 3 {
		t.Fatalf("unexpected active/order list: %d %d", report.ActiveOrders, len(report.Orders))
	}
	if len(report.Products) != 2 || report.Products[0].Label != "B" || report.Products[0].Orders != 1 ||
		!closeTo(report.Products[0].ProfitAmountCNY, 400) || report.Products[0].Quantity != 2 {
		t.Fatalf("product breakdown should merge SKU lines of one order: %#v", report.Products)
	}
	if len(report.Owners) != 1 || report.Owners[0].Orders != 2 || !closeTo(report.Owners[0].ProfitAmountCNY, 680) {
		t.Fatalf("unexpected owner breakdown: %#v", report.Owners)
	}
	if len(report.Currencies) != 2 || report.Currencies[0].Currency != "CNY" || report.Currencies[1].Currency != "USD" {
		t.Fatalf("currency summaries must only contain finalized orders: %#v", report.Currencies)
	}
}

func TestTradeBossYearReport(t *testing.T) {
	now := time.Date(2026, time.July, 27, 12, 0, 0, 0, time.Local)
	orders, items := tradeBossFixture(now)
	report, err := buildTradeBossReport(orders, items, "year", 2026, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Trend) != 12 || !closeTo(report.Trend[5].ProfitAmountCNY, 200) || !closeTo(report.Trend[6].ProfitAmountCNY, 680) {
		t.Fatalf("monthly trend of the year is wrong: %#v", report.Trend)
	}
	if !closeTo(report.Summary.ProfitAmountCNY, 880) || report.Previous.CompletedOrders != 0 || report.PreviousLabel != "2025年" {
		t.Fatalf("unexpected year summary: %#v / %#v", report.Summary, report.Previous)
	}
	if len(report.AvailableYears) != 1 || report.AvailableYears[0] != 2026 {
		t.Fatalf("unexpected years: %#v", report.AvailableYears)
	}
	if acme := report.Customers[0]; acme.Label != "Acme" || acme.Orders != 2 || !closeTo(acme.ProfitAmountCNY, 480) {
		t.Fatalf("customers should rank by profit across the year: %#v", report.Customers)
	}
}

func TestTradeBossReportRejectsBadPeriod(t *testing.T) {
	now := time.Date(2026, time.July, 27, 12, 0, 0, 0, time.Local)
	for _, args := range []struct {
		period      string
		year, month int
	}{{"month", 2026, 13}, {"week", 2026, 1}, {"year", 1990, 0}} {
		if _, err := buildTradeBossReport(nil, nil, args.period, args.year, args.month, now); err == nil {
			t.Fatalf("expected error for %#v", args)
		}
	}
}
