package service

import (
	"database/sql"
	"errors"
	"fmt"

	"yaerp/internal/model"
)

type tradeUserAccess struct {
	profile       model.TradeAccessProfile
	positionCodes map[string]bool
	stageAccess   map[string]bool
}

func (s *TradeService) AccessProfile(userID int64) (*model.TradeAccessProfile, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	profile := access.profile
	return &profile, nil
}

func (s *TradeService) loadTradeUserAccess(userID int64) (*tradeUserAccess, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	positions, err := s.repo.ListUserPositions(userID)
	if err != nil {
		return nil, err
	}
	codes := make(map[string]bool, len(positions))
	stages := make(map[string]bool, len(positions))
	positionCodes := make([]string, 0, len(positions))
	positionNames := make([]string, 0, len(positions))
	allowedStages := make([]string, 0, len(positions))
	for _, position := range positions {
		codes[position.Code] = true
		stages[position.Stage] = true
		positionCodes = append(positionCodes, position.Code)
		positionNames = append(positionNames, position.Name)
		allowedStages = append(allowedStages, position.Stage)
	}
	manager := admin || codes["manager"]
	legacyOwnerMode := !admin && len(positions) == 0
	paymentRecordAccess := model.TradePaymentRecordAccessNone
	if admin {
		paymentRecordAccess = model.TradePaymentRecordAccessAll
	} else {
		if manager {
			paymentRecordAccess = model.TradePaymentRecordAccessAll
		} else if codes["sales"] || codes["quotation"] || codes["purchasing"] || legacyOwnerMode {
			paymentRecordAccess = model.TradePaymentRecordAccessOwn
		}
		settings, settingsErr := s.repo.GetSettings()
		if settingsErr != nil {
			return nil, settingsErr
		}
		for _, permission := range settings.PaymentRecordPermissions {
			if permission.UserID == userID {
				paymentRecordAccess = normalizeTradePaymentRecordAccess(permission.Access)
				break
			}
		}
	}
	canViewOrderProgress := admin || manager || len(positions) > 0
	canManageCustomerData := admin || manager || codes["sales"] || legacyOwnerMode
	canManageSupplierData := admin || manager || codes["sourcing"] || codes["quotation"] || codes["purchasing"]
	scopeLabel := "仅显示本人负责的业务单"
	switch {
	case admin:
		scopeLabel = "管理员：全部外贸数据"
	case manager:
		scopeLabel = "业务负责人：全部外贸流程"
	case len(positionNames) > 0:
		scopeLabel = fmt.Sprintf("岗位进度：%s（详细数据按岗位权限显示）", joinTradeLabels(positionNames))
	}
	return &tradeUserAccess{
		profile: model.TradeAccessProfile{
			UserID: userID, IsAdmin: admin, IsManager: manager,
			PositionCodes: positionCodes, PositionNames: positionNames, AllowedStages: allowedStages,
			CanViewAllOrders: admin || manager, CanViewOrderProgress: canViewOrderProgress,
			CanViewCustomers:   canManageCustomerData,
			CanCreateCustomers: canManageCustomerData, CanCreateOrders: canManageCustomerData,
			CanViewSuppliers: canManageSupplierData, CanManageSuppliers: canManageSupplierData,
			PaymentRecordAccess: paymentRecordAccess, ScopeLabel: scopeLabel,
		},
		positionCodes: codes,
		stageAccess:   stages,
	}, nil
}

func joinTradeLabels(values []string) string {
	if len(values) == 0 {
		return "未配置"
	}
	result := values[0]
	for index := 1; index < len(values); index++ {
		result += "、" + values[index]
	}
	return result
}

func (s *TradeService) canViewTradeOrder(userID int64, order *model.TradeOrder, access *tradeUserAccess) bool {
	if order == nil || access == nil {
		return false
	}
	return access.profile.CanViewAllOrders || access.profile.CanViewOrderProgress || order.OwnerID == userID || access.stageAccess[order.Stage]
}

func tradeOrderScopeStages(access *tradeUserAccess) []string {
	if access == nil {
		return nil
	}
	if !access.profile.CanViewOrderProgress || access.profile.CanViewAllOrders {
		return access.profile.AllowedStages
	}
	stages := append([]string{}, tradeStageOrder...)
	return append(stages, model.TradeStageCancelled)
}

