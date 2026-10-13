package service

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"yaerp/internal/model"
)

const (
	tradeItemUnavailableKey       = "supplier_unavailable"
	tradeItemUnavailableReasonKey = "supplier_unavailable_reason"
	tradeItemUnavailableAtKey     = "supplier_unavailable_at"
)

// tradeItemUnavailable reports an item no supplier can provide. Such items
// stay on the order for the record but are skipped by pricing, profit and the
// later workflow stages.
func tradeItemUnavailable(item *model.TradeOrderItem) bool {
	if item == nil || item.WorkflowData == nil {
		return false
	}
	value, _ := item.WorkflowData[tradeItemUnavailableKey].(bool)
	return value
}

const tradeItemDeclinedKey = "customer_declined"

// tradeItemDeclined reports an item that was quoted but which the customer
// chose not to buy when accepting the quote.
func tradeItemDeclined(item *model.TradeOrderItem) bool {
	if item == nil || item.WorkflowData == nil {
		return false
	}
	value, _ := item.WorkflowData[tradeItemDeclinedKey].(bool)
	return value
}

// tradeItemExcluded items take no further part in purchasing, receiving,
// inspection, packing, shipment and profit.
func tradeItemExcluded(item *model.TradeOrderItem) bool {
	return tradeItemUnavailable(item) || tradeItemDeclined(item)
}

func tradeActiveItems(items []model.TradeOrderItem) []model.TradeOrderItem {
	active := make([]model.TradeOrderItem, 0, len(items))
	for index := range items {
		if !tradeItemExcluded(&items[index]) {
			active = append(active, items[index])
		}
	}
	return active
}

func tradeAvailableItems(items []model.TradeOrderItem) []model.TradeOrderItem {
	available := make([]model.TradeOrderItem, 0, len(items))
	for index := range items {
		if !tradeItemUnavailable(&items[index]) {
			available = append(available, items[index])
		}
	}
	return available
}

func setTradeItemAvailability(item *model.TradeOrderItem, unavailable bool, reason string) {
	if !unavailable {
		if item.WorkflowData != nil {
			delete(item.WorkflowData, tradeItemUnavailableKey)
			delete(item.WorkflowData, tradeItemUnavailableReasonKey)
			delete(item.WorkflowData, tradeItemUnavailableAtKey)
		}
		return
	}
	setTradeWorkflowValue(item, tradeItemUnavailableKey, true)
	setTradeWorkflowValue(item, tradeItemUnavailableReasonKey, strings.TrimSpace(reason))
	setTradeWorkflowValue(item, tradeItemUnavailableAtKey, time.Now().UTC().Format(time.RFC3339))
}

