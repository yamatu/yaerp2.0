package service

import (
	"math"
	"strings"
	"testing"
	"time"

	"yaerp/internal/model"
)

func TestNormalizeTradeCustomerUpdateAllowsEditingAndClearingNotes(t *testing.T) {
	accountID := int64(8)
	customer, err := normalizeTradeCustomerUpdate(&model.UpdateTradeCustomerRequest{
		Name: "  New customer name  ", CompanyName: "", Source: "whatsapp", Status: "active",
		CustomerLevel: "a", WhatsAppAccountID: &accountID, WhatsAppChatID: " 123@c.us ",
		Tags: []string{" VIP ", "vip", " Europe "}, Notes: "   ",
	})
	if err != nil {
		t.Fatalf("normalize customer update: %v", err)
	}
	if customer.Name != "New customer name" || customer.CompanyName != "New customer name" {
		t.Fatalf("customer name fields were not normalized: %#v", customer)
	}
	if customer.Notes != "" {
		t.Fatalf("notes should be clearable, got %q", customer.Notes)
	}
	if customer.Status != "active" || customer.CustomerLevel != "A" || customer.WhatsAppChatID != "123@c.us" {
		t.Fatalf("customer update fields were not normalized: %#v", customer)
	}
	if len(customer.Tags) != 2 || customer.Tags[0] != "VIP" || customer.Tags[1] != "Europe" {
		t.Fatalf("customer tags were not normalized: %#v", customer.Tags)
	}
}

func TestNormalizeTradeCustomerUpdateRejectsInvalidFields(t *testing.T) {
	for name, request := range map[string]*model.UpdateTradeCustomerRequest{
		"empty name":     {Name: "", Source: "manual", Status: "lead", CustomerLevel: "B"},
		"invalid source": {Name: "Customer", Source: "unknown", Status: "lead", CustomerLevel: "B"},
		"invalid status": {Name: "Customer", Source: "manual", Status: "deleted", CustomerLevel: "B"},
		"invalid level":  {Name: "Customer", Source: "manual", Status: "lead", CustomerLevel: "D"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := normalizeTradeCustomerUpdate(request); err == nil {
				t.Fatal("expected validation error")
			}
		})
	}
}

func TestValidateTradeOrderItemDeletion(t *testing.T) {
	for _, stage := range []string{
		model.TradeStageInquiry,
		model.TradeStageSupplierQuote,
		model.TradeStageQuotation,
	} {
		if err := validateTradeOrderItemDeletion(stage, nil); err != nil {
			t.Fatalf("stage %s should allow item deletion: %v", stage, err)
		}
	}
	if err := validateTradeOrderItemDeletion(model.TradeStagePurchase, nil); err == nil {
		t.Fatal("purchase stage must block item deletion")
	}
	if err := validateTradeOrderItemDeletion(model.TradeStageQuotation, []model.TradeCustomerQuoteRound{{Status: "accepted"}}); err == nil {
		t.Fatal("accepted customer quote must block item deletion")
	}
}

func TestBuildTradeProfitSummarySameCurrency(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "USD", TotalAmount: 1000,
		QuoteExchangeRateCNY: 7, AdditionalCostAmount: 50,
	}
	items := []model.TradeOrderItem{{ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "USD", PurchasePrice: 60}}
	profit := buildTradeProfitSummary(order, items)
	if !profit.CostComplete || !profit.Finalized {
		t.Fatalf("profit should be finalized: %#v", profit)
	}
	if profit.ProductCost != 600 || profit.TotalCost != 650 || profit.ProfitAmount != 350 {
		t.Fatalf("unexpected profit totals: %#v", profit)
	}
	if math.Abs(profit.ProfitMargin-35) > 0.0001 {
		t.Fatalf("profit margin = %v, want 35", profit.ProfitMargin)
	}
	if !profit.CNYComplete || profit.RevenueCNY != 7000 || profit.ProfitAmountCNY != 2450 {
		t.Fatalf("unexpected CNY totals: %#v", profit)
	}
}

func TestBuildTradeProfitSummaryRequiresCrossCurrencyRate(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "USD", TotalAmount: 1000,
		QuoteExchangeRateCNY: 7,
	}
	item := model.TradeOrderItem{ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "CNY", PurchasePrice: 60}
	profit := buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if profit.CostComplete || profit.Finalized || len(profit.Warnings) == 0 {
		t.Fatalf("missing exchange rate should keep profit provisional: %#v", profit)
	}
	item.WorkflowData = map[string]any{"cost_exchange_rate": 0.14}
	profit = buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if !profit.CostComplete || math.Abs(profit.ProductCost-84) > 0.0001 || math.Abs(profit.ProfitAmount-916) > 0.0001 {
		t.Fatalf("exchange rate was not applied: %#v", profit)
	}
}

