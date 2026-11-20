package service

import (
	"fmt"
	"sort"
	"strings"
	"time"

	"yaerp/internal/model"
)

const tradeParcelShipped = "已发货"

// UpdateParcels replaces the parcels an order ships as. The shipment stage's
// position edits them while shipping; full users may also fix them later.
func (s *TradeService) UpdateParcels(userID, orderID int64, request *model.UpdateTradeParcelsRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("发货包裹不能为空")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	if order.Stage == model.TradeStageCancelled {
		return nil, fmt.Errorf("已取消的业务单不能修改发货资料")
	}
	allowed := access.profile.CanViewAllOrders && tradeStageAtOrAfter(order.Stage, model.TradeStagePacking)
	if !allowed && order.Stage == model.TradeStageShipment {
		allowed, _, err = s.canOperateStageForStage(userID, order, model.TradeStageShipment)
		if err != nil {
			return nil, err
		}
	}
	if !allowed {
		return nil, fmt.Errorf("只有发货环节负责人或业务负责人可以维护发货包裹")
	}
	groups, err := s.repo.ListPackingGroups(orderID)
	if err != nil {
		return nil, err
	}
	// Freight is hidden from users who may not see cost; their saves keep
	// what a manager entered.
	if !access.profile.CanViewAllOrders {
		existing, err := s.repo.ListParcels(orderID)
		if err != nil {
			return nil, err
		}
		byID := make(map[int64]model.TradeParcel, len(existing))
		for _, parcel := range existing {
			byID[parcel.ID] = parcel
		}
		for index := range request.Parcels {
			input := &request.Parcels[index]
			previous, ok := byID[input.ID]
			input.ActualFreightCurrency, input.ActualFreightAmount, input.ActualFreightToCNYRate = "CNY", 0, 1
			if ok {
				input.ActualFreightCurrency = previous.ActualFreightCurrency
				input.ActualFreightAmount = previous.ActualFreightAmount
				input.ActualFreightToCNYRate = previous.ActualFreightToCNYRate
			}
		}
	}
	parcels, err := buildTradeParcels(request.Parcels, groups)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ReplaceParcels(orderID, parcels, tradeParcelSummary(parcels)); err != nil {
		return nil, err
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

// buildTradeParcels validates the input: boxes must exist and no packing
// group may ship more boxes than were packed.
func buildTradeParcels(inputs []model.TradeParcelInput, groups []model.TradePackingGroup) ([]model.TradeParcel, error) {
	available := make(map[int]int, len(groups))
	for _, group := range groups {
		available[group.GroupNo] = group.Copies
	}
	assigned := make(map[int]int)
	parcels := make([]model.TradeParcel, 0, len(inputs))
	for index, input := range inputs {
		label := fmt.Sprintf("包裹 %d", index+1)
		parcel := model.TradeParcel{
			ParcelNo:               index + 1,
			Carrier:                strings.TrimSpace(input.Carrier),
			TrackingNo:             strings.TrimSpace(input.TrackingNo),
			ShippingStatus:         normalizeTradeShippingStatus(input.ShippingStatus),
			ActualFreightCurrency:  strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(input.ActualFreightCurrency), "CNY")),
			ActualFreightAmount:    nonNegativeTradeValue(input.ActualFreightAmount),
			ActualFreightToCNYRate: nonNegativeTradeValue(input.ActualFreightToCNYRate),
			Notes:                  strings.TrimSpace(input.Notes),
			Boxes:                  []model.TradeParcelBox{},
		}
		if input.ActualFreightAmount < 0 {
			return nil, fmt.Errorf("%s的运费不能小于零", label)
		}
		if parcel.ActualFreightCurrency == "CNY" {
			parcel.ActualFreightToCNYRate = 1
		} else if parcel.ActualFreightAmount > 0 && parcel.ActualFreightToCNYRate <= 0 {
			return nil, fmt.Errorf("%s的运费是 %s，请填写兑人民币汇率", label, parcel.ActualFreightCurrency)
		}
		shipDate, err := parseTradeDate(input.ShipDate)
		if err != nil {
			return nil, fmt.Errorf("%s的发货日期格式无效", label)
		}
		parcel.ShipDate = shipDate
		seen := make(map[int]bool)
		for _, box := range input.Boxes {
			if box.Copies <= 0 {
				continue
			}
			if _, ok := available[box.GroupNo]; !ok {
				return nil, fmt.Errorf("%s里的箱组 %d 不存在，请刷新后重新选择", label, box.GroupNo)
			}
			if seen[box.GroupNo] {
				return nil, fmt.Errorf("%s重复选择了箱组 %d", label, box.GroupNo)
			}
			seen[box.GroupNo] = true
			assigned[box.GroupNo] += box.Copies
			if assigned[box.GroupNo] > available[box.GroupNo] {
				return nil, fmt.Errorf("箱组 %d 只有 %d 箱，分配到包裹里的箱数超过了", box.GroupNo, available[box.GroupNo])
			}
			parcel.Boxes = append(parcel.Boxes, model.TradeParcelBox{GroupNo: box.GroupNo, Copies: box.Copies})
		}
		sort.Slice(parcel.Boxes, func(a, b int) bool { return parcel.Boxes[a].GroupNo < parcel.Boxes[b].GroupNo })
		parcels = append(parcels, parcel)
	}
	return parcels, nil
}

