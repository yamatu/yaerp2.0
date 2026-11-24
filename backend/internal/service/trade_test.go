package service

import (
	"errors"
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

func TestBuildTradeProfitSummaryInfersCNYCostRateFromQuoteRate(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "USD", TotalAmount: 1000,
		QuoteExchangeRateCNY: 7,
	}
	item := model.TradeOrderItem{ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "CNY", PurchasePrice: 60}
	profit := buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if !profit.CostComplete || !profit.Finalized || math.Abs(profit.ProductCost-(600.0/7.0)) > 0.0001 {
		t.Fatalf("CNY purchase cost should use the inverse quote rate: %#v", profit)
	}
	// The cost was paid in CNY: a manual rate must not change what it cost.
	item.WorkflowData = map[string]any{"cost_exchange_rate": 0.14}
	profit = buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if !profit.CostComplete || math.Abs(profit.TotalCostCNY-600) > 0.0001 || math.Abs(profit.ProfitAmountCNY-6400) > 0.0001 {
		t.Fatalf("a CNY cost must stay CNY 600: %#v", profit)
	}
	item.PurchaseCurrency, item.WorkflowData = "EUR", map[string]any{"cost_exchange_rate": 1.1}
	profit = buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if !profit.CostComplete || math.Abs(profit.ProductCost-660) > 0.0001 {
		t.Fatalf("other currencies still use the manual rate: %#v", profit)
	}
}

func TestBuildTradeProfitSummaryIgnoresStaleRateForSameCurrency(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageCompleted, Currency: "CNY", TotalAmount: 1000,
		QuoteExchangeRateCNY: 1,
	}
	item := model.TradeOrderItem{
		ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100,
		PurchaseCurrency: "CNY", PurchasePrice: 60,
		WorkflowData: map[string]any{"cost_exchange_rate": 0.14},
	}
	profit := buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if !profit.Finalized || profit.ProductCost != 600 || profit.ProfitAmount != 400 {
		t.Fatalf("same-currency costs must ignore stale conversion rates: %#v", profit)
	}
}

