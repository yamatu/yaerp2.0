package service

import (
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
)

var ErrTradeBossDenied = errors.New("仅管理员或业务负责人可以查看老板面板")

const (
	tradeBossPeriodMonth = "month"
	tradeBossPeriodYear  = "year"
	tradeBossRankLimit   = 10
	tradeBossOrderLimit  = 500
)

// BossReport is the boss panel for a month (period "month") or a year
// (period "year"). Orders count in the period they were completed in.
func (s *TradeService) BossReport(userID int64, period string, year, month int) (*model.TradeBossReport, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewAllOrders {
		return nil, ErrTradeBossDenied
	}
	orders, err := s.repo.ListOrdersForProfit()
	if err != nil {
		return nil, err
	}
	items, err := s.repo.ListAllOrderItems()
	if err != nil {
		return nil, err
	}
	parcels, err := s.repo.ListParcelOrderIDs()
	if err != nil {
		return nil, err
	}
	for index := range orders {
		if parcels[orders[index].ID] {
			// Only presence matters to the profit rules (parcel freight is a cost).
			orders[index].Parcels = []model.TradeParcel{{ParcelNo: 1}}
		}
	}
	return buildTradeBossReport(orders, items, period, year, month, time.Now(), s.Modules())
}

// tradeBossRange is the period being reported: deal dates in [start, end)
// and settlement months starting with monthPrefix ("2026-11" or "2026-").
type tradeBossRange struct {
	start, end  time.Time
	label       string
	monthPrefix string
}

func (r tradeBossRange) holds(settlementMonth string) bool {
	return settlementMonth != "" && strings.HasPrefix(settlementMonth, r.monthPrefix)
}

func tradeBossRanges(period string, year, month int, now time.Time, modules model.TradeModules) (string, tradeBossRange, tradeBossRange, error) {
	location := now.Location()
	if period == "" {
		period = tradeBossPeriodMonth
	}
	if year == 0 {
		year = now.Year()
	}
	if year < 2000 || year > 2200 {
		return "", tradeBossRange{}, tradeBossRange{}, fmt.Errorf("年份无效")
	}
	switch period {
	case tradeBossPeriodMonth:
		if month == 0 {
			month = int(now.Month())
		}
		if month < 1 || month > 12 {
			return "", tradeBossRange{}, tradeBossRange{}, fmt.Errorf("月份无效")
		}
		monthRange := func(first time.Time) tradeBossRange {
			start, end := modules.SettlementRange(first.Year(), first.Month(), location)
			return tradeBossRange{start: start, end: end, label: first.Format("2006年1月"), monthPrefix: first.Format("2006-01")}
		}
		first := time.Date(year, time.Month(month), 1, 0, 0, 0, 0, location)
		return period, monthRange(first), monthRange(first.AddDate(0, -1, 0)), nil
	case tradeBossPeriodYear:
		yearRange := func(year int) tradeBossRange {
			start, _ := modules.SettlementRange(year, time.January, location)
			end, _ := modules.SettlementRange(year+1, time.January, location)
			return tradeBossRange{start: start, end: end, label: fmt.Sprintf("%d年", year), monthPrefix: fmt.Sprintf("%04d-", year)}
		}
		return period, yearRange(year), yearRange(year - 1), nil
	default:
		return "", tradeBossRange{}, tradeBossRange{}, fmt.Errorf("报表周期只能是 month 或 year")
	}
}

func tradeOrderCompletedAt(order *model.TradeOrder) time.Time {
	if !order.StageUpdatedAt.IsZero() {
		return order.StageUpdatedAt
	}
	return order.UpdatedAt
}

// tradeOrderPeriodDate is the day an order counts on: its deal date, or for
// older orders without one, when it was completed.
func tradeOrderPeriodDate(order *model.TradeOrder) time.Time {
	if order.DealDate != nil {
		return *order.DealDate
	}
	return tradeOrderCompletedAt(order)
}

func tradeOrderSettlementMonth(order *model.TradeOrder, modules model.TradeModules, location *time.Location) string {
	if order.SettlementMonth != "" {
		return order.SettlementMonth
	}
	return modules.SettlementMonthFor(tradeOrderPeriodDate(order).In(location))
}