func TestBuildTradeProfitSummaryIncludesFreightProfit(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "USD",
		TotalAmount: 1100, QuotedGoodsAmount: 1000, QuoteExchangeRateCNY: 7,
		FreightMode: "quoted", QuotedFreightAmount: 100,
		ActualFreightCurrency: "CNY", ActualFreightAmount: 500, ActualFreightToCNYRate: 1,
	}
	items := []model.TradeOrderItem{{
		ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100,
		PurchaseCurrency: "USD", PurchasePrice: 60,
	}}
	profit := buildTradeProfitSummary(order, items)
	if !profit.CostComplete || !profit.CNYComplete || !profit.Finalized {
		t.Fatalf("freight profit should be finalized: %#v", profit)
	}
	if math.Abs(profit.ActualFreightCost-(500.0/7.0)) > 0.0001 {
		t.Fatalf("actual freight = %v, want %v", profit.ActualFreightCost, 500.0/7.0)
	}
	if math.Abs(profit.FreightProfit-(100.0-500.0/7.0)) > 0.0001 {
		t.Fatalf("freight profit = %v", profit.FreightProfit)
	}
	if math.Abs(profit.ProfitAmountCNY-3000) > 0.0001 || math.Abs(profit.FreightProfitCNY-200) > 0.0001 {
		t.Fatalf("unexpected freight CNY totals: %#v", profit)
	}
}

func TestBuildTradeProfitSummaryCustomerForwarderIgnoresFreight(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "USD",
		TotalAmount: 1000, QuoteExchangeRateCNY: 7,
		FreightMode:           "customer_forwarder",
		ActualFreightCurrency: "CNY", ActualFreightAmount: 999, ActualFreightToCNYRate: 1,
	}
	items := []model.TradeOrderItem{{
		ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100,
		PurchaseCurrency: "USD", PurchasePrice: 60,
	}}
	profit := buildTradeProfitSummary(order, items)
	if !profit.Finalized || profit.FreightRevenue != 0 || profit.ActualFreightCost != 0 || profit.FreightProfit != 0 {
		t.Fatalf("customer forwarder should not affect freight profit: %#v", profit)
	}
}

func TestBuildTradeMonthlyProfit(t *testing.T) {
	now := time.Date(2026, time.July, 19, 12, 0, 0, 0, time.Local)
	orders := []model.TradeOrder{
		{
			ID: 1, Stage: model.TradeStageCompleted, StageUpdatedAt: now,
			Currency: "USD", TotalAmount: 100, QuoteExchangeRateCNY: 7,
			FreightMode: "customer_forwarder",
		},
		{
			ID: 2, Stage: model.TradeStageCompleted, StageUpdatedAt: now.AddDate(0, -1, 0),
			Currency: "EUR", TotalAmount: 100, FreightMode: "customer_forwarder",
		},
		{ID: 3, Stage: model.TradeStageShipment, StageUpdatedAt: now, Currency: "USD"},
	}
	items := map[int64][]model.TradeOrderItem{
		1: {{ID: 11, LineNo: 1, Quantity: 10, QuotedPrice: 10, PurchaseCurrency: "USD", PurchasePrice: 6}},
		2: {{ID: 21, LineNo: 1, Quantity: 10, QuotedPrice: 10, PurchaseCurrency: "EUR", PurchasePrice: 6}},
	}
	monthly := buildTradeMonthlyProfit(orders, items, now)
	if len(monthly) != 12 {
		t.Fatalf("monthly buckets = %d, want 12", len(monthly))
	}
	current := monthly[len(monthly)-1]
	if current.Month != "2026-07" || current.CompletedOrders != 1 || current.FinalizedOrders != 1 {
		t.Fatalf("unexpected current month: %#v", current)
	}
	if math.Abs(current.RevenueCNY-700) > 0.0001 || math.Abs(current.ProfitAmountCNY-280) > 0.0001 {
		t.Fatalf("unexpected current month amounts: %#v", current)
	}
	previous := monthly[len(monthly)-2]
	if previous.Month != "2026-06" || previous.CompletedOrders != 1 || previous.IncompleteOrders != 1 || previous.FinalizedOrders != 0 {
		t.Fatalf("unexpected previous month: %#v", previous)
	}
}

