package service

import (
	"errors"
	"fmt"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

func validateConfirmedTradeOrder(request *model.CreateTradeOrderRequest) error {
	if request.ExchangeRateCNY < 0 {
		return fmt.Errorf("汇率不能小于零")
	}
	for index, item := range request.Items {
		if item.SalesPrice < 0 || item.PurchasePrice < 0 {
			return fmt.Errorf("第 %d 行价格不能小于零", index+1)
		}
	}
	return nil
}

func normalizeTradeOrderRate(currency string, rate float64) float64 {
	if strings.EqualFold(currency, "CNY") {
		return 1
	}
	return nonNegativeTradeValue(rate)
}

// applyTradeItemPricing writes the selling price and, when withCost is set,
// the purchase cost. Entering a supplier and cost marks the line as ordered
// unless a purchase status was already recorded.
func applyTradeItemPricing(item *model.TradeOrderItem, salesPrice float64, supplier, purchaseCurrency string, purchasePrice float64, withCost bool, orderStage string) {
	item.QuotedPrice = nonNegativeTradeValue(salesPrice)
	if !withCost {
		return
	}
	item.SupplierName = strings.TrimSpace(supplier)
	item.PurchasePrice = nonNegativeTradeValue(purchasePrice)
	item.PurchaseCurrency = strings.ToUpper(strings.TrimSpace(purchaseCurrency))
	if item.PurchaseCurrency == "" {
		item.PurchaseCurrency = "CNY"
	}
	if item.SupplierName != "" && item.PurchasePrice > 0 && tradeWorkflowString(item, "purchase_status") == "" {
		setTradeWorkflowValue(item, "purchase_status", "已下单")
		if !tradeStageAtOrAfter(orderStage, model.TradeStageReceiving) {
			item.Status = "已下单"
		}
	}
}

func (s *TradeService) finishConfirmedOrder(userID int64, order *model.TradeOrder, request *model.CreateTradeOrderRequest, withCost bool) (*model.TradeOrder, error) {
	items, err := s.repo.ListOrderItems(order.ID)
	if err != nil {
		return nil, err
	}
	if len(items) != len(request.Items) {
		return nil, fmt.Errorf("产品行数与录入内容不一致，请刷新后检查订单 %s", order.OrderNo)
	}
	for index := range items {
		input := request.Items[index]
		item := &items[index]
		item.Status = "客户确认"
		applyTradeItemPricing(item, input.SalesPrice, input.SupplierName, input.PurchaseCurrency, input.PurchasePrice, withCost, model.TradeStageInquiry)
		if err := s.repo.SaveOrderItem(item); err != nil {
			return nil, err
		}
	}
	if err := s.repo.UpdateOrderCurrencyRate(order.ID, order.Currency, normalizeTradeOrderRate(order.Currency, request.ExchangeRateCNY)); err != nil {
		return nil, err
	}
	if err := s.repo.RecalculateOrderTotal(order.ID); err != nil {
		return nil, err
	}
	start := confirmedOrderStartStage(s.Modules())
	note := "录入成交订单：客户已确认并付款"
	if err := s.repo.AdvanceOrder(order.ID, userID, true, model.TradeStageInquiry, start, note); err != nil {
		return nil, err
	}
	if order.ChannelID != nil {
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:      fmt.Sprintf("已录入成交订单 %s：%s。当前阶段：%s。", order.OrderNo, order.Title, tradeStageLabel(start)),
			InternalOnly: true,
		})
	}
	if start != model.TradeStageCompleted {
		s.notifyStageAssignees(order, start, "新的成交订单待处理")
	}
	s.notifyOrderUpdated(order.ID)
	return s.GetOrder(userID, order.ID)
}