func TestBuildTradeProfitSummaryRequiresUnknownCrossCurrencyRate(t *testing.T) {
	order := &model.TradeOrder{Stage: model.TradeStageCompleted, Currency: "USD", TotalAmount: 1000, QuoteExchangeRateCNY: 7}
	item := model.TradeOrderItem{ID: 1, LineNo: 1, Quantity: 10, QuotedPrice: 100, PurchaseCurrency: "EUR", PurchasePrice: 60}
	profit := buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if profit.CostComplete || profit.Finalized || len(profit.Warnings) == 0 {
		t.Fatalf("unknown cross-currency rate should keep profit provisional: %#v", profit)
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

func TestNormalizeTradeShippingStatus(t *testing.T) {
	for input, expected := range map[string]string{
		"":    "未发货",
		"未到":  "未发货",
		"待订舱": "未发货",
		"已发货": "已发货",
		"到了":  "已发货",
		"运输中": "已发货",
		"已签收": "已发货",
	} {
		if actual := normalizeTradeShippingStatus(input); actual != expected {
			t.Fatalf("normalizeTradeShippingStatus(%q) = %q, want %q", input, actual, expected)
		}
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
		BankDetailsImageDataURI: "data:image/png;base64,cGk=",
	}
	htmlDoc := renderTradePIHTML(document)
	for _, expected := range []string{
		"PROFORMA INVOICE", "PI DATE 合同日", "PI-FT-TEST-PI-R2", "Example Buyer LLC",
		"Industrial Motor", "120.00", "FOB Shanghai", "Bank Account:", "data:image/png;base64,cGk=",
	} {
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

func TestTradePIBankImagePrefersQuoteRoundOverride(t *testing.T) {
	defaultImageID := int64(11)
	quoteImageID := int64(22)
	profile := &model.TradePIProfile{BankDetailsImageAttachmentID: &defaultImageID}
	quote := &model.TradeCustomerQuoteRound{PIBankDetailsImageAttachmentID: &quoteImageID}
	selected := tradePIBankImageAttachmentID(profile, quote)
	if selected == nil || *selected != quoteImageID {
		t.Fatalf("quote-specific PI bank image should win, got %#v", selected)
	}
	quote.PIBankDetailsImageAttachmentID = nil
	selected = tradePIBankImageAttachmentID(profile, quote)
	if selected == nil || *selected != defaultImageID {
		t.Fatalf("default PI profile image should be the fallback, got %#v", selected)
	}
	if selected := tradePIBankImageAttachmentID(&model.TradePIProfile{}, quote); selected != nil {
		t.Fatalf("empty PI image configuration should return nil, got %#v", selected)
	}
}

func TestTradePISellerProfileOverridesOnlySellerIdentity(t *testing.T) {
	imageID := int64(42)
	profile := model.TradePIProfile{
		CompanyName: "Default Seller", Address: "Default address", ContactName: "Default contact",
		Phone: "10086", Email: "default@example.com", TaxID: "DEFAULT-TAX",
		BankName: "Default Bank", AccountNumber: "123", BankDetailsImageAttachmentID: &imageID,
	}
	result := applyTradePISellerProfile(profile, &model.TradePISellerProfile{
		CompanyName: "Quote Seller", Address: "Quote address", ContactName: "Quote contact",
		Phone: "20000", Email: "quote@example.com", TaxID: "QUOTE-TAX",
	})
	if result.CompanyName != "Quote Seller" || result.Email != "quote@example.com" || result.TaxID != "QUOTE-TAX" {
		t.Fatalf("quote seller profile was not applied: %#v", result)
	}
	if result.BankName != profile.BankName || result.AccountNumber != profile.AccountNumber || result.BankDetailsImageAttachmentID != profile.BankDetailsImageAttachmentID {
		t.Fatalf("seller override changed bank details: %#v", result)
	}
}

func TestMergeTradeDestinationRemovesBlankAndDuplicateValues(t *testing.T) {
	if actual := mergeTradeDestination("Brazil", " Santos ", "brazil", ""); actual != "Brazil · Santos" {
		t.Fatalf("mergeTradeDestination() = %q", actual)
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
	if _, err := buildTradeOrderItems([]model.CreateTradeOrderItemRequest{{SKU: " ", ProductName: "", Quantity: 1}}); !errors.Is(err, errTradeItemSKURequired) {
		t.Fatalf("expected missing SKU and product name to fail with SKU error, got %v", err)
	}
	if _, err := buildTradeOrderItems([]model.CreateTradeOrderItemRequest{{SKU: "SKU-9", Quantity: 0}}); err == nil {
		t.Fatal("expected non-positive quantity to fail")
	}
}

func TestBuildTradeOrderItemsMergesSKUAndProductName(t *testing.T) {
	items, err := buildTradeOrderItems([]model.CreateTradeOrderItemRequest{
		{SKU: " SKU-ONLY ", Quantity: 1},
		{ProductName: " 只有名称 ", Quantity: 1},
		{SKU: "SKU-2", ProductName: "名称 2", Quantity: 1},
	})
	if err != nil {
		t.Fatalf("buildTradeOrderItems returned error: %v", err)
	}
	expected := [][2]string{{"SKU-ONLY", "SKU-ONLY"}, {"只有名称", "只有名称"}, {"SKU-2", "名称 2"}}
	for index, want := range expected {
		if items[index].SKU != want[0] || items[index].ProductName != want[1] {
			t.Fatalf("item %d = %q/%q, want %q/%q", index, items[index].SKU, items[index].ProductName, want[0], want[1])
		}
	}
	if errTradeItemSKURequired.Error() != "每个产品必须填写 SKU" {
		t.Fatalf("unexpected SKU error message %q", errTradeItemSKURequired.Error())
	}
}

func TestApplyTradeStageItemUpdateKeepsSKUAndProductNameInSync(t *testing.T) {
	item := &model.TradeOrderItem{SKU: "OLD", ProductName: "旧名称"}
	if err := applyTradeStageItemUpdate(model.TradeStageInquiry, item, &model.UpdateTradeStageItemRequest{
		SKU: " NEW-SKU ", Quantity: 3,
	}); err != nil {
		t.Fatalf("applyTradeStageItemUpdate returned error: %v", err)
	}
	if item.SKU != "NEW-SKU" || item.ProductName != "NEW-SKU" {
		t.Fatalf("blank product name should follow SKU: %#v", item)
	}
	if err := applyTradeStageItemUpdate(model.TradeStageInquiry, item, &model.UpdateTradeStageItemRequest{
		SKU: "SKU-A", ProductName: "名称 A", Quantity: 3,
	}); err != nil {
		t.Fatalf("applyTradeStageItemUpdate returned error: %v", err)
	}
	if item.SKU != "SKU-A" || item.ProductName != "名称 A" {
		t.Fatalf("distinct SKU and product name should both be kept: %#v", item)
	}
	if err := applyTradeStageItemUpdate(model.TradeStageInquiry, item, &model.UpdateTradeStageItemRequest{Quantity: 3}); !errors.Is(err, errTradeItemSKURequired) {
		t.Fatalf("expected SKU error, got %v", err)
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
	order.Shipment = &model.TradeShipment{OrderID: order.ID, BookingNo: "BK-001", ShippingStatus: "未发货"}
	if blockers := tradeOrderAdvanceBlockers(order); len(blockers) != 3 {
		t.Fatalf("incomplete shipment should require carrier, arrival and payment proof, got %#v", blockers)
	}
	order.Shipment.Carrier = "DHL"
	order.Shipment.ShippingStatus = "已发货"
	order.CustomerQuotes[0].PaymentProofs = []model.TradePaymentProof{{ID: 1, OrderID: order.ID, QuoteID: 1}}
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

func TestTradeOrderAdvanceBlockersRejectsImportStillInProgress(t *testing.T) {
	order := &model.TradeOrder{
		Stage: model.TradeStageReceiving, Source: "ai_import", DataStatus: "importing",
		Items: []model.TradeOrderItem{{ID: 1, ProductName: "产品", Quantity: 1, ReceivedQuantity: 1}},
	}
	blockers := tradeOrderAdvanceBlockers(order)
	if len(blockers) != 1 || blockers[0] != "AI 导入仍在处理中，请等待系统完成导入" {
		t.Fatalf("importing order blockers = %#v", blockers)
	}
}

func TestDefaultTradeSupplierQuoteCurrencyUsesCNYForDomesticSuppliers(t *testing.T) {
	for _, supplier := range []*model.TradeSupplier{
		nil,
		{Country: "", DefaultCurrency: "USD"},
		{Country: "中国", DefaultCurrency: "USD"},
		{Country: "China", DefaultCurrency: "USD"},
	} {
		if actual := defaultTradeSupplierQuoteCurrency(supplier); actual != "CNY" {
			t.Fatalf("domestic supplier currency = %q, want CNY", actual)
		}
	}
	foreign := &model.TradeSupplier{Country: "Germany", DefaultCurrency: "EUR"}
	if actual := defaultTradeSupplierQuoteCurrency(foreign); actual != "EUR" {
		t.Fatalf("foreign supplier currency = %q, want EUR", actual)
	}
}

func TestNormalizeTradePurchaseCurrency(t *testing.T) {
	for input, want := range map[string]string{
		"": "CNY", "rmb": "CNY", "人民币": "CNY", "元": "CNY", "¥": "CNY", " cny ": "CNY",
		"usd": "USD", "美金": "USD", "$": "USD", "eur": "EUR", "港币": "HKD",
	} {
		if got, err := normalizeTradePurchaseCurrency(input); err != nil || got != want {
			t.Fatalf("%q: got %q %v, want %q", input, got, err, want)
		}
	}
	for _, bad := range []string{"dollar", "US", "12"} {
		if _, err := normalizeTradePurchaseCurrency(bad); err == nil {
			t.Fatalf("%q should be rejected", bad)
		}
	}
}

// A CNY 2,000 cost on a USD order at 6.5 is CNY 2,000, never 2,000 x 6.5.
func TestTradeProfitKeepsCNYCostWhateverTheRate(t *testing.T) {
	order := &model.TradeOrder{Stage: model.TradeStagePurchase, Currency: "USD", QuoteExchangeRateCNY: 6.5, FreightMode: "customer_forwarder"}
	item := model.TradeOrderItem{ID: 1, LineNo: 1, Quantity: 1, QuotedPrice: 500, PurchaseCurrency: "CNY", PurchasePrice: 2000,
		WorkflowData: map[string]any{"cost_exchange_rate": 1.0}}
	profit := buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if math.Abs(profit.TotalCostCNY-2000) > 0.001 || math.Abs(profit.ProfitAmountCNY-(3250-2000)) > 0.001 {
		t.Fatalf("CNY cost must stay 2000: cost %v profit %v", profit.TotalCostCNY, profit.ProfitAmountCNY)
	}
	item.PurchaseCurrency = "USD"
	profit = buildTradeProfitSummary(order, []model.TradeOrderItem{item})
	if math.Abs(profit.TotalCostCNY-13000) > 0.001 {
		t.Fatalf("a real USD cost converts at the order rate: %v", profit.TotalCostCNY)
	}
}