func TestTradePISelectionAndHTML(t *testing.T) {
	quotes := []model.TradeCustomerQuoteRound{
		{ID: 2, RoundNo: 2, Status: "accepted"},
		{ID: 1, RoundNo: 1, Status: "superseded"},
	}
	selected, err := selectTradePIQuote(quotes, &model.TradePIRequest{})
	if err != nil || selected.ID != 2 {
		t.Fatalf("select accepted quote: %#v, %v", selected, err)
	}
	selected, err = selectTradePIQuote(quotes, &model.TradePIRequest{QuoteID: 1})
	if err != nil || selected.ID != 1 {
		t.Fatalf("select explicit historic quote: %#v, %v", selected, err)
	}

	order := &model.TradeOrder{
		OrderNo: "FT-TEST-PI", CustomerName: "Example Buyer", CustomerCompany: "Example Buyer LLC",
		Items: []model.TradeOrderItem{{ID: 10, Specification: "220V", PurchasePrice: 1}},
	}
	quote := &model.TradeCustomerQuoteRound{
		RoundNo: 2, Currency: "USD", Status: "accepted", GoodsAmount: 100, TotalAmount: 120,
		FreightMode: "quoted", FreightAmount: 20,
		Items: []model.TradeCustomerQuoteItem{{
			OrderItemID: 10, SKU: "SKU-1", ProductName: "Industrial Motor",
			Quantity: 10, Unit: "pcs", UnitPrice: 10, Amount: 100,
		}},
	}
	document := &tradePIDocument{
		Order: order, Quote: quote, PINumber: "PI-FT-TEST-PI-R2",
		Profile:       model.TradePIProfile{CompanyName: "Seller Co.", AccountName: "Seller Co."},
		IssueDate:     time.Date(2026, 7, 19, 0, 0, 0, 0, time.Local),
		ValidUntil:    time.Date(2026, 8, 2, 0, 0, 0, 0, time.Local),
		PaymentMethod: "T/T", DeliveryTerms: "FOB Shanghai", DeliveryTime: "14 days",
	}
	htmlDoc := renderTradePIHTML(document)
	for _, expected := range []string{"PROFORMA", "PI-FT-TEST-PI-R2", "Example Buyer LLC", "Industrial Motor", "120.00", "FOB Shanghai"} {
		if !strings.Contains(htmlDoc, expected) {
			t.Fatalf("PI HTML missing %q", expected)
		}
	}
	if strings.Contains(htmlDoc, "PurchasePrice") || strings.Contains(htmlDoc, "purchase_price") {
		t.Fatal("PI HTML must not expose internal purchase cost")
	}
	if words := tradePIAmountWords("USD", 120.35); words != "USD ONE HUNDRED TWENTY AND 35/100 ONLY" {
		t.Fatalf("amount words = %q", words)
	}
}

func TestTradeStageSequence(t *testing.T) {
	expected := map[string]string{
		model.TradeStageInquiry:       model.TradeStageSupplierQuote,
		model.TradeStageSupplierQuote: model.TradeStageQuotation,
		model.TradeStageQuotation:     model.TradeStagePurchase,
		model.TradeStagePurchase:      model.TradeStageReceiving,
		model.TradeStageReceiving:     model.TradeStageInspection,
		model.TradeStageInspection:    model.TradeStagePacking,
		model.TradeStagePacking:       model.TradeStageShipment,
		model.TradeStageShipment:      model.TradeStageCompleted,
		model.TradeStageCompleted:     "",
	}
	for current, next := range expected {
		if actual := nextTradeStage(current); actual != next {
			t.Fatalf("nextTradeStage(%q) = %q, want %q", current, actual, next)
		}
	}
	if actual := prevTradeStage(model.TradeStageSupplierQuote); actual != model.TradeStageInquiry {
		t.Fatalf("prevTradeStage(supplier_quote) = %q, want inquiry", actual)
	}
	if actual := prevTradeStage(model.TradeStageCompleted); actual != model.TradeStageShipment {
		t.Fatalf("prevTradeStage(completed) = %q, want shipment", actual)
	}
}

func TestPhoneFromWhatsAppChat(t *testing.T) {
	if actual := phoneFromWhatsAppChat("+44 7700-900123@c.us"); actual != "+447700900123" {
		t.Fatalf("phoneFromWhatsAppChat returned %q", actual)
	}
}