// SaveSupplierQuotes stores the quote entry dialog in one call: quotes whose
// supplier is given by ID or by name (unknown names create the supplier), and
// items marked as impossible to quote. Everything is validated before any
// write, so a bad row leaves the order untouched.
func (s *TradeService) SaveSupplierQuotes(userID, orderID int64, request *model.SaveTradeSupplierQuotesRequest) (*model.SaveTradeSupplierQuotesResult, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageSupplierQuote)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("只有供应商询价岗位或业务负责人可以录入供应商报价")
	}
	if order.Stage != model.TradeStageSupplierQuote {
		return nil, fmt.Errorf("当前业务单不在供应商询价阶段")
	}
	if request == nil || (len(request.Quotes) == 0 && len(request.Availability) == 0) {
		return nil, fmt.Errorf("请至少填写一条供应商报价或标记一项无法报价")
	}

	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	itemByID := make(map[int64]*model.TradeOrderItem, len(items))
	for index := range items {
		itemByID[items[index].ID] = &items[index]
	}

	unavailable := make(map[int64]bool, len(items))
	for index := range items {
		unavailable[items[index].ID] = tradeItemUnavailable(&items[index])
	}
	changed := make([]*model.TradeOrderItem, 0, len(request.Availability))
	for _, input := range request.Availability {
		item := itemByID[input.OrderItemID]
		if item == nil {
			return nil, fmt.Errorf("标记无法报价的产品不属于该业务单")
		}
		if len([]rune(strings.TrimSpace(input.Reason))) > 200 {
			return nil, fmt.Errorf("产品 %s 的无法报价原因不能超过 200 字", firstNonEmptyTrade(item.SKU, item.ProductName))
		}
		if unavailable[item.ID] == input.Unavailable &&
			(!input.Unavailable || tradeWorkflowString(item, tradeItemUnavailableReasonKey) == strings.TrimSpace(input.Reason)) {
			continue
		}
		unavailable[item.ID] = input.Unavailable
		setTradeItemAvailability(item, input.Unavailable, input.Reason)
		changed = append(changed, item)
	}

	type pendingQuote struct {
		request    model.UpsertTradeSupplierQuoteRequest
		validUntil *time.Time
		newName    string
	}
	pending := make([]pendingQuote, 0, len(request.Quotes))
	known := make(map[string]*model.TradeSupplier)
	toCreate := make(map[string]string)
	createOrder := make([]string, 0)
	for index, entry := range request.Quotes {
		row := index + 1
		item := itemByID[entry.OrderItemID]
		if item == nil {
			return nil, fmt.Errorf("第 %d 条报价的产品不属于该业务单", row)
		}
		if unavailable[item.ID] {
			return nil, fmt.Errorf("第 %d 条报价的产品 %s 已标记为无法报价", row, firstNonEmptyTrade(item.SKU, item.ProductName))
		}
		if entry.UnitPrice <= 0 {
			return nil, fmt.Errorf("第 %d 条报价的单价必须大于零", row)
		}
		if entry.MOQ < 0 || entry.LeadTimeDays < 0 {
			return nil, fmt.Errorf("第 %d 条报价的 MOQ 或交期不能小于零", row)
		}
		validUntil, err := parseTradeDate(entry.ValidUntil)
		if err != nil {
			return nil, fmt.Errorf("第 %d 条报价有效期格式无效", row)
		}
		quote := pendingQuote{
			request: model.UpsertTradeSupplierQuoteRequest{
				OrderItemID: entry.OrderItemID, SupplierID: entry.SupplierID,
				Currency: strings.ToUpper(strings.TrimSpace(entry.Currency)), UnitPrice: entry.UnitPrice,
				MOQ: entry.MOQ, LeadTimeDays: entry.LeadTimeDays, Notes: strings.TrimSpace(entry.Notes),
			},
			validUntil: validUntil,
		}
		var supplier *model.TradeSupplier
		if entry.SupplierID > 0 {
			supplier, err = s.repo.GetSupplier(entry.SupplierID)
			if err != nil {
				return nil, fmt.Errorf("第 %d 条报价的供应商不存在", row)
			}
		} else {
			name := strings.TrimSpace(entry.SupplierName)
			if name == "" {
				return nil, fmt.Errorf("第 %d 条报价请填写供应商", row)
			}
			if len([]rune(name)) > 128 {
				return nil, fmt.Errorf("第 %d 条报价的供应商名称过长", row)
			}
			key := strings.ToLower(name)
			if cached, ok := known[key]; ok {
				supplier = cached
			} else if _, waiting := toCreate[key]; !waiting {
				found, err := s.repo.FindSupplierByName(name)
				switch {
				case err == nil:
					known[key] = found
					supplier = found
				case errors.Is(err, sql.ErrNoRows):
					toCreate[key] = name
					createOrder = append(createOrder, key)
				default:
					return nil, err
				}
			}
			if supplier == nil {
				quote.newName = key
			}
		}
		if supplier != nil {
			quote.request.SupplierID = supplier.ID
			if quote.request.Currency == "" {
				quote.request.Currency = defaultTradeSupplierQuoteCurrency(supplier)
			}
		}
		if quote.request.Currency == "" {
			quote.request.Currency = "CNY"
		}
		pending = append(pending, quote)
	}

	created := make([]model.TradeSupplier, 0, len(createOrder))
	if len(createOrder) > 0 {
		access, err := s.loadTradeUserAccess(userID)
		if err != nil {
			return nil, err
		}
		if !access.profile.CanManageSuppliers {
			return nil, fmt.Errorf("供应商「%s」不存在，当前岗位没有新增供应商的权限", toCreate[createOrder[0]])
		}
		currencies := make(map[string]string, len(createOrder))
		for _, quote := range pending {
			if quote.newName != "" && currencies[quote.newName] == "" {
				currencies[quote.newName] = quote.request.Currency
			}
		}
		for _, key := range createOrder {
			supplier := &model.TradeSupplier{
				OwnerID: userID, Name: toCreate[key], CompanyName: toCreate[key],
				DefaultCurrency: firstNonEmptyTrade(currencies[key], "CNY"), Status: "active",
				Notes: fmt.Sprintf("录入 %s 供应商报价时自动新增", order.OrderNo),
			}
			if err := s.repo.CreateSupplier(userID, supplier); err != nil {
				return nil, fmt.Errorf("新增供应商「%s」失败: %w", toCreate[key], err)
			}
			known[key] = supplier
			created = append(created, *supplier)
		}
	}

	if len(pending) > 0 {
		requests := make([]model.UpsertTradeSupplierQuoteRequest, len(pending))
		validUntils := make([]*time.Time, len(pending))
		for index, quote := range pending {
			if quote.newName != "" {
				quote.request.SupplierID = known[quote.newName].ID
			}
			requests[index] = quote.request
			validUntils[index] = quote.validUntil
		}
		if err := s.repo.CreateSupplierQuotes(orderID, userID, requests, validUntils); err != nil {
			return nil, err
		}
	}
	for _, item := range changed {
		if err := s.repo.SaveOrderItem(item); err != nil {
			return nil, err
		}
	}

	s.notifyOrderUpdated(orderID)
	updated, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, err
	}
	unavailableCount := 0
	for _, value := range unavailable {
		if value {
			unavailableCount++
		}
	}
	return &model.SaveTradeSupplierQuotesResult{
		Order: updated, SavedQuotes: len(pending), CreatedSuppliers: created, UnavailableItems: unavailableCount,
	}, nil
}