func tradeCustomerAccessScope(full, owner, currentTask bool, codes map[string]bool) (bool, bool, bool) {
	// Sales colleagues share the inquiry stage, so a sales seat alone must not
	// reveal another salesperson's customer; only the owner or the quotation
	// desk working the current task may see it.
	customerTask := currentTask && codes["quotation"]
	allowed := full || owner || customerTask
	return allowed, allowed, allowed
}

func tradeSupplierAccessScope(full bool, stage string, codes map[string]bool) (bool, bool) {
	if full {
		return true, true
	}
	canView := false
	canViewPricing := false
	switch stage {
	case model.TradeStageSupplierQuote:
		canView = codes["sourcing"] || codes["purchasing"]
		canViewPricing = canView
	case model.TradeStageQuotation:
		canView = codes["quotation"] || codes["purchasing"]
		canViewPricing = codes["purchasing"]
	case model.TradeStagePurchase:
		canView = codes["purchasing"]
		canViewPricing = canView
	}
	return canView, canViewPricing
}

func tradePaymentRecordScope(full, owner, currentTask bool, configuredAccess string) (bool, bool, bool, bool) {
	configuredAccess = normalizeTradePaymentRecordAccess(configuredAccess)
	canViewAll := full || configuredAccess == model.TradePaymentRecordAccessAll
	canViewOwn := owner || (currentTask && configuredAccess == model.TradePaymentRecordAccessOwn)
	canView := canViewAll || canViewOwn
	canUpload := canViewAll || owner || (currentTask && configuredAccess == model.TradePaymentRecordAccessOwn)
	return canView, canViewAll, canUpload, canViewAll
}

func (s *TradeService) orderAccessForUser(userID int64, order *model.TradeOrder, access *tradeUserAccess) (*model.TradeOrderAccess, error) {
	if order == nil || access == nil {
		return nil, fmt.Errorf("业务单访问范围不能为空")
	}
	full := access.profile.CanViewAllOrders
	owner := order.OwnerID == userID
	codes := access.positionCodes
	canViewCustomer, canViewCustomerContact, canViewCustomerPricing := tradeCustomerAccessScope(
		full, owner, access.stageAccess[order.Stage], codes,
	)
	canViewSupplier, canViewSupplierPricing := tradeSupplierAccessScope(full, order.Stage, codes)
	// Seeing both the selling price and the purchase cost reveals the margin,
	// which is reserved for admins and the manager position.
	if !full && canViewCustomerPricing {
		canViewSupplierPricing = false
	}
	canViewPayments, canViewAllPayments, canUploadPaymentProofs, canManagePaymentStatus := tradePaymentRecordScope(
		full, owner, access.stageAccess[order.Stage], access.profile.PaymentRecordAccess,
	)
	result := &model.TradeOrderAccess{
		CanViewCustomer:          canViewCustomer,
		CanViewCustomerContact:   canViewCustomerContact,
		CanViewCustomerPricing:   canViewCustomerPricing,
		CanViewSupplier:          canViewSupplier,
		CanViewSupplierPricing:   canViewSupplierPricing,
		CanViewReceiving:         full || codes["purchasing"] || codes["warehouse"] || codes["quality"],
		CanViewInspection:        full || codes["quality"] || codes["packing"],
		CanViewPacking:           full || codes["packing"] || codes["logistics"],
		CanViewShipment:          full || owner || codes["sales"] || codes["logistics"],
		CanViewProfit:            full,
		CanViewTimeline:          full || owner || access.profile.CanViewOrderProgress,
		CanViewPI:                full || owner,
		CanGeneratePI:            full || owner,
		CanViewPaymentRecords:    canViewPayments,
		CanViewAllPaymentRecords: canViewAllPayments,
		CanUploadPaymentProofs:   canUploadPaymentProofs,
		CanManagePaymentStatus:   canManagePaymentStatus,
	}
	switch {
	case full:
		result.ScopeLabel = "完整流程权限"
	case access.stageAccess[order.Stage]:
		result.ScopeLabel = fmt.Sprintf("当前任务：%s", tradeStageLabel(order.Stage))
	case owner:
		result.ScopeLabel = "本人业务单：隐藏非职责敏感数据"
	default:
		result.ScopeLabel = "流程进度可见：详细数据按岗位权限隐藏"
	}

	canOperate := full
	if !full {
		var err error
		canOperate, _, err = s.canOperateStage(userID, order)
		if err != nil {
			return nil, err
		}
	}
	earlyStage := order.Stage == model.TradeStageInquiry || order.Stage == model.TradeStageSupplierQuote || order.Stage == model.TradeStageQuotation
	activeStage := order.Stage != model.TradeStageCompleted && order.Stage != model.TradeStageCancelled
	result.CanAddItems = activeStage && (full || (earlyStage && (owner || canOperate)))
	// Inquiry images are what the customer sent; real goods photos are taken
	// at inspection through the inspection-photo flow.
	result.CanManageItemImages = activeStage && (full || (earlyStage && (owner || canOperate)))
	return result, nil
}