func TestTradeWorkbookDefinitions(t *testing.T) {
	now := time.Now()
	order := &model.TradeOrder{
		ID: 8, OrderNo: "FT-TEST-000001", Title: "夏季产品询价", Stage: model.TradeStageInquiry,
		Priority: "high", OwnerName: "sales", InquiryDate: now, Currency: "USD", Incoterm: "FOB",
		DestinationCountry: "Italy", DestinationPort: "Genoa",
	}
	customer := &model.TradeCustomer{ID: 2, Name: "Marco", CompanyName: "Example Import SRL"}
	items := []model.TradeOrderItem{{LineNo: 1, SKU: "SKU-1", ProductName: "示例产品", Quantity: 100, Unit: "件"}}

	definitions := tradeWorkbookDefinitions(order, customer, items)
	if len(definitions) != 9 {
		t.Fatalf("expected 9 trade sheets, got %d", len(definitions))
	}
	wantedNames := []string{"订单总览", "询价明细", "供应商询价", "报价单", "采购跟进", "仓库到货", "质检记录", "装箱清单", "发货跟踪"}
	for index, name := range wantedNames {
		if definitions[index].Name != name {
			t.Fatalf("sheet %d name = %q, want %q", index, definitions[index].Name, name)
		}
		if len(definitions[index].Columns) == 0 || len(definitions[index].Rows) == 0 {
			t.Fatalf("sheet %q must contain columns and initial rows", name)
		}
	}
}

func TestTradeWorkbookDefinitionsKeepExistingProgressAndUnquotedItems(t *testing.T) {
	now := time.Now()
	order := &model.TradeOrder{
		ID: 8, OrderNo: "FT-TEST-000002", Title: "追加产品询价", Stage: model.TradeStageSupplierQuote,
		Priority: "normal", OwnerName: "sales", InquiryDate: now, Currency: "USD",
	}
	customer := &model.TradeCustomer{ID: 2, Name: "Marco"}
	items := []model.TradeOrderItem{
		{ID: 11, LineNo: 1, SKU: "SKU-1", ProductName: "已有产品", Quantity: 10, Unit: "件", QuotedPrice: 12.5, ReceivedQuantity: 4, AcceptedQuantity: 3},
		{ID: 12, LineNo: 2, SKU: "SKU-2", ProductName: "新增产品", Quantity: 20, Unit: "件"},
	}
	quotes := []model.TradeSupplierQuote{{
		OrderItemID: 11, LineNo: 1, SKU: "SKU-1", ProductName: "已有产品",
		SupplierName: "供应商 A", Currency: "USD", UnitPrice: 8.8,
	}}

	definitions := tradeWorkbookDefinitionsWithContext(order, customer, items, nil, quotes, nil, nil)
	byName := make(map[string]tradeSheetDefinition, len(definitions))
	for _, definition := range definitions {
		byName[definition.Name] = definition
	}

	supplierRows := byName["供应商询价"].Rows
	if len(supplierRows) != 2 {
		t.Fatalf("supplier quote rows = %d, want quoted and newly-added product rows", len(supplierRows))
	}
	if supplierRows[1]["line_no"] != 2 || supplierRows[1]["supplier"] != "" {
		t.Fatalf("new product row was not retained: %#v", supplierRows[1])
	}
	if got := byName["报价单"].Rows[0]["unit_price"]; got != 12.5 {
		t.Fatalf("quoted price = %#v, want 12.5", got)
	}
	if got := byName["仓库到货"].Rows[0]["received_qty"]; got != 4.0 {
		t.Fatalf("received quantity = %#v, want 4", got)
	}
	if got := byName["质检记录"].Rows[0]["passed_qty"]; got != 3.0 {
		t.Fatalf("accepted quantity = %#v, want 3", got)
	}
	if got := byName["质检记录"].Rows[0]["failed_qty"]; got != 1.0 {
		t.Fatalf("failed quantity = %#v, want 1", got)
	}
}