func buildTradeBossReport(
	orders []model.TradeOrder,
	items []model.TradeOrderItem,
	period string,
	year, month int,
	now time.Time,
	modules model.TradeModules,
) (*model.TradeBossReport, error) {
	period, current, previous, err := tradeBossRanges(period, year, month, now, modules)
	if err != nil {
		return nil, err
	}
	location := now.Location()
	itemsByOrder := make(map[int64][]model.TradeOrderItem)
	for _, item := range items {
		itemsByOrder[item.OrderID] = append(itemsByOrder[item.OrderID], item)
	}
	report := &model.TradeBossReport{
		Period: period, Year: current.start.Year(), Label: current.label, PreviousLabel: previous.label,
		StartDate:      current.start.Format("2006-01-02"),
		EndDate:        current.end.AddDate(0, 0, -1).Format("2006-01-02"),
		Trend:          tradeBossTrendBuckets(period, current),
		Customers:      []model.TradeBossBreakdown{},
		Owners:         []model.TradeBossBreakdown{},
		Products:       []model.TradeBossBreakdown{},
		Currencies:     []model.TradeBossCurrencySummary{},
		Orders:         []model.TradeBossOrderSummary{},
		TotalOrders:    int64(len(orders)),
		AvailableYears: []int{},
	}
	if period == tradeBossPeriodMonth {
		report.Month = int(current.start.Month())
	}
	years := map[int]bool{now.Year(): true}
	customers := map[string]*model.TradeBossBreakdown{}
	owners := map[string]*model.TradeBossBreakdown{}
	products := map[string]*model.TradeBossBreakdown{}
	currencies := map[string]*model.TradeBossCurrencySummary{}

	for index := range orders {
		order := &orders[index]
		if order.Stage == model.TradeStageCancelled {
			continue
		}
		profit := buildTradeProfitSummary(order, itemsByOrder[order.ID])
		completed := order.Stage == model.TradeStageCompleted
		if !completed {
			report.ActiveOrders++
			report.ActiveRevenueCNY += profit.RevenueCNY
		}
		if !completed && order.DealDate == nil {
			continue
		}
		periodDate := tradeOrderPeriodDate(order).In(location)
		settlementMonth := tradeOrderSettlementMonth(order, modules, location)
		if len(settlementMonth) >= 4 {
			if year, err := strconv.Atoi(settlementMonth[:4]); err == nil {
				years[year] = true
			}
		}
		inCurrent := current.holds(settlementMonth)
		if previous.holds(settlementMonth) {
			addTradeBossSale(&report.Previous, profit)
			if completed {
				addTradeBossOrder(&report.Previous, profit)
			}
		}
		if !inCurrent {
			continue
		}
		bucket := &report.Trend[tradeBossTrendIndex(period, current, settlementMonth, periodDate, len(report.Trend))]
		addTradeBossSale(&report.Summary, profit)
		bucket.SalesOrders++
		if profit.ExchangeRateCNY > 0 {
			bucket.SalesRevenueCNY += profit.RevenueCNY
		}
		if !completed {
			continue
		}
		addTradeBossOrder(&report.Summary, profit)
		bucket.CompletedOrders++
		currency := strings.ToUpper(firstNonEmptyTrade(profit.Currency, "未设置"))
		if len(report.Orders) < tradeBossOrderLimit {
			summary := tradeBossOrderSummary(order, profit, currency, periodDate)
			summary.TrendKey = bucket.Key
			report.Orders = append(report.Orders, summary)
		}
		if !profit.Finalized {
			continue
		}
		bucket.FinalizedOrders++
		bucket.RevenueCNY += profit.RevenueCNY
		bucket.TotalCostCNY += profit.TotalCostCNY
		bucket.ProfitAmountCNY += profit.ProfitAmountCNY

		addTradeBossBreakdown(customers, firstNonEmptyTrade(order.CustomerName, "未命名客户"), 1, 0, profit.RevenueCNY, profit.TotalCostCNY)
		addTradeBossBreakdown(owners, firstNonEmptyTrade(order.OwnerName, "未分配"), 1, 0, profit.RevenueCNY, profit.TotalCostCNY)
		counted := map[string]bool{}
		for _, line := range profit.Lines {
			sku := strings.TrimSpace(firstNonEmptyTrade(line.SKU, line.ProductName))
			if sku == "" {
				continue
			}
			var orderCount int64
			if key := strings.ToUpper(sku); !counted[key] {
				counted[key] = true
				orderCount = 1
			}
			addTradeBossBreakdown(products, sku, orderCount, line.Quantity,
				line.Revenue*profit.ExchangeRateCNY, line.PurchaseCost*profit.ExchangeRateCNY)
		}
		summary := currencies[currency]
		if summary == nil {
			summary = &model.TradeBossCurrencySummary{Currency: currency}
			currencies[currency] = summary
		}
		summary.OrderCount++
		summary.Revenue += profit.Revenue
		summary.GoodsRevenue += profit.GoodsRevenue
		summary.FreightRevenue += profit.FreightRevenue
		summary.ProductCost += profit.ProductCost
		summary.ActualFreightCost += profit.ActualFreightCost
		summary.AdditionalCost += profit.AdditionalCost
		summary.TotalCost += profit.TotalCost
		summary.FreightProfit += profit.FreightProfit
		summary.ProfitAmount += profit.ProfitAmount
	}

	finishTradeBossSummary(&report.Summary)
	finishTradeBossSummary(&report.Previous)
	for index := range report.Trend {
		point := &report.Trend[index]
		if point.RevenueCNY != 0 {
			point.ProfitMargin = point.ProfitAmountCNY / point.RevenueCNY * 100
		}
	}
	report.Customers = rankTradeBossBreakdown(customers)
	report.Owners = rankTradeBossBreakdown(owners)
	report.Products = rankTradeBossBreakdown(products)
	for _, summary := range currencies {
		if summary.Revenue != 0 {
			summary.ProfitMargin = summary.ProfitAmount / summary.Revenue * 100
		}
		report.Currencies = append(report.Currencies, *summary)
	}
	sort.Slice(report.Currencies, func(a, b int) bool { return report.Currencies[a].Currency < report.Currencies[b].Currency })
	sort.Slice(report.Orders, func(a, b int) bool { return report.Orders[a].CompletedAt.After(report.Orders[b].CompletedAt) })
	for candidate := range years {
		report.AvailableYears = append(report.AvailableYears, candidate)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(report.AvailableYears)))
	return report, nil
}