// tradeParcelSummary is the order-level shipment the rest of the system
// reads (profit, PI, the AI agent): carriers, tracking numbers, overall
// status and the total freight in CNY.
func tradeParcelSummary(parcels []model.TradeParcel) *model.TradeShipment {
	summary := &model.TradeShipment{ShippingStatus: "未发货", ActualFreightCurrency: "CNY", ActualFreightToCNYRate: 1}
	carriers := make([]string, 0, len(parcels))
	tracking := make([]string, 0, len(parcels))
	shipped := len(parcels) > 0
	var firstShipDate *time.Time
	for _, parcel := range parcels {
		if parcel.Carrier != "" && !containsTradeString(carriers, parcel.Carrier) {
			carriers = append(carriers, parcel.Carrier)
		}
		if parcel.TrackingNo != "" {
			tracking = append(tracking, parcel.TrackingNo)
		}
		if parcel.ShippingStatus != tradeParcelShipped {
			shipped = false
		}
		if parcel.ShipDate != nil && (firstShipDate == nil || parcel.ShipDate.Before(*firstShipDate)) {
			firstShipDate = parcel.ShipDate
		}
		summary.ActualFreightAmount += parcel.ActualFreightAmount * parcel.ActualFreightToCNYRate
	}
	summary.Carrier = strings.Join(carriers, " / ")
	summary.BookingNo = strings.Join(tracking, "、")
	summary.ETD = firstShipDate
	if shipped {
		summary.ShippingStatus = tradeParcelShipped
	}
	if len(parcels) > 1 {
		summary.ActualFreightNotes = fmt.Sprintf("%d 个包裹运费合计", len(parcels))
	}
	return summary
}

// tradeParcelBlockers: every parcel shipped with a carrier and tracking
// number, and every packed box in some parcel.
func tradeParcelBlockers(parcels []model.TradeParcel, groups []model.TradePackingGroup) []string {
	blockers := make([]string, 0, 2)
	missing := make([]string, 0)
	notShipped := make([]string, 0)
	assigned := make(map[int]int)
	for _, parcel := range parcels {
		label := fmt.Sprintf("包裹 %d", parcel.ParcelNo)
		switch {
		case parcel.Carrier == "" && parcel.TrackingNo == "":
			missing = append(missing, label+"缺少物流公司和单号")
		case parcel.Carrier == "":
			missing = append(missing, label+"缺少物流公司")
		case parcel.TrackingNo == "":
			missing = append(missing, label+"缺少物流单号")
		}
		if parcel.ShippingStatus != tradeParcelShipped {
			notShipped = append(notShipped, label)
		}
		for _, box := range parcel.Boxes {
			assigned[box.GroupNo] += box.Copies
		}
	}
	if len(missing) > 0 {
		blockers = append(blockers, strings.Join(missing, "；"))
	}
	if len(notShipped) > 0 {
		blockers = append(blockers, strings.Join(notShipped, "、")+" 还没有标记为已发货")
	}
	left := make([]string, 0)
	for _, group := range groups {
		if remaining := group.Copies - assigned[group.GroupNo]; remaining > 0 {
			left = append(left, fmt.Sprintf("箱组 %d 剩 %d 箱", group.GroupNo, remaining))
		}
	}
	if len(left) > 0 {
		blockers = append(blockers, "还有箱子没分到包裹："+strings.Join(left, "、"))
	}
	return blockers
}

func containsTradeString(values []string, value string) bool {
	for _, candidate := range values {
		if strings.EqualFold(candidate, value) {
			return true
		}
	}
	return false
}
