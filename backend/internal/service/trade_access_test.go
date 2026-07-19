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