func normalizeTradePaymentRecordAccess(value string) string {
	switch value {
	case model.TradePaymentRecordAccessAll:
		return model.TradePaymentRecordAccessAll
	case model.TradePaymentRecordAccessOwn:
		return model.TradePaymentRecordAccessOwn
	default:
		return model.TradePaymentRecordAccessNone
	}
}

func (s *TradeService) AuthorizePaymentAttachment(userID, attachmentID int64) (bool, bool, error) {
	references, err := s.repo.ListPaymentProofReferencesByAttachment(attachmentID)
	if err != nil {
		return false, false, err
	}
	piOrderIDs, err := s.repo.ListPIBankImageOrderIDsByAttachment(attachmentID)
	if err != nil {
		return false, false, err
	}
	if len(references) == 0 && len(piOrderIDs) == 0 {
		return false, true, nil
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return true, false, err
	}
	for _, reference := range references {
		if reference.DeletedAt != nil {
			if access.profile.IsAdmin {
				return true, true, nil
			}
			continue
		}
		order, orderErr := s.repo.GetOrder(reference.OrderID, userID, true)
		if errors.Is(orderErr, sql.ErrNoRows) {
			continue
		}
		if orderErr != nil {
			return true, false, orderErr
		}
		if !s.canViewTradeOrder(userID, order, access) {
			continue
		}
		orderAccess, accessErr := s.orderAccessForUser(userID, order, access)
		if accessErr != nil {
			return true, false, accessErr
		}
		if !orderAccess.CanViewPaymentRecords {
			continue
		}
		if orderAccess.CanViewAllPaymentRecords || reference.UploadedBy == userID {
			return true, true, nil
		}
	}
	for _, orderID := range piOrderIDs {
		order, orderErr := s.repo.GetOrder(orderID, userID, true)
		if errors.Is(orderErr, sql.ErrNoRows) {
			continue
		}
		if orderErr != nil {
			return true, false, orderErr
		}
		if !s.canViewTradeOrder(userID, order, access) {
			continue
		}
		orderAccess, accessErr := s.orderAccessForUser(userID, order, access)
		if accessErr != nil {
			return true, false, accessErr
		}
		if orderAccess.CanViewPI {
			return true, true, nil
		}
	}
	return true, false, nil
}

