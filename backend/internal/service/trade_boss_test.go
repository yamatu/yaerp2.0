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
	report, err := buildTradeBossReport(orders, items, "month", 2026, 7, now, model.DefaultTradeModules())
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
	report, err := buildTradeBossReport(orders, items, "year", 2026, 0, now, model.DefaultTradeModules())
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

func TestTradeBossSettlementCycle(t *testing.T) {
	now := time.Date(2026, time.November, 23, 12, 0, 0, 0, time.Local)
	modules := model.DefaultTradeModules()
	modules.SettlementStartDay = 26
	day := func(month time.Month, d int) *time.Time {
		value := time.Date(2026, month, d, 0, 0, 0, 0, time.Local)
		return &value
	}
	orders := []model.TradeOrder{
		// Oct 27 is past the 26th, so it belongs to November.
		{ID: 1, Stage: model.TradeStageCompleted, DealDate: day(time.October, 27), StageUpdatedAt: now,
			Currency: "USD", TotalAmount: 100, QuoteExchangeRateCNY: 6.6, FreightMode: "customer_forwarder"},
		// Moved into November by hand although the deal is from September.
		{ID: 2, Stage: model.TradeStageCompleted, DealDate: day(time.September, 13), SettlementMonth: "2026-11",
			StageUpdatedAt: now, Currency: "USD", TotalAmount: 40, QuoteExchangeRateCNY: 6.6, FreightMode: "customer_forwarder"},
		// A deal still being purchased, without a rate yet.
		{ID: 3, Stage: model.TradeStagePurchase, DealDate: day(time.November, 3), StageUpdatedAt: now,
			Currency: "USD", TotalAmount: 500, FreightMode: "customer_forwarder"},
		// Oct 25 is still October.
		{ID: 4, Stage: model.TradeStageCompleted, DealDate: day(time.October, 25), StageUpdatedAt: now,
			Currency: "USD", TotalAmount: 70, QuoteExchangeRateCNY: 7, FreightMode: "customer_forwarder"},
	}
	items := []model.TradeOrderItem{
		{OrderID: 1, ID: 11, LineNo: 1, SKU: "A", Quantity: 1, QuotedPrice: 100},
		{OrderID: 2, ID: 21, LineNo: 1, SKU: "B", Quantity: 1, QuotedPrice: 40},
		{OrderID: 3, ID: 31, LineNo: 1, SKU: "C", Quantity: 1, QuotedPrice: 500},
		{OrderID: 4, ID: 41, LineNo: 1, SKU: "D", Quantity: 1, QuotedPrice: 70},
	}
	report, err := buildTradeBossReport(orders, items, "month", 2026, 11, now, modules)
	if err != nil {
		t.Fatal(err)
	}
	if report.StartDate != "2026-10-26" || report.EndDate != "2026-11-25" || report.Trend[0].Label != "10/26" {
		t.Fatalf("November cycle should run Oct 26 - Nov 25: %s %s %s", report.StartDate, report.EndDate, report.Trend[0].Label)
	}
	summary := report.Summary
	if summary.SalesOrders != 3 || summary.SalesMissingRateOrders != 1 || !closeTo(summary.SalesRevenueCNY, 924) {
		t.Fatalf("sales should count every November deal: %#v", summary)
	}
	if summary.CompletedOrders != 2 || summary.FinalizedOrders != 0 {
		t.Fatalf("orders without purchase cost are completed but not finalized: %#v", summary)
	}
	if report.Trend[1].SalesOrders != 1 || report.Trend[0].SalesOrders != 1 {
		t.Fatalf("Oct 27 lands on the second day, the moved order on the first: %#v", report.Trend[:2])
	}
	if report.Previous.SalesOrders != 1 || !closeTo(report.Previous.SalesRevenueCNY, 490) {
		t.Fatalf("October keeps the Oct 25 deal: %#v", report.Previous)
	}
}

func TestSettlementMonthFor(t *testing.T) {
	modules := model.TradeModules{SettlementStartDay: 26}
	cases := map[string]string{"2026-10-25": "2026-10", "2026-10-26": "2026-11", "2026-12-31": "2027-01"}
	for date, want := range cases {
		parsed, _ := time.Parse("2006-01-02", date)
		if got := modules.SettlementMonthFor(parsed); got != want {
			t.Fatalf("%s: got %s want %s", date, got, want)
		}
	}
	if got := (model.TradeModules{}).SettlementMonthFor(time.Date(2026, 10, 31, 0, 0, 0, 0, time.UTC)); got != "2026-10" {
		t.Fatalf("calendar months by default, got %s", got)
	}
	for input, want := range map[string]string{"2026-11": "2026-11", "2026/1": "2026-01", "202611": "2026-11", "": ""} {
		if got, err := normalizeSettlementMonth(input); err != nil || got != want {
			t.Fatalf("%q: got %q %v", input, got, err)
		}
	}
	if _, err := normalizeSettlementMonth("2026-13"); err == nil {
		t.Fatal("month 13 must be rejected")
	}
}

func TestTradeBossReportRejectsBadPeriod(t *testing.T) {
	now := time.Date(2026, time.July, 27, 12, 0, 0, 0, time.Local)
	for _, args := range []struct {
		period      string
		year, month int
	}{{"month", 2026, 13}, {"week", 2026, 1}, {"year", 1990, 0}} {
		if _, err := buildTradeBossReport(nil, nil, args.period, args.year, args.month, now, model.DefaultTradeModules()); err == nil {
			t.Fatalf("expected error for %#v", args)
		}
	}
}
