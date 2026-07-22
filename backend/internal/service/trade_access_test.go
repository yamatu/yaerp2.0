package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestCanViewTradeOrderUsesOwnerOrCurrentStage(t *testing.T) {
	service := &TradeService{}
	access := &tradeUserAccess{
		profile:     model.TradeAccessProfile{},
		stageAccess: map[string]bool{model.TradeStageInspection: true},
	}
	if !service.canViewTradeOrder(7, &model.TradeOrder{OwnerID: 7, Stage: model.TradeStagePurchase}, access) {
		t.Fatal("order owner should keep access to their own workflow")
	}
	if !service.canViewTradeOrder(7, &model.TradeOrder{OwnerID: 9, Stage: model.TradeStageInspection}, access) {
		t.Fatal("current-stage assignee should see the corresponding task")
	}
	if service.canViewTradeOrder(7, &model.TradeOrder{OwnerID: 9, Stage: model.TradeStageShipment}, access) {
		t.Fatal("employee must not see an unrelated stage")
	}
}

func TestCanViewTradeOrderAllowsConfiguredPositionsToFollowProgress(t *testing.T) {
	service := &TradeService{}
	access := &tradeUserAccess{
		profile:       model.TradeAccessProfile{CanViewOrderProgress: true},
		positionCodes: map[string]bool{"sales": true},
		stageAccess:   map[string]bool{model.TradeStageInquiry: true},
	}
	order := &model.TradeOrder{OwnerID: 9, Stage: model.TradeStagePacking}
	if !service.canViewTradeOrder(7, order, access) {
		t.Fatal("configured trade position should be able to follow order progress after handoff")
	}
	stages := tradeOrderScopeStages(access)
	for _, wanted := range []string{model.TradeStageInquiry, model.TradeStagePacking, model.TradeStageCompleted, model.TradeStageCancelled} {
		if !containsTradeLabel(stages, wanted) {
			t.Fatalf("progress scope should include stage %q: %#v", wanted, stages)
		}
	}
}

func TestRedactTradeTimelineDetailsKeepsOnlyCurrentTaskHandoff(t *testing.T) {
	actorID := int64(5)
	events := []model.TradeOrderStageEvent{
		{ID: 1, FromStage: model.TradeStageInquiry, ToStage: model.TradeStageSupplierQuote, ActorID: &actorID, ActorName: "sales", Note: "private inquiry note", Snapshot: map[string]any{"price": 10}},
		{ID: 2, FromStage: model.TradeStageSupplierQuote, ToStage: model.TradeStageQuotation, ActorID: &actorID, ActorName: "quotation", Note: "current handoff note", Snapshot: map[string]any{"supplier": "private"}},
	}
	redactTradeTimelineDetails(events, model.TradeStageQuotation, true)
	if events[0].Note != "" || events[0].ActorID != nil || events[0].ActorName != "" || len(events[0].Snapshot) != 0 {
		t.Fatalf("historic timeline details should be redacted: %#v", events[0])
	}
	if events[1].Note != "current handoff note" || events[1].ActorName != "quotation" || len(events[1].Snapshot) != 0 {
		t.Fatalf("current task handoff should keep note and actor but hide snapshot: %#v", events[1])
	}

	redactTradeTimelineDetails(events, model.TradeStagePacking, false)
	if events[1].Note != "" || events[1].ActorID != nil || events[1].ActorName != "" {
		t.Fatalf("progress-only timeline must not expose task details: %#v", events[1])
	}
}