func (s *TradeService) redactTradeOrder(userID int64, order *model.TradeOrder, access *tradeUserAccess) error {
	orderAccess, err := s.orderAccessForUser(userID, order, access)
	if err != nil {
		return err
	}
	// Keep the original unstructured import for audit on the server. It can mix
	// customer pricing, supplier cost, and payment details, so only a fully
	// privileged trade view may receive it.
	if !orderAccess.CanViewCustomerPricing || !orderAccess.CanViewSupplierPricing || !orderAccess.CanViewPaymentRecords {
		order.AISourceText = ""
	}
	order.Access = orderAccess
	if !orderAccess.CanViewCustomer {
		order.CustomerID = 0
		order.CustomerName = "受限客户"
		order.CustomerCompany = ""
		order.CustomerAvatarURL = ""
		order.Customer = nil
	} else if order.Customer != nil && !orderAccess.CanViewCustomerContact {
		redactTradeCustomerContact(order.Customer)
	}
	if !orderAccess.CanViewCustomerContact {
		order.ChannelID = nil
		order.Notes = ""
	}
	redactTradePaymentRecords(userID, order.CustomerQuotes, orderAccess)
	redactTradePIBankImages(order.CustomerQuotes, orderAccess)
	if !orderAccess.CanViewProfit {
		for index := range order.CustomerQuotes {
			order.CustomerQuotes[index].ProfitMarginPercent = 0
		}
		if order.Shipment != nil {
			order.Shipment.ActualFreightCurrency = ""
			order.Shipment.ActualFreightAmount = 0
			order.Shipment.ActualFreightToCNYRate = 0
			order.Shipment.ActualFreightNotes = ""
		}
	}
	if !orderAccess.CanViewCustomerPricing {
		order.TotalAmount = 0
		order.QuotedGoodsAmount = 0
		order.QuoteExchangeRateCNY = 0
		order.QuotedFreightAmount = 0
		order.QuoteDeadline = nil
		order.PaymentMethod = ""
		order.PaymentTerms = ""
		if orderAccess.CanViewPaymentRecords {
			order.CustomerQuotes = tradePaymentReviewQuotes(order.CustomerQuotes)
		} else {
			order.CustomerQuotes = nil
		}
		order.PaymentGalleryDirectoryID = nil
	} else if !orderAccess.CanViewAllPaymentRecords {
		order.PaymentGalleryDirectoryID = nil
	}
	if !orderAccess.CanViewProfit {
		order.ActualFreightCurrency = ""
		order.ActualFreightAmount = 0
		order.ActualFreightToCNYRate = 0
		order.ActualFreightNotes = ""
		order.AdditionalCostAmount = 0
		order.AdditionalCostNotes = ""
		order.ProfitSummary = nil
	}
	if !orderAccess.CanViewCustomer && !orderAccess.CanViewShipment {
		order.DestinationCountry = ""
		order.DestinationPort = ""
	}
	if !orderAccess.CanViewInspection {
		order.InspectionPhotos = nil
		order.InspectionGalleryDirectoryID = nil
	}
	if !orderAccess.CanViewShipment {
		order.Shipment = nil
	}
	if !orderAccess.CanViewPacking {
		order.PackingGroups = nil
	}
	if !orderAccess.CanViewSupplier {
		order.SupplierQuotes = nil
	} else if !orderAccess.CanViewSupplierPricing {
		for index := range order.SupplierQuotes {
			quote := &order.SupplierQuotes[index]
			quote.Currency = ""
			quote.UnitPrice = 0
			quote.Notes = ""
		}
	}
	for index := range order.Items {
		item := &order.Items[index]
		if !orderAccess.CanViewCustomerPricing {
			item.TargetPrice = 0
			item.QuotedPrice = 0
		}
		if !orderAccess.CanViewSupplier {
			item.SupplierName = ""
		}
		if !orderAccess.CanViewSupplierPricing {
			item.PurchaseCurrency = ""
			item.PurchasePrice = 0
		}
		if !orderAccess.CanViewReceiving {
			item.ReceivedQuantity = 0
		}
		if !orderAccess.CanViewInspection {
			item.AcceptedQuantity = 0
		}
		if !orderAccess.CanViewPacking {
			item.PackedQuantity = 0
			item.CartonCount = 0
			item.HSCode = ""
			item.GrossWeight = 0
			item.NetWeight = 0
		}
		redactTradeWorkflowData(item, orderAccess)
		if !orderAccess.CanViewInspection && len(item.Images) > 0 {
			inquiryImages := item.Images[:0]
			for _, image := range item.Images {
				if image.Source == "inquiry" {
					inquiryImages = append(inquiryImages, image)
				}
			}
			item.Images = inquiryImages
		}
	}
	if orderAccess.CanViewTimeline && !access.profile.CanViewAllOrders && order.OwnerID != userID {
		redactTradeTimelineDetails(order.Events, order.Stage, access.stageAccess[order.Stage])
	} else if !orderAccess.CanViewTimeline && len(order.Events) > 0 {
		var relevant *model.TradeOrderStageEvent
		for index := len(order.Events) - 1; index >= 0; index-- {
			if order.Events[index].ToStage == order.Stage {
				event := order.Events[index]
				event.Snapshot = map[string]any{}
				relevant = &event
				break
			}
		}
		if relevant == nil {
			order.Events = nil
		} else {
			order.Events = []model.TradeOrderStageEvent{*relevant}
		}
	}
	return nil
}