func tradeBossTrendBuckets(period string, current tradeBossRange) []model.TradeBossTrendPoint {
	if period == tradeBossPeriodYear {
		points := make([]model.TradeBossTrendPoint, 12)
		for index := range points {
			month := current.start.AddDate(0, index, 0)
			points[index] = model.TradeBossTrendPoint{Key: month.Format("2006-01"), Label: fmt.Sprintf("%d月", index+1)}
		}
		return points
	}
	points := make([]model.TradeBossTrendPoint, 0, 31)
	for day := current.start; day.Before(current.end); day = day.AddDate(0, 0, 1) {
		label := fmt.Sprintf("%d日", day.Day())
		if current.start.Day() != 1 {
			label = fmt.Sprintf("%d/%d", int(day.Month()), day.Day())
		}
		points = append(points, model.TradeBossTrendPoint{Key: day.Format("2006-01-02"), Label: label})
	}
	return points
}

// tradeBossTrendIndex picks the month of a yearly report or the day of a
// monthly one; a deal moved into another cycle by hand lands on its edge.
func tradeBossTrendIndex(period string, current tradeBossRange, settlementMonth string, date time.Time, buckets int) int {
	index := 0
	if period == tradeBossPeriodYear {
		if len(settlementMonth) >= 7 {
			month, _ := strconv.Atoi(settlementMonth[5:7])
			index = month - 1
		}
	} else {
		day := time.Date(date.Year(), date.Month(), date.Day(), 0, 0, 0, 0, current.start.Location())
		index = int(day.Sub(current.start).Hours() / 24)
	}
	return min(max(index, 0), buckets-1)
}

func addTradeBossSale(summary *model.TradeBossPeriodSummary, profit *model.TradeProfitSummary) {
	summary.SalesOrders++
	if profit.ExchangeRateCNY > 0 {
		summary.SalesRevenueCNY += profit.RevenueCNY
	} else {
		summary.SalesMissingRateOrders++
	}
}