func TestRedactTradePaymentRecordsUsesUploaderScope(t *testing.T) {
	quotes := []model.TradeCustomerQuoteRound{{
		ID: 1, Status: "accepted", PaymentStatus: "paid", PaymentCurrency: "USD", PaidAmount: 100,
		PaymentProofs: []model.TradePaymentProof{
			{ID: 11, UploadedBy: 7, UploadedByName: "current"},
			{ID: 12, UploadedBy: 9, UploadedByName: "other"},
		},
	}}
	redactTradePaymentRecords(7, quotes, &model.TradeOrderAccess{CanViewPaymentRecords: true})
	if len(quotes[0].PaymentProofs) != 1 || quotes[0].PaymentProofs[0].UploadedBy != 7 {
		t.Fatalf("own scope must only retain the current user's proof: %#v", quotes[0].PaymentProofs)
	}
	if quotes[0].PaymentStatus != "" || quotes[0].PaidAmount != 0 {
		t.Fatal("own scope must hide aggregate payment status and amount")
	}

	redactTradePaymentRecords(7, quotes, &model.TradeOrderAccess{})
	if quotes[0].PaymentStatus != "" || quotes[0].PaidAmount != 0 || quotes[0].PaymentProofs != nil {
		t.Fatalf("users without payment access must not receive payment data: %#v", quotes[0])
	}
}

func TestRedactTradePaymentRecordsKeepsAllScope(t *testing.T) {
	quotes := []model.TradeCustomerQuoteRound{{
		PaymentStatus: "partial", PaymentCurrency: "USD", PaidAmount: 75,
		PaymentProofs: []model.TradePaymentProof{{ID: 11, UploadedBy: 7}, {ID: 12, UploadedBy: 9}},
	}}
	redactTradePaymentRecords(7, quotes, &model.TradeOrderAccess{
		CanViewPaymentRecords: true, CanViewAllPaymentRecords: true,
	})
	if quotes[0].PaymentStatus != "partial" || quotes[0].PaidAmount != 75 || len(quotes[0].PaymentProofs) != 2 {
		t.Fatalf("all scope should retain the complete payment record: %#v", quotes[0])
	}
}

func TestTradePaymentReviewQuotesHidesQuotePricing(t *testing.T) {
	quotes := []model.TradeCustomerQuoteRound{
		{ID: 1, Status: "draft", GoodsAmount: 90},
		{
			ID: 2, OrderID: 3, RoundNo: 2, Currency: "USD", Status: "accepted",
			GoodsAmount: 100, TotalAmount: 120, CustomerFeedback: "private negotiation",
			PaymentStatus: "partial", PaymentCurrency: "USD", PaidAmount: 60,
			PaymentProofs: []model.TradePaymentProof{{ID: 5, UploadedBy: 7}},
		},
	}
	review := tradePaymentReviewQuotes(quotes)
	if len(review) != 1 || review[0].ID != 2 {
		t.Fatalf("payment review should only expose the accepted quote: %#v", review)
	}
	if review[0].GoodsAmount != 0 || review[0].TotalAmount != 0 || review[0].CustomerFeedback != "" || len(review[0].Items) != 0 {
		t.Fatalf("payment review must not expose quote pricing or negotiation details: %#v", review[0])
	}
	if review[0].PaymentStatus != "partial" || review[0].PaidAmount != 60 || len(review[0].PaymentProofs) != 1 {
		t.Fatalf("payment reconciliation fields should remain available: %#v", review[0])
	}
}

func TestNormalizeTradePaymentRecordAccess(t *testing.T) {
	for input, expected := range map[string]string{
		model.TradePaymentRecordAccessNone: model.TradePaymentRecordAccessNone,
		model.TradePaymentRecordAccessOwn:  model.TradePaymentRecordAccessOwn,
		model.TradePaymentRecordAccessAll:  model.TradePaymentRecordAccessAll,
		"unexpected":                       model.TradePaymentRecordAccessNone,
	} {
		if actual := normalizeTradePaymentRecordAccess(input); actual != expected {
			t.Fatalf("normalize %q: expected %q, got %q", input, expected, actual)
		}
	}
}

