package service

import (
	"database/sql"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
)

var tradeSettlementMonthPattern = regexp.MustCompile(`^(\d{4})\D?(\d{1,2})$`)

// normalizeSettlementMonth accepts 2026-11, 2026/11, 2026.11 or 202611 and
// returns 2026-11; empty stays empty.
func normalizeSettlementMonth(value string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", nil
	}
	match := tradeSettlementMonthPattern.FindStringSubmatch(value)
	if match == nil {
		return "", fmt.Errorf("账期月份格式应为 年-月，例如 2026-11")
	}
	year, _ := strconv.Atoi(match[1])
	month, _ := strconv.Atoi(match[2])
	if year < 2000 || year > 2200 || month < 1 || month > 12 {
		return "", fmt.Errorf("账期月份无效：%s", value)
	}
	return fmt.Sprintf("%04d-%02d", year, month), nil
}

// resolveSettlementMonth returns the explicit month when given, otherwise the
// cycle the deal date (or, for quotes, today) falls in.
func (s *TradeService) resolveSettlementMonth(explicit string, dealDate *time.Time, now time.Time) (string, error) {
	month, err := normalizeSettlementMonth(explicit)
	if err != nil || month != "" {
		return month, err
	}
	if dealDate != nil {
		return s.Modules().SettlementMonthFor(*dealDate), nil
	}
	return s.Modules().SettlementMonthFor(now), nil
}

// UpdateOrderDeal edits the deal date, settlement month and shipping address.
// The salesperson who owns the order, managers and admins may change them.
func (s *TradeService) UpdateOrderDeal(userID, orderID int64, request *model.UpdateTradeOrderDealRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("成交信息不能为空")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return nil, sql.ErrNoRows
	}
	if !access.profile.CanViewAllOrders && order.OwnerID != userID {
		return nil, fmt.Errorf("只有订单负责人、业务负责人或管理员可以修改成交日期和账期")
	}
	dealDate, err := parseTradeDate(request.DealDate)
	if err != nil {
		return nil, fmt.Errorf("成交日期格式无效")
	}
	month, err := s.resolveSettlementMonth(request.SettlementMonth, dealDate, order.InquiryDate)
	if err != nil {
		return nil, err
	}
	var address *string
	if request.ShippingAddress != nil {
		trimmed := strings.TrimSpace(*request.ShippingAddress)
		address = &trimmed
	}
	if err := s.repo.UpdateOrderDeal(orderID, dealDate, month, address); err != nil {
		return nil, err
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

// SetMonthExchangeRate applies the settlement rate (结汇汇率) of a month to its
// orders sold in one currency.
func (s *TradeService) SetMonthExchangeRate(userID int64, month string, request *model.SetMonthExchangeRateRequest) (int64, error) {
	if request == nil {
		return 0, fmt.Errorf("汇率不能为空")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return 0, err
	}
	if !access.profile.CanViewAllOrders {
		return 0, fmt.Errorf("仅管理员或业务负责人可以批量设置结汇汇率")
	}
	month, err = normalizeSettlementMonth(month)
	if err != nil {
		return 0, err
	}
	if month == "" {
		return 0, fmt.Errorf("请选择账期月份")
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if currency == "" {
		currency = "USD"
	}
	if currency == "CNY" {
		return 0, fmt.Errorf("人民币订单不需要汇率")
	}
	if request.Rate <= 0 {
		return 0, fmt.Errorf("请输入大于零的汇率")
	}
	return s.repo.SetMonthExchangeRate(month, currency, request.Rate, request.OnlyMissing)
}

// SettlementMonths lists the months holding orders the user can see.
func (s *TradeService) SettlementMonths(userID int64) ([]model.TradeSettlementMonth, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	return s.repo.SettlementMonths(userID, access.profile.CanViewAllOrders, tradeOrderScopeStages(access))
}