func addTradeBossOrder(summary *model.TradeBossPeriodSummary, profit *model.TradeProfitSummary) {
	summary.CompletedOrders++
	if !profit.Finalized {
		summary.IncompleteOrders++
		return
	}
	rate := profit.ExchangeRateCNY
	summary.FinalizedOrders++
	summary.RevenueCNY += profit.RevenueCNY
	summary.GoodsRevenueCNY += profit.GoodsRevenue * rate
	summary.FreightRevenueCNY += profit.FreightRevenueCNY
	summary.FeeRevenueCNY += profit.FeeRevenue * rate
	summary.ProductCostCNY += profit.ProductCost * rate
	summary.FreightCostCNY += profit.FreightCostCNY
	summary.AdditionalCostCNY += profit.AdditionalCost * rate
	summary.TotalCostCNY += profit.TotalCostCNY
	summary.ProfitAmountCNY += profit.ProfitAmountCNY
	switch {
	case profit.ProfitAmountCNY > 0:
		summary.ProfitableOrders++
	case profit.ProfitAmountCNY < 0:
		summary.LossOrders++
	}
}

func finishTradeBossSummary(summary *model.TradeBossPeriodSummary) {
	if summary.RevenueCNY != 0 {
		summary.ProfitMargin = summary.ProfitAmountCNY / summary.RevenueCNY * 100
	}
	if summary.FinalizedOrders > 0 {
		summary.AverageProfitCNY = summary.ProfitAmountCNY / float64(summary.FinalizedOrders)
	}
}

func addTradeBossBreakdown(entries map[string]*model.TradeBossBreakdown, label string, orders int64, quantity, revenue, cost float64) {
	key := strings.ToUpper(strings.TrimSpace(label))
	entry := entries[key]
	if entry == nil {
		entry = &model.TradeBossBreakdown{Key: key, Label: strings.TrimSpace(label)}
		entries[key] = entry
	}
	entry.Orders += orders
	entry.Quantity += quantity
	entry.RevenueCNY += revenue
	entry.CostCNY += cost
	entry.ProfitAmountCNY += revenue - cost
}

func rankTradeBossBreakdown(entries map[string]*model.TradeBossBreakdown) []model.TradeBossBreakdown {
	result := make([]model.TradeBossBreakdown, 0, len(entries))
	for _, entry := range entries {
		if entry.RevenueCNY != 0 {
			entry.ProfitMargin = entry.ProfitAmountCNY / entry.RevenueCNY * 100
		}
		result = append(result, *entry)
	}
	sort.Slice(result, func(a, b int) bool {
		if result[a].ProfitAmountCNY != result[b].ProfitAmountCNY {
			return result[a].ProfitAmountCNY > result[b].ProfitAmountCNY
		}
		return result[a].Label < result[b].Label
	})
	if len(result) > tradeBossRankLimit {
		result = result[:tradeBossRankLimit]
	}
	return result
}

func tradeBossOrderSummary(order *model.TradeOrder, profit *model.TradeProfitSummary, currency string, completedAt time.Time) model.TradeBossOrderSummary {
	return model.TradeBossOrderSummary{
		ID: order.ID, OrderNo: order.OrderNo, Title: order.Title,
		CustomerName: order.CustomerName, OwnerName: order.OwnerName, Stage: order.Stage,
		Currency: currency, Revenue: profit.Revenue, GoodsRevenue: profit.GoodsRevenue,
		FreightRevenue: profit.FreightRevenue, TotalCost: profit.TotalCost,
		ActualFreightCost: profit.ActualFreightCost, FreightProfit: profit.FreightProfit,
		ProfitAmount: profit.ProfitAmount, ProfitMargin: profit.ProfitMargin,
		RevenueCNY: profit.RevenueCNY, TotalCostCNY: profit.TotalCostCNY,
		ProfitAmountCNY: profit.ProfitAmountCNY, FreightProfitCNY: profit.FreightProfitCNY,
		CostComplete: profit.CostComplete, CNYComplete: profit.CNYComplete,
		Finalized: profit.Finalized, Warnings: profit.Warnings,
		CompletedAt: completedAt, UpdatedAt: order.UpdatedAt,
	}
}