// UpdateOrderPricing edits the products, selling prices, costs and exchange
// rate of an order in one step, at any stage before it is cancelled.
func (s *TradeService) UpdateOrderPricing(userID, orderID int64, request *model.UpdateTradeOrderPricingRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("售价与成本不能为空")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewAllOrders {
		return nil, fmt.Errorf("仅管理员或业务负责人可以维护售价与成本")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	if order.Stage == model.TradeStageCancelled {
		return nil, fmt.Errorf("已取消的业务单不能修改售价与成本")
	}
	if request.ExchangeRateCNY < 0 {
		return nil, fmt.Errorf("汇率不能小于零")
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if currency == "" {
		currency = strings.ToUpper(firstNonEmptyTrade(order.Currency, "USD"))
	}

	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	existing := make(map[int64]*model.TradeOrderItem, len(items))
	for index := range items {
		existing[items[index].ID] = &items[index]
	}
	removed := make(map[int64]bool, len(request.RemovedItemIDs))
	for _, id := range request.RemovedItemIDs {
		item := existing[id]
		if item == nil {
			return nil, fmt.Errorf("要删除的产品不属于当前业务单")
		}
		if item.ReceivedQuantity > 0 || item.PackedQuantity > 0 {
			return nil, fmt.Errorf("第 %d 行已登记到货或装箱，不能删除", item.LineNo)
		}
		removed[id] = true
	}
	updates := make(map[int64]model.TradeOrderPricingItem, len(request.Items))
	newInputs := make([]model.TradeOrderPricingItem, 0)
	newRequests := make([]model.CreateTradeOrderItemRequest, 0)
	for index, input := range request.Items {
		if input.Quantity <= 0 {
			return nil, fmt.Errorf("第 %d 行数量必须大于零", index+1)
		}
		if input.SalesPrice < 0 || input.PurchasePrice < 0 {
			return nil, fmt.Errorf("第 %d 行价格不能小于零", index+1)
		}
		if _, _, err := normalizeTradeItemIdentity(input.SKU, input.ProductName); err != nil {
			return nil, fmt.Errorf("第 %d 行：%w", index+1, err)
		}
		if input.OrderItemID == 0 {
			newInputs = append(newInputs, input)
			newRequests = append(newRequests, model.CreateTradeOrderItemRequest{
				SKU: input.SKU, ProductName: input.ProductName, Specification: input.Specification,
				Quantity: input.Quantity, Unit: input.Unit,
			})
			continue
		}
		if existing[input.OrderItemID] == nil || removed[input.OrderItemID] {
			return nil, fmt.Errorf("第 %d 行产品不属于当前业务单", index+1)
		}
		updates[input.OrderItemID] = input
	}

	// New lines go in first so removing lines never empties the order.
	if len(newRequests) > 0 {
		added, err := buildTradeOrderItems(newRequests)
		if err != nil {
			return nil, err
		}
		if err := s.repo.AddOrderItems(orderID, added); err != nil {
			return nil, err
		}
		for index := range added {
			updates[added[index].ID] = newInputs[index]
		}
	}
	for id := range removed {
		if err := s.repo.DeleteOrderItem(orderID, id); err != nil {
			if errors.Is(err, repo.ErrLastTradeOrderItem) {
				return nil, fmt.Errorf("订单至少需要保留一个产品")
			}
			return nil, err
		}
	}
	// Deleting renumbers lines, and lines are saved by number: reload first.
	items, err = s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	for index := range items {
		item := &items[index]
		input, ok := updates[item.ID]
		if !ok {
			continue
		}
		sku, productName, _ := normalizeTradeItemIdentity(input.SKU, input.ProductName)
		item.SKU, item.ProductName = sku, productName
		item.Specification = strings.TrimSpace(input.Specification)
		item.Quantity = input.Quantity
		item.Unit = firstNonEmptyTrade(strings.TrimSpace(input.Unit), item.Unit, "件")
		if item.Status == "" || item.Status == "pending" {
			item.Status = "客户确认"
		}
		applyTradeItemPricing(item, input.SalesPrice, input.SupplierName, input.PurchaseCurrency, input.PurchasePrice, true, order.Stage)
		if err := s.repo.SaveOrderItem(item); err != nil {
			return nil, err
		}
	}
	if err := s.repo.UpdateOrderCurrencyRate(orderID, currency, normalizeTradeOrderRate(currency, request.ExchangeRateCNY)); err != nil {
		return nil, err
	}
	if err := s.repo.RecalculateOrderTotal(orderID); err != nil {
		return nil, err
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}