func TestTradeOverviewColumnScopeMasksSensitiveFields(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.Sheet.CanView = true
	matrix.DefaultPermission = "read"
	applyTradeSheetColumnScope(matrix, "订单总览", &model.TradeOrderAccess{})
	for _, column := range []string{
		"customer", "currency", "destination_country", "payment_method",
		"goods_amount", "quoted_freight", "quote_exchange_rate_cny",
		"actual_freight", "freight_profit", "gross_profit", "profit_margin", "profit_cny", "notes",
	} {
		if matrix.Columns[column] != "none" {
			t.Fatalf("column %q should be masked, got %q", column, matrix.Columns[column])
		}
	}
	if _, masked := matrix.Columns["order_no"]; masked {
		t.Fatal("business order number should remain visible")
	}
}

func TestTradeProfitColumnsAreManagerOnly(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.Sheet.CanView = true
	matrix.Sheet.CanEdit = true
	matrix.DefaultPermission = "read"
	access := &model.TradeOrderAccess{CanViewCustomerPricing: true, CanViewSupplierPricing: true, CanViewProfit: true}
	applyTradeSheetWriteScope(matrix, "订单总览", true)
	applyTradeSheetColumnScope(matrix, "订单总览", access)
	if matrix.Columns["additional_cost"] != "write" || matrix.Columns["additional_cost_notes"] != "write" {
		t.Fatal("manager should be able to maintain additional costs")
	}
	for _, column := range []string{
		"goods_amount", "quoted_freight", "quote_exchange_rate_cny", "sales_amount",
		"product_cost", "actual_freight", "freight_profit", "gross_profit", "profit_margin", "profit_cny",
	} {
		if matrix.Columns[column] == "write" || matrix.Columns[column] == "none" {
			t.Fatalf("computed profit column %q must remain readable but not writable", column)
		}
	}
}

func TestRedactTradeCustomerContact(t *testing.T) {
	accountID, channelID := int64(8), int64(9)
	customer := &model.TradeCustomer{
		Name: "Customer", ContactName: "Alice", Email: "alice@example.com", Phone: "123",
		WhatsAppAccountID: &accountID, WhatsAppChatID: "123@c.us", WhatsAppChatName: "Alice",
		ChannelID: &channelID, Tags: []string{"vip"}, Notes: "private",
	}
	redactTradeCustomerContact(customer)
	if customer.Name != "Customer" {
		t.Fatal("customer identity should remain available to operational roles")
	}
	if customer.ContactName != "" || customer.Email != "" || customer.Phone != "" || customer.ChannelID != nil || len(customer.Tags) != 0 {
		t.Fatal("customer contact and collaboration fields were not fully redacted")
	}
}

func TestApplyTradeSheetWriteScopeKeepsIdentityColumnsReadOnly(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.Sheet.CanView = true
	matrix.Sheet.CanEdit = true
	matrix.DefaultPermission = "read"
	applyTradeSheetWriteScope(matrix, "仓库到货", true)
	for _, column := range []string{"received_qty", "warehouse_location", "received_date", "receipt_status"} {
		if matrix.Columns[column] != "write" {
			t.Fatalf("column %q should be writable, got %q", column, matrix.Columns[column])
		}
	}
	for _, column := range []string{"line_no", "sku", "product_name", "expected_qty"} {
		if matrix.Columns[column] == "write" {
			t.Fatalf("identity column %q must remain read-only", column)
		}
	}
}

func TestRedactTradeWorkflowDataByStageScope(t *testing.T) {
	item := &model.TradeOrderItem{WorkflowData: map[string]any{
		"purchase_status": "已下单", "warehouse_location": "A-1", "inspection_issue": "scratch", "marks": "customer mark",
	}}
	redactTradeWorkflowData(item, &model.TradeOrderAccess{CanViewReceiving: true})
	if item.WorkflowData["warehouse_location"] != "A-1" {
		t.Fatal("receiving data should remain visible")
	}
	for _, key := range []string{"purchase_status", "inspection_issue", "marks"} {
		if _, exists := item.WorkflowData[key]; exists {
			t.Fatalf("workflow key %q should be redacted", key)
		}
	}
}