func TestTradeWorkbookDefinitionsPreserveStageWorkflowData(t *testing.T) {
	order := &model.TradeOrder{ID: 10, OrderNo: "FT-TEST-000010", Stage: model.TradeStageReceiving, Currency: "USD"}
	customer := &model.TradeCustomer{ID: 3, Name: "Workflow Customer"}
	items := []model.TradeOrderItem{{
		ID: 21, LineNo: 1, SKU: "SYNC-1", ProductName: "同步产品", Quantity: 8, Unit: "件",
		ReceivedQuantity: 6, AcceptedQuantity: 5, PackedQuantity: 4, CartonCount: 2,
		WorkflowData: map[string]any{
			"warehouse_location": "A-03", "received_date": "2026-07-19", "receipt_status": "部分到货",
			"sample_qty": 6.0, "inspection_result": "返工", "inspection_issue": "外观划痕",
			"inspector": "quality", "inspection_date": "2026-07-20",
			"carton_no": "C-01", "carton_size": "40x30x20", "marks": "HANDLE WITH CARE",
		},
	}}
	definitions := tradeWorkbookDefinitionsWithContext(order, customer, items, nil, nil, nil, nil)
	byName := make(map[string]tradeSheetDefinition, len(definitions))
	for _, definition := range definitions {
		byName[definition.Name] = definition
	}
	if row := byName["仓库到货"].Rows[0]; row["warehouse_location"] != "A-03" || row["receipt_status"] != "部分到货" {
		t.Fatalf("receiving workflow data was not preserved: %#v", row)
	}
	if row := byName["质检记录"].Rows[0]; row["issue"] != "外观划痕" || row["inspector"] != "quality" {
		t.Fatalf("inspection workflow data was not preserved: %#v", row)
	}
	if row := byName["装箱清单"].Rows[0]; row["carton_size"] != "40x30x20" || row["marks"] != "HANDLE WITH CARE" {
		t.Fatalf("packing workflow data was not preserved: %#v", row)
	}
}

func TestBuildTradeOrderItems(t *testing.T) {
	items, err := buildTradeOrderItems([]model.CreateTradeOrderItemRequest{{
		SKU: " SKU-3 ", ProductName: " 新产品 ", Quantity: 2,
	}})
	if err != nil {
		t.Fatalf("buildTradeOrderItems returned error: %v", err)
	}
	if len(items) != 1 || items[0].SKU != "SKU-3" || items[0].ProductName != "新产品" || items[0].Unit != "件" {
		t.Fatalf("unexpected normalized item: %#v", items)
	}
	if _, err := buildTradeOrderItems([]model.CreateTradeOrderItemRequest{{ProductName: "", Quantity: 1}}); err == nil {
		t.Fatal("expected invalid product name to fail")
	}
}

func TestTradeOrderAdvanceBlockers(t *testing.T) {
	items := []model.TradeOrderItem{
		{ID: 1, LineNo: 1, SKU: "SKU-A", ProductName: "产品 A", Quantity: 10, Unit: "件"},
		{ID: 2, LineNo: 2, SKU: "SKU-B", ProductName: "产品 B", Quantity: 20, Unit: "件"},
	}
	order := &model.TradeOrder{ID: 9, Stage: model.TradeStageSupplierQuote, Items: items}
	order.SupplierQuotes = []model.TradeSupplierQuote{{OrderItemID: 1, IsSelected: true}}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 {
		t.Fatalf("supplier quote blockers = %#v, want one missing item blocker", blockers)
	}

	order.Stage = model.TradeStageQuotation
	order.Items[0].QuotedPrice = 100
	order.Items[1].QuotedPrice = 50
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 {
		t.Fatalf("quotation without customer acceptance should be blocked, got %#v", blockers)
	}
	order.CustomerQuotes = []model.TradeCustomerQuoteRound{{
		ID: 1, OrderID: order.ID, RoundNo: 1, Status: "accepted",
		Currency: "USD", ExchangeRateCNY: 7,
	}}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("complete quotation should have no blockers, got %#v", blockers)
	}

	order.Stage = model.TradeStageInspection
	order.Items[0].ReceivedQuantity = 10
	order.Items[0].AcceptedQuantity = 10
	order.Items[1].ReceivedQuantity = 20
	order.Items[1].AcceptedQuantity = 20
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 || blockers[0] != "至少上传一张关联订单的质检照片" {
		t.Fatalf("inspection blockers = %#v", blockers)
	}
	order.InspectionPhotos = []model.TradeInspectionPhoto{{ID: 1, OrderID: order.ID}}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("complete inspection should have no blockers, got %#v", blockers)
	}

	order.Stage = model.TradeStageShipment
	order.Shipment = &model.TradeShipment{OrderID: order.ID, Carrier: "物流公司", BookingNo: "BK-001", ShippingStatus: "运输中"}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("complete shipment should have no blockers, got %#v", blockers)
	}
	order.FreightMode = "quoted"
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 1 || blockers[0] != "我方已向客户报价运费，请填写最终实际运费" {
		t.Fatalf("quoted freight should require actual shipment cost, got %#v", blockers)
	}
	order.Shipment.ActualFreightCurrency = "CNY"
	order.Shipment.ActualFreightAmount = 500
	order.Shipment.ActualFreightToCNYRate = 1
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 0 {
		t.Fatalf("shipment with actual freight should have no blockers, got %#v", blockers)
	}
}