func redactTradePaymentRecords(userID int64, quotes []model.TradeCustomerQuoteRound, access *model.TradeOrderAccess) {
	for quoteIndex := range quotes {
		quote := &quotes[quoteIndex]
		if access == nil || !access.CanViewPaymentRecords {
			quote.PaymentStatus = ""
			quote.PaymentCurrency = ""
			quote.PaidAmount = 0
			quote.PaymentProofs = nil
			continue
		}
		if access.CanViewAllPaymentRecords {
			continue
		}
		quote.PaymentStatus = ""
		quote.PaymentCurrency = ""
		quote.PaidAmount = 0
		visibleProofs := make([]model.TradePaymentProof, 0, len(quote.PaymentProofs))
		for _, proof := range quote.PaymentProofs {
			if proof.UploadedBy == userID {
				visibleProofs = append(visibleProofs, proof)
			}
		}
		quote.PaymentProofs = visibleProofs
	}
}

func redactTradePIBankImages(quotes []model.TradeCustomerQuoteRound, access *model.TradeOrderAccess) {
	if access != nil && access.CanViewPI {
		return
	}
	for quoteIndex := range quotes {
		quotes[quoteIndex].PIBankDetailsImageAttachmentID = nil
		quotes[quoteIndex].PIBankDetailsImageURL = ""
		quotes[quoteIndex].PISellerProfile = nil
	}
}

func tradePaymentReviewQuotes(quotes []model.TradeCustomerQuoteRound) []model.TradeCustomerQuoteRound {
	result := make([]model.TradeCustomerQuoteRound, 0, 1)
	for _, quote := range quotes {
		if quote.Status != "accepted" {
			continue
		}
		result = append(result, model.TradeCustomerQuoteRound{
			ID: quote.ID, OrderID: quote.OrderID, RoundNo: quote.RoundNo,
			Currency: quote.Currency, Status: quote.Status,
			PaymentStatus: quote.PaymentStatus, PaymentCurrency: quote.PaymentCurrency,
			PaidAmount: quote.PaidAmount, PaymentProofs: quote.PaymentProofs,
			CreatedAt: quote.CreatedAt, UpdatedAt: quote.UpdatedAt,
		})
	}
	return result
}

func redactTradeTimelineDetails(events []model.TradeOrderStageEvent, currentStage string, canViewCurrentTask bool) {
	visibleDetailIndex := -1
	if canViewCurrentTask {
		for index := len(events) - 1; index >= 0; index-- {
			if events[index].ToStage == currentStage {
				visibleDetailIndex = index
				break
			}
		}
	}
	for index := range events {
		events[index].Snapshot = map[string]any{}
		if index == visibleDetailIndex {
			continue
		}
		events[index].ActorID = nil
		events[index].ActorName = ""
		events[index].Note = ""
	}
}

func redactTradeCustomerContact(customer *model.TradeCustomer) {
	if customer == nil {
		return
	}
	customer.ContactName = ""
	customer.Email = ""
	customer.Phone = ""
	customer.WhatsAppAccountID = nil
	customer.WhatsAppChatID = ""
	customer.WhatsAppChatName = ""
	customer.ChannelID = nil
	customer.Tags = nil
	customer.Notes = ""
}

func redactTradeWorkflowData(item *model.TradeOrderItem, access *model.TradeOrderAccess) {
	if item == nil || item.WorkflowData == nil || access == nil {
		return
	}
	remove := func(keys ...string) {
		for _, key := range keys {
			delete(item.WorkflowData, key)
		}
	}
	if !access.CanViewSupplierPricing {
		remove("purchase_status", "cost_exchange_rate")
	}
	if !access.CanViewReceiving {
		remove("warehouse_location", "received_date", "receipt_status")
	}
	if !access.CanViewInspection {
		remove("sample_qty", "inspection_result", "inspection_issue", "inspector", "inspection_date")
	}
	if !access.CanViewPacking {
		remove("carton_no", "carton_size", "marks")
	}
	if len(item.WorkflowData) == 0 {
		item.WorkflowData = nil
	}
}
