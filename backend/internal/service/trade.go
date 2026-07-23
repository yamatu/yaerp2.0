package service

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"mime/multipart"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

var tradePhoneDigitsPattern = regexp.MustCompile(`[^0-9+]`)

var tradeStageOrder = []string{
	model.TradeStageInquiry,
	model.TradeStageSupplierQuote,
	model.TradeStageQuotation,
	model.TradeStagePurchase,
	model.TradeStageReceiving,
	model.TradeStageInspection,
	model.TradeStagePacking,
	model.TradeStageShipment,
	model.TradeStageCompleted,
}

var tradeStageLabels = map[string]string{
	model.TradeStageInquiry:       "询价",
	model.TradeStageSupplierQuote: "供应商询价",
	model.TradeStageQuotation:     "对客报价与议价",
	model.TradeStagePurchase:      "采购",
	model.TradeStageReceiving:     "仓库到货",
	model.TradeStageInspection:    "质检",
	model.TradeStagePacking:       "装箱",
	model.TradeStageShipment:      "发货",
	model.TradeStageCompleted:     "已完成",
	model.TradeStageCancelled:     "已取消",
}

var tradeStageColors = map[string]any{
	"询价":      map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
	"供应商询价":   map[string]string{"backgroundColor": "#FCE7F3", "textColor": "#9D174D"},
	"对客报价与议价": map[string]string{"backgroundColor": "#DBEAFE", "textColor": "#1D4ED8"},
	"采购":      map[string]string{"backgroundColor": "#EDE9FE", "textColor": "#6D28D9"},
	"仓库到货":    map[string]string{"backgroundColor": "#CFFAFE", "textColor": "#0E7490"},
	"质检":      map[string]string{"backgroundColor": "#CCFBF1", "textColor": "#0F766E"},
	"装箱":      map[string]string{"backgroundColor": "#FFEDD5", "textColor": "#C2410C"},
	"发货":      map[string]string{"backgroundColor": "#E0F2FE", "textColor": "#0369A1"},
	"已完成":     map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
	"已取消":     map[string]string{"backgroundColor": "#F1F5F9", "textColor": "#475569"},
}

type TradeService struct {
	repo              *repo.TradeRepo
	sheetRepo         *repo.SheetRepo
	sheetSvc          *SheetService
	channelSvc        *ChannelService
	whatsAppSvc       *WhatsAppService
	uploadSvc         *UploadService
	permSvc           *PermissionService
	userRepo          *repo.UserRepo
	automationRepo    *repo.AutomationRepo
	notificationHook  func([]int64)
	orderUpdatedHook  func(orderID int64)
	cellBroadcastHook func(actorID int64, changes []model.CellUpdate)
}

func NewTradeService(
	tradeRepo *repo.TradeRepo,
	sheetRepo *repo.SheetRepo,
	sheetSvc *SheetService,
	channelSvc *ChannelService,
	whatsAppSvc *WhatsAppService,
	uploadSvc *UploadService,
	permSvc *PermissionService,
	userRepo *repo.UserRepo,
	automationRepo *repo.AutomationRepo,
) *TradeService {
	return &TradeService{
		repo: tradeRepo, sheetRepo: sheetRepo, sheetSvc: sheetSvc, channelSvc: channelSvc,
		whatsAppSvc: whatsAppSvc, uploadSvc: uploadSvc, permSvc: permSvc, userRepo: userRepo,
		automationRepo: automationRepo,
	}
}

func (s *TradeService) SetNotificationHook(hook func([]int64)) {
	s.notificationHook = hook
}

func (s *TradeService) SetOrderUpdatedHook(hook func(int64)) {
	s.orderUpdatedHook = hook
}

func (s *TradeService) SetCellBroadcastHook(hook func(int64, []model.CellUpdate)) {
	s.cellBroadcastHook = hook
}

func (s *TradeService) notifyOrderUpdated(orderID int64) {
	if s.orderUpdatedHook != nil && orderID > 0 {
		go s.orderUpdatedHook(orderID)
	}
}

func (s *TradeService) applyTradeCellChanges(actorID int64, changes []model.CellUpdate) error {
	if len(changes) == 0 {
		return nil
	}
	if err := s.sheetSvc.UpdateCellsWithSource(actorID, changes, "trade_erp"); err != nil {
		return err
	}
	if s.cellBroadcastHook != nil {
		s.cellBroadcastHook(actorID, changes)
	}
	return nil
}

func (s *TradeService) isAdmin(userID int64) (bool, error) {
	return s.permSvc.IsAdmin(userID)
}

func (s *TradeService) ensureWritableTradeFolder(userID int64, folderID *int64) error {
	if folderID == nil {
		return nil
	}
	canWrite, err := s.permSvc.CanWriteFolder(*folderID, userID)
	if err != nil {
		return err
	}
	if !canWrite {
		return fmt.Errorf("所选工作簿文件夹不存在或没有写入权限")
	}
	return nil
}

func (s *TradeService) Dashboard(userID int64) (*model.TradeDashboard, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	return s.repo.DashboardScoped(
		userID, access.profile.CanViewAllOrders, tradeOrderScopeStages(access),
		access.profile.CanViewCustomers,
	)
}

func (s *TradeService) BossDashboard(userID int64) (*model.TradeBossDashboard, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewAllOrders {
		return nil, fmt.Errorf("仅管理员或业务负责人可以查看老板面板")
	}
	orders, err := s.repo.ListOrdersForProfit()
	if err != nil {
		return nil, err
	}
	items, err := s.repo.ListAllOrderItems()
	if err != nil {
		return nil, err
	}
	itemsByOrder := make(map[int64][]model.TradeOrderItem)
	for _, item := range items {
		itemsByOrder[item.OrderID] = append(itemsByOrder[item.OrderID], item)
	}

	dashboard := &model.TradeBossDashboard{
		TotalOrders:     int64(len(orders)),
		Currencies:      []model.TradeBossCurrencySummary{},
		Monthly:         []model.TradeBossMonthlySummary{},
		RecentOrders:    []model.TradeBossOrderSummary{},
		TopProfitOrders: []model.TradeBossOrderSummary{},
		LossOrderList:   []model.TradeBossOrderSummary{},
	}
	currencies := make(map[string]*model.TradeBossCurrencySummary)
	completeSummaries := make([]model.TradeBossOrderSummary, 0, len(orders))
	for _, order := range orders {
		profit := buildTradeProfitSummary(&order, itemsByOrder[order.ID])
		if order.Stage == model.TradeStageCompleted {
			dashboard.CompletedOrders++
		} else if order.Stage != model.TradeStageCancelled {
			dashboard.ActiveOrders++
		}
		if !profit.CostComplete {
			dashboard.IncompleteCostOrders++
		} else {
			if profit.ProfitAmount < 0 {
				dashboard.LossOrders++
			} else if profit.ProfitAmount > 0 {
				dashboard.ProfitableOrders++
			}
		}
		currency := strings.ToUpper(firstNonEmptyTrade(profit.Currency, "未设置"))
		currencySummary := currencies[currency]
		if currencySummary == nil {
			currencySummary = &model.TradeBossCurrencySummary{Currency: currency}
			currencies[currency] = currencySummary
		}
		currencySummary.OrderCount++
		currencySummary.Revenue += profit.Revenue
		currencySummary.GoodsRevenue += profit.GoodsRevenue
		currencySummary.FreightRevenue += profit.FreightRevenue
		currencySummary.ProductCost += profit.ProductCost
		currencySummary.ActualFreightCost += profit.ActualFreightCost
		currencySummary.AdditionalCost += profit.AdditionalCost
		currencySummary.TotalCost += profit.TotalCost
		currencySummary.FreightProfit += profit.FreightProfit
		currencySummary.ProfitAmount += profit.ProfitAmount
		if profit.CNYComplete {
			dashboard.CNYCompleteOrders++
			dashboard.RevenueCNY += profit.RevenueCNY
			dashboard.TotalCostCNY += profit.TotalCostCNY
			dashboard.ProfitAmountCNY += profit.ProfitAmountCNY
			dashboard.FreightRevenueCNY += profit.FreightRevenueCNY
			dashboard.FreightCostCNY += profit.FreightCostCNY
			dashboard.FreightProfitCNY += profit.FreightProfitCNY
		}

		summary := model.TradeBossOrderSummary{
			ID: order.ID, OrderNo: order.OrderNo, Title: order.Title,
			CustomerName: order.CustomerName, OwnerName: order.OwnerName, Stage: order.Stage,
			Currency: currency, Revenue: profit.Revenue, GoodsRevenue: profit.GoodsRevenue,
			FreightRevenue: profit.FreightRevenue, TotalCost: profit.TotalCost,
			ActualFreightCost: profit.ActualFreightCost, FreightProfit: profit.FreightProfit,
			ProfitAmount: profit.ProfitAmount, ProfitMargin: profit.ProfitMargin,
			RevenueCNY: profit.RevenueCNY, TotalCostCNY: profit.TotalCostCNY,
			ProfitAmountCNY: profit.ProfitAmountCNY, FreightProfitCNY: profit.FreightProfitCNY,
			CostComplete: profit.CostComplete, CNYComplete: profit.CNYComplete,
			Warnings: profit.Warnings, UpdatedAt: order.UpdatedAt,
		}
		if len(dashboard.RecentOrders) < 30 {
			dashboard.RecentOrders = append(dashboard.RecentOrders, summary)
		}
		if profit.CostComplete {
			completeSummaries = append(completeSummaries, summary)
		}
	}
	for _, summary := range currencies {
		if summary.Revenue != 0 {
			summary.ProfitMargin = summary.ProfitAmount / summary.Revenue * 100
		}
		dashboard.Currencies = append(dashboard.Currencies, *summary)
	}
	sort.Slice(dashboard.Currencies, func(i, j int) bool {
		return dashboard.Currencies[i].Currency < dashboard.Currencies[j].Currency
	})
	sort.Slice(completeSummaries, func(i, j int) bool {
		return completeSummaries[i].ProfitAmount > completeSummaries[j].ProfitAmount
	})
	for _, summary := range completeSummaries {
		if summary.ProfitAmount > 0 && len(dashboard.TopProfitOrders) < 10 {
			dashboard.TopProfitOrders = append(dashboard.TopProfitOrders, summary)
		}
	}
	sort.Slice(completeSummaries, func(i, j int) bool {
		return completeSummaries[i].ProfitAmount < completeSummaries[j].ProfitAmount
	})
	for _, summary := range completeSummaries {
		if summary.ProfitAmount < 0 && len(dashboard.LossOrderList) < 10 {
			dashboard.LossOrderList = append(dashboard.LossOrderList, summary)
		}
	}
	dashboard.Monthly = buildTradeMonthlyProfit(orders, itemsByOrder, time.Now())
	return dashboard, nil
}

func buildTradeMonthlyProfit(
	orders []model.TradeOrder,
	itemsByOrder map[int64][]model.TradeOrderItem,
	now time.Time,
) []model.TradeBossMonthlySummary {
	monthStart := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location()).AddDate(0, -11, 0)
	result := make([]model.TradeBossMonthlySummary, 12)
	byMonth := make(map[string]*model.TradeBossMonthlySummary, len(result))
	for index := range result {
		month := monthStart.AddDate(0, index, 0)
		result[index].Month = month.Format("2006-01")
		byMonth[result[index].Month] = &result[index]
	}

	for _, order := range orders {
		if order.Stage != model.TradeStageCompleted {
			continue
		}
		completedAt := order.StageUpdatedAt
		if completedAt.IsZero() {
			completedAt = order.UpdatedAt
		}
		bucket := byMonth[completedAt.In(now.Location()).Format("2006-01")]
		if bucket == nil {
			continue
		}
		bucket.CompletedOrders++
		profit := buildTradeProfitSummary(&order, itemsByOrder[order.ID])
		if !profit.Finalized {
			bucket.IncompleteOrders++
			continue
		}
		bucket.FinalizedOrders++
		bucket.RevenueCNY += profit.RevenueCNY
		bucket.TotalCostCNY += profit.TotalCostCNY
		bucket.ProfitAmountCNY += profit.ProfitAmountCNY
		bucket.FreightProfitCNY += profit.FreightProfitCNY
	}
	for index := range result {
		if result[index].RevenueCNY != 0 {
			result[index].ProfitMargin = result[index].ProfitAmountCNY / result[index].RevenueCNY * 100
		}
	}
	return result
}

func (s *TradeService) ListCustomers(userID int64, search string) ([]model.TradeCustomer, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewCustomers {
		return []model.TradeCustomer{}, nil
	}
	return s.repo.ListCustomers(userID, access.profile.CanViewAllOrders, search)
}

func (s *TradeService) CreateCustomer(userID int64, request *model.CreateTradeCustomerRequest) (*model.TradeCustomer, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanCreateCustomers {
		return nil, fmt.Errorf("当前岗位没有录入客户的权限")
	}
	if request == nil {
		return nil, fmt.Errorf("客户资料不能为空")
	}
	if err := s.ensureWritableTradeFolder(userID, request.WorkbookFolderID); err != nil {
		return nil, err
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		return nil, fmt.Errorf("客户名称不能为空")
	}
	request.WhatsAppChatID = strings.TrimSpace(request.WhatsAppChatID)
	if request.WhatsAppChatID != "" {
		if existing, err := s.repo.GetCustomerByWhatsApp(userID, request.WhatsAppChatID); err == nil {
			existing.IntegrationWarning = "该 WhatsApp 客户已建档，已直接打开原客户资料。"
			return existing, nil
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}

	source := strings.ToLower(strings.TrimSpace(request.Source))
	if source == "" {
		if request.WhatsAppChatID != "" {
			source = "whatsapp"
		} else {
			source = "manual"
		}
	}
	if !validTradeCustomerSource(source) {
		return nil, fmt.Errorf("不支持的客户来源")
	}
	level := strings.ToUpper(strings.TrimSpace(request.CustomerLevel))
	if level == "" {
		level = "B"
	}
	if level != "A" && level != "B" && level != "C" {
		return nil, fmt.Errorf("客户等级仅支持 A、B、C")
	}
	phone := strings.TrimSpace(request.Phone)
	if phone == "" && request.WhatsAppChatID != "" {
		phone = phoneFromWhatsAppChat(request.WhatsAppChatID)
	}
	customer := &model.TradeCustomer{
		OwnerID: userID, Name: name, CompanyName: strings.TrimSpace(request.CompanyName),
		Country: strings.TrimSpace(request.Country), Region: strings.TrimSpace(request.Region),
		ContactName: strings.TrimSpace(request.ContactName), Email: strings.TrimSpace(request.Email),
		Phone: phone, Source: source, CustomerLevel: level, WhatsAppAccountID: request.WhatsAppAccountID,
		WhatsAppChatID: request.WhatsAppChatID, WhatsAppChatName: strings.TrimSpace(request.WhatsAppChatName),
		AvatarURL: strings.TrimSpace(request.AvatarURL), WorkbookFolderID: request.WorkbookFolderID,
		Tags: normalizeTradeTags(request.Tags), Notes: strings.TrimSpace(request.Notes),
	}
	if customer.CompanyName == "" {
		customer.CompanyName = customer.Name
	}
	if customer.ContactName == "" && source == "whatsapp" {
		customer.ContactName = customer.Name
	}
	if err := s.repo.CreateCustomer(customer); err != nil {
		return nil, err
	}
	if user, err := s.userRepo.GetByID(userID); err == nil && user != nil {
		customer.OwnerName = user.Username
	}

	createChannel := request.CreateChannel == nil || *request.CreateChannel
	if createChannel {
		description := fmt.Sprintf("外贸客户 %s · %s", customer.CustomerCode, firstNonEmptyTrade(customer.CompanyName, customer.Name))
		channel, err := s.channelSvc.CreateChannel(userID, &model.ChannelCreateRequest{Name: customer.Name, Description: &description})
		if err != nil {
			customer.IntegrationWarning = "客户已创建，但客户频道创建失败：" + err.Error()
		} else {
			customer.ChannelID = &channel.ID
			if err := s.repo.SetCustomerChannel(customer.ID, userID, channel.ID); err != nil {
				customer.IntegrationWarning = "客户已创建，但频道关联保存失败：" + err.Error()
			}
			if customer.WhatsAppAccountID != nil && customer.WhatsAppChatID != "" {
				inbound, outbound := true, true
				_, linkErr := s.whatsAppSvc.UpdateChannelLink(userID, channel.ID, &model.WhatsAppChannelLinkRequest{
					WhatsAppAccountID: *customer.WhatsAppAccountID,
					WhatsAppChatID:    customer.WhatsAppChatID,
					SyncInbound:       &inbound, SyncOutbound: &outbound,
				})
				if linkErr != nil {
					customer.IntegrationWarning = "客户与频道已创建，但 WhatsApp 会话关联失败：" + linkErr.Error()
				}
			}
			_, _ = s.channelSvc.CreateMessage(userID, channel.ID, ChannelMessageInput{
				Content:      fmt.Sprintf("已建立客户档案：%s（%s）。询价、报价、采购和发货资料会集中在此频道。", customer.Name, customer.CustomerCode),
				InternalOnly: true,
			})
		}
	}

	loaded, err := s.getCustomer(userID, customer.ID)
	if err == nil {
		loaded.IntegrationWarning = customer.IntegrationWarning
		return loaded, nil
	}
	return customer, nil
}

func (s *TradeService) UpdateCustomer(userID, customerID int64, request *model.UpdateTradeCustomerRequest) (*model.TradeCustomer, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewCustomers {
		return nil, fmt.Errorf("当前岗位没有编辑客户资料的权限")
	}
	current, err := s.repo.GetCustomer(customerID, userID, access.profile.CanViewAllOrders)
	if err != nil {
		return nil, err
	}
	if err := s.ensureWritableTradeFolder(userID, request.WorkbookFolderID); err != nil {
		return nil, err
	}
	updated, err := normalizeTradeCustomerUpdate(request)
	if err != nil {
		return nil, err
	}
	updated.ID = current.ID
	updated.OwnerID = current.OwnerID
	updated.CustomerCode = current.CustomerCode
	updated.ChannelID = current.ChannelID
	if err := s.repo.UpdateCustomer(updated); err != nil {
		if strings.Contains(err.Error(), "uq_trade_customers_owner_whatsapp_chat") {
			return nil, fmt.Errorf("该 WhatsApp 会话已经关联到其他客户")
		}
		return nil, err
	}
	return s.repo.GetCustomer(customerID, userID, access.profile.CanViewAllOrders)
}

func normalizeTradeCustomerUpdate(request *model.UpdateTradeCustomerRequest) (*model.TradeCustomer, error) {
	if request == nil {
		return nil, fmt.Errorf("客户资料不能为空")
	}
	name := strings.TrimSpace(request.Name)
	if name == "" {
		return nil, fmt.Errorf("客户名称不能为空")
	}
	source := strings.ToLower(strings.TrimSpace(request.Source))
	if source == "" {
		source = "manual"
	}
	if !validTradeCustomerSource(source) {
		return nil, fmt.Errorf("不支持的客户来源")
	}
	status := strings.ToLower(strings.TrimSpace(request.Status))
	if status == "" {
		status = "lead"
	}
	if !validTradeCustomerStatus(status) {
		return nil, fmt.Errorf("不支持的客户状态")
	}
	level := strings.ToUpper(strings.TrimSpace(request.CustomerLevel))
	if level == "" {
		level = "B"
	}
	if level != "A" && level != "B" && level != "C" {
		return nil, fmt.Errorf("客户等级仅支持 A、B、C")
	}
	companyName := strings.TrimSpace(request.CompanyName)
	if companyName == "" {
		companyName = name
	}
	return &model.TradeCustomer{
		Name: name, CompanyName: companyName, Country: strings.TrimSpace(request.Country),
		Region: strings.TrimSpace(request.Region), ContactName: strings.TrimSpace(request.ContactName),
		Email: strings.TrimSpace(request.Email), Phone: strings.TrimSpace(request.Phone), Source: source,
		Status: status, CustomerLevel: level, WhatsAppAccountID: request.WhatsAppAccountID,
		WhatsAppChatID:   strings.TrimSpace(request.WhatsAppChatID),
		WhatsAppChatName: strings.TrimSpace(request.WhatsAppChatName),
		AvatarURL:        strings.TrimSpace(request.AvatarURL), Tags: normalizeTradeTags(request.Tags),
		Notes: strings.TrimSpace(request.Notes), WorkbookFolderID: request.WorkbookFolderID,
	}, nil
}

func (s *TradeService) ListCustomerDeleteRequests(userID int64, status string) ([]model.TradeCustomerDeleteRequest, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	status = strings.ToLower(strings.TrimSpace(status))
	if status != "" && status != "pending" && status != "approved" && status != "rejected" && status != "cancelled" {
		return nil, fmt.Errorf("无效的客户删除申请状态")
	}
	return s.repo.ListCustomerDeleteRequests(userID, admin, status)
}

func (s *TradeService) RequestCustomerDelete(userID, customerID int64, input *model.TradeCustomerDeleteRequestInput) (*model.TradeCustomerDeleteRequest, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewCustomers {
		return nil, fmt.Errorf("当前岗位没有访问客户资料的权限")
	}
	customer, err := s.repo.GetCustomer(customerID, userID, access.profile.CanViewAllOrders)
	if err != nil {
		return nil, err
	}
	reason := ""
	if input != nil {
		reason = strings.TrimSpace(input.Reason)
	}
	if reason == "" {
		return nil, fmt.Errorf("请填写删除客户的原因，便于管理员审批")
	}
	if len(reason) > 2000 {
		return nil, fmt.Errorf("删除原因不能超过 2000 个字符")
	}
	if existing, existingErr := s.repo.GetPendingCustomerDeleteRequest(customerID); existingErr == nil {
		return existing, nil
	} else if !errors.Is(existingErr, sql.ErrNoRows) {
		return nil, existingErr
	}
	request, err := s.repo.CreateCustomerDeleteRequest(customerID, userID, reason)
	if err != nil {
		return nil, err
	}
	s.notifyCustomerDeleteRequested(customer, request)
	return request, nil
}

func (s *TradeService) DecideCustomerDeleteRequest(userID, requestID int64, input *model.TradeCustomerDeleteDecisionInput) (*model.TradeCustomerDeleteRequest, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, fmt.Errorf("仅管理员可以审批客户删除申请")
	}
	if input == nil {
		return nil, fmt.Errorf("审批内容不能为空")
	}
	decision := strings.ToLower(strings.TrimSpace(input.Decision))
	if decision != "approve" && decision != "reject" {
		return nil, fmt.Errorf("审批决定仅支持 approve/reject")
	}
	comment := strings.TrimSpace(input.Comment)
	if len(comment) > 2000 {
		return nil, fmt.Errorf("审批意见不能超过 2000 个字符")
	}
	request, err := s.repo.DecideCustomerDeleteRequest(requestID, userID, decision, comment)
	if err != nil {
		return nil, err
	}
	s.notifyCustomerDeleteDecision(request)
	return request, nil
}

func (s *TradeService) DeleteCustomer(userID, customerID int64) (*model.TradeCustomerDeleteRequest, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, fmt.Errorf("删除客户需要管理员审批，请先提交删除申请")
	}
	if _, err := s.repo.GetCustomer(customerID, userID, true); err != nil {
		return nil, err
	}
	request, err := s.repo.AdminDeleteCustomer(customerID, userID)
	if err != nil {
		return nil, err
	}
	if request.RequestedBy != nil && *request.RequestedBy != userID {
		s.notifyCustomerDeleteDecision(request)
	}
	return request, nil
}

func (s *TradeService) notifyCustomerDeleteRequested(customer *model.TradeCustomer, request *model.TradeCustomerDeleteRequest) {
	if customer == nil || request == nil || s.automationRepo == nil || s.userRepo == nil {
		return
	}
	adminIDs, err := s.userRepo.ListAdminIDs()
	if err != nil || len(adminIDs) == 0 {
		return
	}
	metadata, _ := json.Marshal(map[string]any{
		"request_id": request.ID, "customer_id": customer.ID, "customer_code": customer.CustomerCode,
	})
	entityID := request.ID
	createdFor, err := s.automationRepo.CreateNotifications(adminIDs, model.UserNotification{
		NotificationType: "trade_customer_delete", Title: "客户删除申请：" + customer.Name,
		Content: request.RequesterName + " 申请删除客户 " + customer.CustomerCode + "，请进入外贸客户列表审批。",
		LinkURL: "/trade", EntityType: "trade_customer_delete_request", EntityID: &entityID, Metadata: metadata,
	})
	if err == nil && len(createdFor) > 0 && s.notificationHook != nil {
		go s.notificationHook(createdFor)
	}
}

func (s *TradeService) notifyCustomerDeleteDecision(request *model.TradeCustomerDeleteRequest) {
	if request == nil || request.RequestedBy == nil || s.automationRepo == nil {
		return
	}
	statusLabel := "已拒绝"
	if request.Status == "approved" {
		statusLabel = "已同意"
	}
	metadata, _ := json.Marshal(map[string]any{
		"request_id": request.ID, "customer_id": request.CustomerID, "status": request.Status,
	})
	entityID := request.ID
	createdFor, err := s.automationRepo.CreateNotifications([]int64{*request.RequestedBy}, model.UserNotification{
		NotificationType: "trade_customer_delete", Title: "客户删除申请" + statusLabel,
		Content: fmt.Sprintf("客户 %s（%s）的删除申请%s。", request.CustomerName, request.CustomerCode, statusLabel),
		LinkURL: "/trade", EntityType: "trade_customer_delete_request", EntityID: &entityID, Metadata: metadata,
	})
	if err == nil && len(createdFor) > 0 && s.notificationHook != nil {
		go s.notificationHook(createdFor)
	}
}

func (s *TradeService) getCustomer(userID, customerID int64) (*model.TradeCustomer, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewCustomers {
		return nil, sql.ErrNoRows
	}
	return s.repo.GetCustomer(customerID, userID, access.profile.CanViewAllOrders)
}

func (s *TradeService) ListOrders(userID int64, filter model.TradeOrderFilter) ([]model.TradeOrder, error) {
	if filter.Stage != "" && !validTradeStage(filter.Stage) {
		return nil, fmt.Errorf("无效的业务阶段")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	orders, err := s.repo.ListOrdersScoped(userID, access.profile.CanViewAllOrders, tradeOrderScopeStages(access), filter)
	if err != nil {
		return nil, err
	}
	for index := range orders {
		s.enrichOrderPermissions(userID, &orders[index])
		if err := s.redactTradeOrder(userID, &orders[index], access); err != nil {
			return nil, err
		}
	}
	return orders, nil
}

func (s *TradeService) GetOrder(userID, orderID int64) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return nil, sql.ErrNoRows
	}
	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	events, err := s.repo.ListOrderEvents(orderID)
	if err != nil {
		return nil, err
	}
	customer, err := s.repo.GetCustomerIncludingDeleted(order.CustomerID, userID, true)
	if err != nil {
		return nil, err
	}
	order.Items = items
	order.Events = events
	order.Customer = customer
	order.ProfitSummary = buildTradeProfitSummary(order, items)
	if quotes, quoteErr := s.repo.ListSupplierQuotes(orderID); quoteErr == nil {
		order.SupplierQuotes = quotes
	} else {
		return nil, quoteErr
	}
	if customerQuotes, quoteErr := s.repo.ListCustomerQuoteRounds(orderID); quoteErr == nil {
		for index := range customerQuotes {
			if attachmentID := customerQuotes[index].PIBankDetailsImageAttachmentID; attachmentID != nil {
				customerQuotes[index].PIBankDetailsImageURL, _ = s.uploadSvc.GetFileURL(*attachmentID)
			}
		}
		order.CustomerQuotes = customerQuotes
	} else {
		return nil, quoteErr
	}
	if proofs, proofErr := s.repo.ListPaymentProofs(orderID); proofErr == nil {
		proofsByQuote := make(map[int64][]model.TradePaymentProof)
		for index := range proofs {
			proofs[index].AttachmentURL, _ = s.uploadSvc.GetFileURL(proofs[index].AttachmentID)
			proofs[index].ThumbnailURL = s.uploadSvc.GetThumbnailURL(proofs[index].AttachmentID, 480)
			proofsByQuote[proofs[index].QuoteID] = append(proofsByQuote[proofs[index].QuoteID], proofs[index])
		}
		for index := range order.CustomerQuotes {
			order.CustomerQuotes[index].PaymentProofs = proofsByQuote[order.CustomerQuotes[index].ID]
		}
	} else {
		return nil, proofErr
	}
	if photos, photoErr := s.repo.ListInspectionPhotos(orderID); photoErr == nil {
		for index := range photos {
			photos[index].AttachmentURL, _ = s.uploadSvc.GetFileURL(photos[index].AttachmentID)
			photos[index].ThumbnailURL = s.uploadSvc.GetThumbnailURL(photos[index].AttachmentID, 480)
		}
		order.InspectionPhotos = photos
	} else {
		return nil, photoErr
	}
	if shipment, shipmentErr := s.repo.GetShipment(orderID); shipmentErr == nil {
		order.Shipment = shipment
	} else if !errors.Is(shipmentErr, sql.ErrNoRows) {
		return nil, shipmentErr
	}
	if groups, packingErr := s.repo.ListPackingGroups(orderID); packingErr == nil {
		order.PackingGroups = groups
	} else {
		return nil, packingErr
	}
	s.enrichOrderPermissions(userID, order)
	if err := s.redactTradeOrder(userID, order, access); err != nil {
		return nil, err
	}
	return order, nil
}

func (s *TradeService) UpdateProfitSettings(userID, orderID int64, request *model.UpdateTradeProfitSettingsRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("利润设置不能为空")
	}
	if request.AdditionalCostAmount < 0 {
		return nil, fmt.Errorf("附加成本不能小于零")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewAllOrders {
		return nil, fmt.Errorf("仅管理员或业务负责人可以维护订单利润")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	itemsByID := make(map[int64]*model.TradeOrderItem, len(items))
	for index := range items {
		itemsByID[items[index].ID] = &items[index]
	}
	for _, input := range request.ItemRates {
		item := itemsByID[input.OrderItemID]
		if item == nil {
			return nil, fmt.Errorf("产品不属于当前业务单")
		}
		if input.Rate < 0 {
			return nil, fmt.Errorf("成本换算率不能小于零")
		}
		if item.WorkflowData == nil {
			item.WorkflowData = map[string]any{}
		}
		if input.Rate == 0 {
			delete(item.WorkflowData, "cost_exchange_rate")
		} else {
			item.WorkflowData["cost_exchange_rate"] = input.Rate
		}
		if err := s.repo.UpsertOrderItemFromWorkbook(item); err != nil {
			return nil, err
		}
	}
	if err := s.repo.UpdateOrderProfitSettings(orderID, request.AdditionalCostAmount, request.AdditionalCostNotes); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		if syncErr := s.syncOrderWorkspaceInternal(userID, orderID); syncErr != nil {
			log.Printf("sync profit settings for trade order %d: %v", orderID, syncErr)
		}
	} else {
		s.notifyOrderUpdated(orderID)
	}
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) DeleteOrder(userID, orderID int64) error {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return err
	}
	if !admin {
		return fmt.Errorf("仅管理员可以删除业务订单")
	}
	if _, err := s.repo.GetOrder(orderID, userID, true); err != nil {
		return err
	}
	if err := s.repo.SoftDeleteOrder(orderID, userID); err != nil {
		return err
	}
	s.notifyOrderUpdated(orderID)
	return nil
}

func (s *TradeService) CreateOrder(userID int64, request *model.CreateTradeOrderRequest) (*model.TradeOrder, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanCreateOrders {
		return nil, fmt.Errorf("当前岗位没有创建客户询价的权限")
	}
	if request == nil || request.CustomerID <= 0 {
		return nil, fmt.Errorf("请选择客户")
	}
	if strings.TrimSpace(request.Title) == "" {
		return nil, fmt.Errorf("请输入询价主题")
	}
	if len(request.Items) == 0 {
		return nil, fmt.Errorf("至少添加一个询价产品")
	}
	customer, err := s.getCustomer(userID, request.CustomerID)
	if err != nil {
		return nil, fmt.Errorf("客户不存在或无权访问")
	}
	workspaceFolderID := request.WorkbookFolderID
	if workspaceFolderID == nil {
		workspaceFolderID = customer.WorkbookFolderID
	}
	if err := s.ensureWritableTradeFolder(userID, workspaceFolderID); err != nil {
		return nil, err
	}
	quoteDeadline, err := parseTradeDate(request.QuoteDeadline)
	if err != nil {
		return nil, fmt.Errorf("报价截止日期格式无效")
	}
	priority := strings.ToLower(strings.TrimSpace(request.Priority))
	if priority == "" {
		priority = "normal"
	}
	if priority != "low" && priority != "normal" && priority != "high" && priority != "urgent" {
		return nil, fmt.Errorf("无效的优先级")
	}
	items, err := buildTradeOrderItems(request.Items)
	if err != nil {
		return nil, err
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if currency == "" {
		currency = "USD"
	}
	paymentMethod := strings.TrimSpace(request.PaymentMethod)
	if paymentMethod == "" {
		paymentMethod = strings.TrimSpace(request.PaymentTerms)
	}
	destination := mergeTradeDestination(request.DestinationCountry, request.DestinationPort)
	order := &model.TradeOrder{
		CustomerID: customer.ID, CustomerName: customer.Name, CustomerCompany: customer.CompanyName,
		OwnerID: customer.OwnerID, OwnerName: customer.OwnerName, Title: strings.TrimSpace(request.Title),
		Priority: priority, InquiryDate: time.Now(), QuoteDeadline: quoteDeadline,
		Currency: currency, Incoterm: "", DestinationCountry: destination,
		DestinationPort: "", PaymentTerms: paymentMethod, PaymentMethod: paymentMethod,
		ChannelID: customer.ChannelID, WorkspaceFolderID: workspaceFolderID, Notes: strings.TrimSpace(request.Notes),
	}
	if err := s.repo.CreateOrder(order, items); err != nil {
		return nil, err
	}
	if request.WorkbookFolderID != nil {
		if err := s.repo.SetCustomerWorkbookFolder(customer.ID, request.WorkbookFolderID); err != nil {
			_ = s.repo.DeleteOrderAfterCreateFailure(order.ID, order.OwnerID)
			return nil, err
		}
		customer.WorkbookFolderID = request.WorkbookFolderID
	}

	createWorkspace := request.CreateWorkspace == nil || *request.CreateWorkspace
	sharedWorkspace := request.SharedWorkspace == nil || *request.SharedWorkspace
	if createWorkspace {
		workbook, firstSheetID, workspaceErr := s.createOrderWorkspace(userID, order, customer, items, sharedWorkspace)
		if workspaceErr != nil {
			_ = s.repo.DeleteOrderAfterCreateFailure(order.ID, order.OwnerID)
			return nil, workspaceErr
		}
		order.WorkbookID = &workbook.ID
		order.WorkbookSheetID = &firstSheetID
		if err := s.repo.SetOrderWorkspace(order.ID, order.OwnerID, workbook.ID, order.WorkspaceFolderID); err != nil {
			_ = s.sheetSvc.DeleteWorkbookForUser(userID, workbook.ID)
			_ = s.repo.DeleteOrderAfterCreateFailure(order.ID, order.OwnerID)
			return nil, err
		}
		if order.ChannelID != nil {
			_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
				Content:          fmt.Sprintf("已创建外贸业务单 %s：%s。当前阶段：询价。", order.OrderNo, order.Title),
				LinkedWorkbookID: &workbook.ID,
				InternalOnly:     true,
			})
		}
	}
	s.notifyStageAssignees(order, model.TradeStageInquiry, "新的客户询价待处理")
	s.notifyOrderUpdated(order.ID)
	return s.GetOrder(userID, order.ID)
}

func (s *TradeService) AddOrderItems(userID, orderID int64, request *model.AddTradeOrderItemsRequest) (*model.TradeOrder, error) {
	if request == nil || len(request.Items) == 0 {
		return nil, fmt.Errorf("请至少添加一个产品")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	userAccess, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, userAccess) {
		return nil, sql.ErrNoRows
	}
	orderAccess, err := s.orderAccessForUser(userID, order, userAccess)
	if err != nil {
		return nil, err
	}
	if !orderAccess.CanAddItems {
		return nil, fmt.Errorf("当前阶段不能直接新增产品，请先将流程退回报价环节或联系业务负责人")
	}
	items, err := buildTradeOrderItems(request.Items)
	if err != nil {
		return nil, err
	}
	if err := s.repo.AddOrderItems(orderID, items); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		if syncErr := s.syncOrderWorkspaceInternal(userID, orderID); syncErr != nil {
			log.Printf("sync added items for trade order %d: %v", orderID, syncErr)
		}
	}
	if order.ChannelID != nil {
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:      fmt.Sprintf("业务单 %s 新增 %d 个产品，流程工作表已更新。", order.OrderNo, len(items)),
			InternalOnly: true,
		})
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) DeleteOrderItem(userID, orderID, itemID int64) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	userAccess, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, userAccess) {
		return nil, sql.ErrNoRows
	}
	orderAccess, err := s.orderAccessForUser(userID, order, userAccess)
	if err != nil {
		return nil, err
	}
	if !orderAccess.CanAddItems {
		return nil, fmt.Errorf("当前阶段不能删除产品，请先将流程退回询价或报价环节")
	}
	var customerQuotes []model.TradeCustomerQuoteRound
	if order.Stage == model.TradeStageQuotation {
		quotes, quoteErr := s.repo.ListCustomerQuoteRounds(orderID)
		if quoteErr != nil {
			return nil, quoteErr
		}
		customerQuotes = quotes
	}
	if err := validateTradeOrderItemDeletion(order.Stage, customerQuotes); err != nil {
		return nil, err
	}
	item, err := s.repo.GetOrderItem(orderID, itemID)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	if err := s.repo.DeleteOrderItem(orderID, itemID); err != nil {
		if errors.Is(err, repo.ErrLastTradeOrderItem) {
			return nil, fmt.Errorf("订单至少需要保留一个产品，不能删除最后一项")
		}
		return nil, err
	}
	if order.WorkbookID != nil {
		if syncErr := s.syncOrderWorkspaceInternal(userID, orderID); syncErr != nil {
			log.Printf("sync deleted item for trade order %d: %v", orderID, syncErr)
		}
	}
	if order.ChannelID != nil {
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:      fmt.Sprintf("业务单 %s 删除产品：%s，流程工作表已更新。", order.OrderNo, firstNonEmptyTrade(item.SKU, item.ProductName)),
			InternalOnly: true,
		})
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func validateTradeOrderItemDeletion(stage string, quotes []model.TradeCustomerQuoteRound) error {
	if stage != model.TradeStageInquiry && stage != model.TradeStageSupplierQuote && stage != model.TradeStageQuotation {
		return fmt.Errorf("只有询价、供应商询价和对客报价阶段可以删除产品")
	}
	for _, quote := range quotes {
		if quote.Status == "accepted" {
			return fmt.Errorf("客户已经接受报价，不能删除产品；请先退回并作废已接受的报价")
		}
	}
	return nil
}

func (s *TradeService) UpdateStageData(userID, orderID int64, request *model.UpdateTradeStageDataRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("环节数据不能为空")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	canOperate, position, err := s.canOperateStage(userID, order)
	if err != nil {
		return nil, err
	}
	if !canOperate {
		positionName := "当前环节负责人"
		if position != nil {
			positionName = position.Name
		}
		return nil, fmt.Errorf("当前阶段由%s处理，您不能修改本环节数据", positionName)
	}
	if order.Stage == model.TradeStageSupplierQuote || order.Stage == model.TradeStageQuotation {
		return nil, fmt.Errorf("当前环节请使用供应商报价或对客报价功能维护数据")
	}
	if order.Stage == model.TradeStageCompleted || order.Stage == model.TradeStageCancelled {
		return nil, fmt.Errorf("已结束业务单不能继续修改环节数据")
	}

	if order.Stage == model.TradeStageShipment {
		if request.Shipment == nil {
			return nil, fmt.Errorf("请填写发货跟踪数据")
		}
		shipment := &model.TradeShipment{
			OrderID: orderID, BookingNo: strings.TrimSpace(request.Shipment.BookingNo),
			Carrier: strings.TrimSpace(request.Shipment.Carrier), VesselFlight: strings.TrimSpace(request.Shipment.VesselFlight),
			BLNo: strings.TrimSpace(request.Shipment.BLNo), ShippingStatus: normalizeTradeShippingStatus(request.Shipment.ShippingStatus),
			ActualFreightCurrency:  strings.ToUpper(strings.TrimSpace(request.Shipment.ActualFreightCurrency)),
			ActualFreightAmount:    nonNegativeTradeValue(request.Shipment.ActualFreightAmount),
			ActualFreightToCNYRate: nonNegativeTradeValue(request.Shipment.ActualFreightToCNYRate),
			ActualFreightNotes:     strings.TrimSpace(request.Shipment.ActualFreightNotes), Notes: strings.TrimSpace(request.Shipment.Notes),
		}
		if shipment.ActualFreightCurrency == "" {
			shipment.ActualFreightCurrency = "CNY"
		}
		if strings.EqualFold(shipment.ActualFreightCurrency, "CNY") {
			shipment.ActualFreightToCNYRate = 1
		}
		if order.FreightMode == "customer_forwarder" {
			shipment.ActualFreightAmount = 0
			shipment.ActualFreightToCNYRate = 1
			shipment.ActualFreightNotes = "客户自有货代，无我方运费"
		} else if shipment.ActualFreightAmount > 0 && shipment.ActualFreightToCNYRate <= 0 {
			return nil, fmt.Errorf("实际运费为外币时必须填写兑人民币汇率")
		}
		shipment.ETD, err = parseTradeDate(request.Shipment.ETD)
		if err != nil {
			return nil, fmt.Errorf("ETD 日期格式无效")
		}
		shipment.ETA, err = parseTradeDate(request.Shipment.ETA)
		if err != nil {
			return nil, fmt.Errorf("ETA 日期格式无效")
		}
		if err := s.repo.UpsertShipment(shipment); err != nil {
			return nil, err
		}
	} else {
		if len(request.Items) == 0 {
			return nil, fmt.Errorf("请填写至少一项产品的环节数据")
		}
		seen := make(map[int64]struct{}, len(request.Items))
		for _, input := range request.Items {
			if input.OrderItemID <= 0 {
				return nil, fmt.Errorf("产品编号无效")
			}
			if _, exists := seen[input.OrderItemID]; exists {
				return nil, fmt.Errorf("同一产品不能重复提交")
			}
			seen[input.OrderItemID] = struct{}{}
			item, itemErr := s.repo.GetOrderItem(orderID, input.OrderItemID)
			if itemErr != nil {
				return nil, fmt.Errorf("产品不存在或不属于当前业务单")
			}
			if err := applyTradeStageItemUpdate(order.Stage, item, &input); err != nil {
				return nil, fmt.Errorf("第 %d 行：%w", item.LineNo, err)
			}
			if err := s.repo.UpsertOrderItemFromWorkbook(item); err != nil {
				return nil, err
			}
		}
	}
	if err := s.repo.RecalculateOrderTotal(orderID); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		if err := s.syncOrderWorkspaceInternal(userID, orderID); err != nil {
			return nil, err
		}
	} else {
		s.notifyOrderUpdated(orderID)
	}
	return s.GetOrder(userID, orderID)
}

func applyTradeStageItemUpdate(stage string, item *model.TradeOrderItem, input *model.UpdateTradeStageItemRequest) error {
	if item == nil || input == nil {
		return fmt.Errorf("产品数据不能为空")
	}
	if item.WorkflowData == nil {
		item.WorkflowData = map[string]any{}
	}
	switch stage {
	case model.TradeStageInquiry:
		if strings.TrimSpace(input.ProductName) == "" {
			return fmt.Errorf("产品名称不能为空")
		}
		if input.Quantity <= 0 {
			return fmt.Errorf("数量必须大于零")
		}
		item.SKU = strings.TrimSpace(input.SKU)
		item.ProductName = strings.TrimSpace(input.ProductName)
		item.Description = strings.TrimSpace(input.Description)
		item.Specification = strings.TrimSpace(input.Specification)
		item.Quantity = input.Quantity
		item.Unit = firstNonEmptyTrade(strings.TrimSpace(input.Unit), "件")
		item.TargetPrice = nonNegativeTradeValue(input.TargetPrice)
		inquiryStatus := firstNonEmptyTrade(strings.TrimSpace(input.Status), "待询价")
		setTradeWorkflowValue(item, "inquiry_status", inquiryStatus)
		item.Status = inquiryStatus
	case model.TradeStagePurchase:
		item.SupplierName = strings.TrimSpace(input.SupplierName)
		item.PurchaseCurrency = strings.ToUpper(strings.TrimSpace(input.PurchaseCurrency))
		item.PurchasePrice = nonNegativeTradeValue(input.PurchasePrice)
		copyTradeWorkflowFields(item.WorkflowData, input.WorkflowData, "purchase_status", "cost_exchange_rate")
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "purchase_status"), item.Status)
	case model.TradeStageReceiving:
		item.ReceivedQuantity = nonNegativeTradeValue(input.ReceivedQuantity)
		copyTradeWorkflowFields(item.WorkflowData, input.WorkflowData, "warehouse_location", "received_date", "receipt_status")
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "receipt_status"), item.Status)
	case model.TradeStageInspection:
		item.AcceptedQuantity = nonNegativeTradeValue(input.AcceptedQuantity)
		copyTradeWorkflowFields(item.WorkflowData, input.WorkflowData, "sample_qty", "inspection_result", "inspection_issue", "inspector", "inspection_date")
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "inspection_result"), item.Status)
	case model.TradeStagePacking:
		item.PackedQuantity = nonNegativeTradeValue(input.PackedQuantity)
		item.CartonCount = max(0, input.CartonCount)
		item.HSCode = strings.TrimSpace(input.HSCode)
		item.GrossWeight = nonNegativeTradeValue(input.GrossWeight)
		item.NetWeight = nonNegativeTradeValue(input.NetWeight)
		copyTradeWorkflowFields(item.WorkflowData, input.WorkflowData, "carton_no", "carton_size", "marks")
	default:
		return fmt.Errorf("当前环节没有可直接维护的产品数据")
	}
	return nil
}

func copyTradeWorkflowFields(target, source map[string]any, keys ...string) {
	if target == nil || source == nil {
		return
	}
	for _, key := range keys {
		value, exists := source[key]
		if !exists {
			continue
		}
		if text, ok := value.(string); ok {
			target[key] = strings.TrimSpace(text)
			continue
		}
		target[key] = value
	}
}

func nonNegativeTradeValue(value float64) float64 {
	if value < 0 {
		return 0
	}
	return value
}

func buildTradeProfitSummary(order *model.TradeOrder, items []model.TradeOrderItem) *model.TradeProfitSummary {
	if order == nil {
		return &model.TradeProfitSummary{CostComplete: false, Warnings: []string{"业务单不存在"}}
	}
	currency := strings.ToUpper(firstNonEmptyTrade(order.Currency, "未设置"))
	summary := &model.TradeProfitSummary{
		Currency: currency, AdditionalCost: nonNegativeTradeValue(order.AdditionalCostAmount),
		AdditionalCostNotes: strings.TrimSpace(order.AdditionalCostNotes), CostComplete: true, CNYComplete: true,
		Warnings: []string{}, Lines: make([]model.TradeProfitLine, 0, len(items)),
	}
	warnings := make(map[string]struct{})
	addWarning := func(message string) {
		if _, exists := warnings[message]; exists {
			return
		}
		warnings[message] = struct{}{}
		summary.Warnings = append(summary.Warnings, message)
	}
	quoteRateCNY := nonNegativeTradeValue(order.QuoteExchangeRateCNY)
	if strings.EqualFold(currency, "CNY") {
		quoteRateCNY = 1
	} else if quoteRateCNY <= 0 {
		summary.CNYComplete = false
		addWarning(fmt.Sprintf("缺少 %s 兑人民币的报价汇率", currency))
	}
	summary.ExchangeRateCNY = quoteRateCNY
	if len(items) == 0 {
		summary.CostComplete = false
		addWarning("订单没有产品明细")
	}
	for _, item := range items {
		lineComplete := true
		quantity := nonNegativeTradeValue(item.Quantity)
		revenue := quantity * nonNegativeTradeValue(item.QuotedPrice)
		if quantity <= 0 {
			lineComplete = false
			addWarning(fmt.Sprintf("第 %d 行尚未录入有效数量", item.LineNo))
		}
		if item.QuotedPrice <= 0 {
			lineComplete = false
			addWarning(fmt.Sprintf("第 %d 行尚未录入对客报价", item.LineNo))
		}
		purchaseCurrency := strings.ToUpper(firstNonEmptyTrade(item.PurchaseCurrency, currency))
		rate := tradeProfitExchangeRate(currency, quoteRateCNY, &item)
		if rate <= 0 {
			lineComplete = false
			addWarning(fmt.Sprintf("第 %d 行缺少 %s 转 %s 的成本换算率", item.LineNo, purchaseCurrency, currency))
		}
		if item.PurchasePrice <= 0 {
			lineComplete = false
			addWarning(fmt.Sprintf("第 %d 行尚未录入采购价", item.LineNo))
		}
		purchaseCost := 0.0
		if rate > 0 {
			purchaseCost = quantity * nonNegativeTradeValue(item.PurchasePrice) * rate
		}
		lineProfit := revenue - purchaseCost
		lineMargin := 0.0
		if revenue != 0 {
			lineMargin = lineProfit / revenue * 100
		}
		summary.GoodsRevenue += revenue
		summary.ProductCost += purchaseCost
		summary.CostComplete = summary.CostComplete && lineComplete
		summary.Lines = append(summary.Lines, model.TradeProfitLine{
			OrderItemID: item.ID, LineNo: item.LineNo, SKU: item.SKU, ProductName: item.ProductName,
			Quantity: quantity, SalesUnitPrice: item.QuotedPrice, Revenue: revenue,
			PurchaseCurrency: purchaseCurrency, PurchaseUnitPrice: item.PurchasePrice,
			CostExchangeRate: rate, PurchaseCost: purchaseCost, ProfitAmount: lineProfit,
			ProfitMargin: lineMargin, CostComplete: lineComplete,
		})
	}
	if order.QuotedGoodsAmount > 0 {
		summary.GoodsRevenue = order.QuotedGoodsAmount
	}
	freightMode := strings.ToLower(firstNonEmptyTrade(order.FreightMode, "customer_forwarder"))
	if freightMode == "quoted" {
		summary.FreightRevenue = nonNegativeTradeValue(order.QuotedFreightAmount)
		if summary.FreightRevenue <= 0 {
			summary.CostComplete = false
			addWarning("已选择我方报价运费，但尚未填写报价运费")
		}
	}
	summary.Revenue = summary.GoodsRevenue + summary.FreightRevenue
	if order.TotalAmount > 0 {
		summary.Revenue = order.TotalAmount
	}
	actualFreightCNY := 0.0
	if freightMode == "quoted" {
		actualCurrency := strings.ToUpper(firstNonEmptyTrade(order.ActualFreightCurrency, "CNY"))
		actualRate := nonNegativeTradeValue(order.ActualFreightToCNYRate)
		if strings.EqualFold(actualCurrency, "CNY") {
			actualRate = 1
		}
		if order.ActualFreightAmount <= 0 {
			summary.CostComplete = false
			if tradeStageAtOrAfter(order.Stage, model.TradeStageShipment) {
				addWarning("尚未录入最终实际运费")
			} else {
				addWarning("实际运费将在发货环节录入，当前运费利润为暂估")
			}
		} else if actualRate <= 0 {
			summary.CostComplete = false
			summary.CNYComplete = false
			addWarning(fmt.Sprintf("缺少实际运费 %s 兑人民币汇率", actualCurrency))
		} else {
			actualFreightCNY = nonNegativeTradeValue(order.ActualFreightAmount) * actualRate
			if quoteRateCNY > 0 {
				summary.ActualFreightCost = actualFreightCNY / quoteRateCNY
			} else {
				summary.CostComplete = false
			}
		}
	}
	summary.TotalCost = summary.ProductCost + summary.AdditionalCost + summary.ActualFreightCost
	summary.GoodsProfit = summary.GoodsRevenue - summary.ProductCost - summary.AdditionalCost
	summary.FreightProfit = summary.FreightRevenue - summary.ActualFreightCost
	summary.ProfitAmount = summary.Revenue - summary.TotalCost
	if summary.Revenue != 0 {
		summary.ProfitMargin = summary.ProfitAmount / summary.Revenue * 100
	}
	if quoteRateCNY > 0 {
		summary.RevenueCNY = summary.Revenue * quoteRateCNY
		summary.FreightRevenueCNY = summary.FreightRevenue * quoteRateCNY
		summary.FreightCostCNY = actualFreightCNY
		summary.FreightProfitCNY = summary.FreightRevenueCNY - actualFreightCNY
		summary.TotalCostCNY = (summary.ProductCost+summary.AdditionalCost)*quoteRateCNY + actualFreightCNY
		summary.ProfitAmountCNY = summary.RevenueCNY - summary.TotalCostCNY
	}
	summary.Finalized = order.Stage == model.TradeStageCompleted && summary.CostComplete && summary.CNYComplete && summary.Revenue > 0
	return summary
}

func tradeStageAtOrAfter(stage, target string) bool {
	stageIndex, targetIndex := -1, -1
	for index, candidate := range tradeStageOrder {
		if candidate == stage {
			stageIndex = index
		}
		if candidate == target {
			targetIndex = index
		}
	}
	return stageIndex >= 0 && targetIndex >= 0 && stageIndex >= targetIndex
}

func tradeProfitExchangeRate(orderCurrency string, quoteRateCNY float64, item *model.TradeOrderItem) float64 {
	rate := tradeWorkflowFloat(item, "cost_exchange_rate")
	if rate > 0 {
		return rate
	}
	if item == nil {
		return 1
	}
	purchaseCurrency := strings.ToUpper(firstNonEmptyTrade(item.PurchaseCurrency, orderCurrency))
	if strings.EqualFold(purchaseCurrency, orderCurrency) {
		return 1
	}
	if purchaseCurrency == "CNY" && quoteRateCNY > 0 {
		return 1 / quoteRateCNY
	}
	return 0
}

func tradeFreightModeLabel(mode string) string {
	if strings.EqualFold(strings.TrimSpace(mode), "quoted") {
		return "我方报价运费"
	}
	return "客户自有货代"
}

func normalizeTradeShippingStatus(status string) string {
	switch strings.TrimSpace(status) {
	case "已发货", "到了", "已离港", "运输中", "已到港", "已签收":
		return "已发货"
	default:
		return "未发货"
	}
}

func (s *TradeService) AdvanceOrder(userID, orderID int64, request *model.AdvanceTradeOrderRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("流程推进参数不能为空")
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	targetStage := strings.TrimSpace(request.ToStage)
	if !validTradeStage(targetStage) {
		return nil, fmt.Errorf("无效的目标阶段")
	}
	if order.Stage == model.TradeStageCompleted || order.Stage == model.TradeStageCancelled {
		if targetStage != prevTradeStage(order.Stage) {
			return nil, fmt.Errorf("当前业务单已经结束，只能退回上一阶段")
		}
	}
	canOperate, position, err := s.canOperateStage(userID, order)
	if err != nil {
		return nil, err
	}
	if !canOperate {
		positionName := "当前环节负责人"
		if position != nil {
			positionName = position.Name
		}
		return nil, fmt.Errorf("当前阶段由%s处理，您没有流转权限", positionName)
	}
	isCancelled := targetStage == model.TradeStageCancelled
	isForward := targetStage == nextTradeStage(order.Stage)
	isBackward := targetStage == prevTradeStage(order.Stage)
	if !isCancelled && !isForward && !isBackward {
		return nil, fmt.Errorf("当前处于%s阶段，只能进入相邻的上一步或下一步", tradeStageLabel(order.Stage))
	}
	if isForward {
		blockers, blockerErr := s.loadTradeOrderAdvanceBlockers(order)
		if blockerErr != nil {
			return nil, blockerErr
		}
		if len(blockers) > 0 {
			return nil, fmt.Errorf("暂不能推进到%s：%s", tradeStageLabel(targetStage), strings.Join(blockers, "；"))
		}
	}
	note := strings.TrimSpace(request.Note)
	if note == "" {
		action := "推进"
		if isBackward {
			action = "退回"
		}
		note = fmt.Sprintf("从%s%s到%s", tradeStageLabel(order.Stage), action, tradeStageLabel(targetStage))
	}
	if err := s.repo.AdvanceOrder(orderID, userID, true, order.Stage, targetStage, note); err != nil {
		return nil, err
	}
	if order.Stage == model.TradeStagePurchase && targetStage == model.TradeStageReceiving && order.ReworkRequired {
		if err := s.repo.ClearOrderRework(orderID); err != nil {
			return nil, err
		}
	}
	if order.WorkbookID != nil {
		if syncErr := s.syncOrderStageToWorkbook(userID, *order.WorkbookID, targetStage); syncErr != nil {
			log.Printf("sync trade order %d stage to workbook: %v", orderID, syncErr)
		}
	}
	if order.ChannelID != nil {
		content := fmt.Sprintf("业务单 %s 已进入【%s】阶段。%s", order.OrderNo, tradeStageLabel(targetStage), note)
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content: content, LinkedWorkbookID: order.WorkbookID, InternalOnly: true,
		})
	}
	s.notifyStageAssignees(order, targetStage, note)
	s.notifyOrderUpdated(orderID)
	updated, loadErr := s.GetOrder(userID, orderID)
	if !errors.Is(loadErr, sql.ErrNoRows) {
		return updated, loadErr
	}
	updated, loadErr = s.repo.GetOrder(orderID, userID, true)
	if loadErr != nil {
		return nil, loadErr
	}
	updated.CustomerID = 0
	updated.CustomerName = "任务已交接"
	updated.CustomerCompany = ""
	updated.ChannelID = nil
	updated.WorkbookSheetID = nil
	updated.Notes = ""
	updated.Access = &model.TradeOrderAccess{ScopeLabel: "任务已交接"}
	return updated, nil
}

func (s *TradeService) createOrderWorkspace(
	actorID int64,
	order *model.TradeOrder,
	customer *model.TradeCustomer,
	items []model.TradeOrderItem,
	shared bool,
) (*model.Workbook, int64, error) {
	description := fmt.Sprintf("外贸业务单 %s · %s · %s", order.OrderNo, customer.Name, order.Title)
	metadata, _ := json.Marshal(map[string]any{
		"tradeErp": map[string]any{
			"version": 2, "order_id": order.ID, "order_no": order.OrderNo,
			"customer_id": customer.ID, "stage": order.Stage,
		},
	})
	workbook := &model.Workbook{
		Name:        fmt.Sprintf("%s %s - %s", order.OrderNo, customer.Name, order.Title),
		Description: &description, OwnerID: order.OwnerID, FolderID: order.WorkspaceFolderID,
		Metadata: metadata, Status: 1,
	}
	if err := s.sheetSvc.CreateWorkbookForUserWithSource(actorID, workbook, "trade_erp", "创建外贸业务工作簿"); err != nil {
		return nil, 0, fmt.Errorf("创建外贸业务工作簿失败：%w", err)
	}
	cleanup := func() {
		if err := s.sheetSvc.DeleteWorkbookForUser(actorID, workbook.ID); err != nil {
			log.Printf("cleanup failed trade workbook %d: %v", workbook.ID, err)
		}
	}
	suppliers, _ := s.repo.ListSuppliers("")
	definitions := tradeWorkbookDefinitionsWithContext(order, customer, items, suppliers, nil, nil, nil)
	var firstSheetID int64
	for index, definition := range definitions {
		columns, _ := json.Marshal(definition.Columns)
		sheet := &model.Sheet{
			WorkbookID: workbook.ID, Name: definition.Name, Columns: columns,
			Frozen: json.RawMessage(`{"row":1,"col":0}`), Config: json.RawMessage(`{}`),
		}
		if err := s.sheetSvc.CreateSheetForUserWithSource(actorID, sheet, "trade_erp", "创建外贸流程工作表"); err != nil {
			cleanup()
			return nil, 0, fmt.Errorf("创建工作表“%s”失败：%w", definition.Name, err)
		}
		if index == 0 {
			firstSheetID = sheet.ID
		}
		if err := s.writeTradeRows(actorID, sheet.ID, definition.Rows); err != nil {
			cleanup()
			return nil, 0, fmt.Errorf("写入工作表“%s”失败：%w", definition.Name, err)
		}
	}
	if shared {
		username := fmt.Sprintf("用户 #%d", actorID)
		if user, err := s.userRepo.GetByID(actorID); err == nil && user != nil && strings.TrimSpace(user.Username) != "" {
			username = user.Username
		}
		if _, err := s.sheetSvc.UpdateWorkbookState(actorID, workbook.ID, username, "publish"); err != nil {
			cleanup()
			return nil, 0, fmt.Errorf("共享外贸业务工作簿失败：%w", err)
		}
	}
	return workbook, firstSheetID, nil
}

func (s *TradeService) writeTradeRows(actorID, sheetID int64, rows []map[string]any) error {
	changes := make([]model.CellUpdate, 0)
	for rowIndex, row := range rows {
		keys := make([]string, 0, len(row))
		for key := range row {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			value, err := json.Marshal(row[key])
			if err != nil {
				return err
			}
			changes = append(changes, model.CellUpdate{SheetID: sheetID, Row: rowIndex, Col: key, Value: value})
		}
	}
	return s.applyTradeCellChanges(actorID, changes)
}

func (s *TradeService) syncOrderStageToWorkbook(actorID, workbookID int64, stage string) error {
	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return err
	}
	for _, sheet := range sheets {
		if sheet.Name != "订单总览" {
			continue
		}
		stageValue, _ := json.Marshal(tradeStageLabel(stage))
		updatedValue, _ := json.Marshal(time.Now().Format("2006-01-02 15:04"))
		return s.applyTradeCellChanges(actorID, []model.CellUpdate{
			{SheetID: sheet.ID, Row: 0, Col: "stage", Value: stageValue},
			{SheetID: sheet.ID, Row: 0, Col: "stage_updated_at", Value: updatedValue},
		})
	}
	return fmt.Errorf("订单总览工作表不存在")
}

func (s *TradeService) ListSuppliers(userID int64, search string) ([]model.TradeSupplier, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanViewSuppliers {
		return []model.TradeSupplier{}, nil
	}
	return s.repo.ListSuppliers(search)
}

func (s *TradeService) CreateSupplier(userID int64, request *model.CreateTradeSupplierRequest) (*model.TradeSupplier, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanManageSuppliers {
		return nil, fmt.Errorf("当前岗位没有维护供应商的权限")
	}
	if request == nil || strings.TrimSpace(request.Name) == "" {
		return nil, fmt.Errorf("供应商名称不能为空")
	}
	currency := strings.ToUpper(strings.TrimSpace(request.DefaultCurrency))
	if currency == "" {
		currency = "CNY"
	}
	supplier := &model.TradeSupplier{
		OwnerID: userID, Name: strings.TrimSpace(request.Name), CompanyName: strings.TrimSpace(request.CompanyName),
		ContactName: strings.TrimSpace(request.ContactName), Phone: strings.TrimSpace(request.Phone),
		Email: strings.TrimSpace(request.Email), WhatsApp: strings.TrimSpace(request.WhatsApp),
		Country: strings.TrimSpace(request.Country), DefaultCurrency: currency,
		PaymentMethod: strings.TrimSpace(request.PaymentMethod), Notes: strings.TrimSpace(request.Notes), Status: "active",
	}
	if supplier.CompanyName == "" {
		supplier.CompanyName = supplier.Name
	}
	if err := s.repo.CreateSupplier(userID, supplier); err != nil {
		return nil, err
	}
	if user, err := s.userRepo.GetByID(userID); err == nil && user != nil {
		supplier.OwnerName = user.Username
	}
	return supplier, nil
}

func defaultTradeSupplierQuoteCurrency(supplier *model.TradeSupplier) string {
	if supplier == nil {
		return "CNY"
	}
	country := strings.ToLower(strings.TrimSpace(supplier.Country))
	domestic := country == "" || country == "cn" || country == "china" || country == "prc" ||
		strings.Contains(country, "中国") || strings.Contains(country, "大陆")
	if domestic {
		return "CNY"
	}
	return strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(supplier.DefaultCurrency), "CNY"))
}

func (s *TradeService) CreateSupplierQuote(userID, orderID int64, request *model.UpsertTradeSupplierQuoteRequest) (*model.TradeOrder, error) {
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
	if request == nil || request.OrderItemID <= 0 || request.SupplierID <= 0 {
		return nil, fmt.Errorf("请选择产品和供应商")
	}
	supplier, err := s.repo.GetSupplier(request.SupplierID)
	if err != nil {
		return nil, fmt.Errorf("供应商不存在")
	}
	validUntil, err := parseTradeDate(request.ValidUntil)
	if err != nil {
		return nil, fmt.Errorf("报价有效期格式无效")
	}
	request.Currency = strings.ToUpper(strings.TrimSpace(request.Currency))
	if request.Currency == "" {
		request.Currency = defaultTradeSupplierQuoteCurrency(supplier)
	}
	request.Notes = strings.TrimSpace(request.Notes)
	if _, err := s.repo.CreateSupplierQuote(orderID, userID, request, validUntil); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) BatchCreateSupplierQuotes(userID, orderID int64, request *model.BatchTradeSupplierQuoteRequest) (*model.TradeOrder, error) {
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
	if request == nil || len(request.Quotes) == 0 {
		return nil, fmt.Errorf("请至少填写一条供应商报价")
	}
	validUntils := make([]*time.Time, len(request.Quotes))
	for index := range request.Quotes {
		quote := &request.Quotes[index]
		if quote.OrderItemID <= 0 || quote.SupplierID <= 0 {
			return nil, fmt.Errorf("第 %d 条报价请选择产品和供应商", index+1)
		}
		if quote.UnitPrice < 0 || quote.MOQ < 0 || quote.LeadTimeDays < 0 {
			return nil, fmt.Errorf("第 %d 条报价的价格、MOQ 或交期不能小于零", index+1)
		}
		supplier, err := s.repo.GetSupplier(quote.SupplierID)
		if err != nil {
			return nil, fmt.Errorf("第 %d 条报价的供应商不存在", index+1)
		}
		validUntil, err := parseTradeDate(quote.ValidUntil)
		if err != nil {
			return nil, fmt.Errorf("第 %d 条报价有效期格式无效", index+1)
		}
		validUntils[index] = validUntil
		quote.Currency = strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(quote.Currency), defaultTradeSupplierQuoteCurrency(supplier)))
		quote.Notes = strings.TrimSpace(quote.Notes)
	}
	if err := s.repo.CreateSupplierQuotes(orderID, userID, request.Quotes, validUntils); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UpdateSupplierQuote(userID, orderID, quoteID int64, request *model.UpsertTradeSupplierQuoteRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageSupplierQuote)
	if err != nil {
		return nil, err
	}
	if !allowed || order.Stage != model.TradeStageSupplierQuote {
		return nil, fmt.Errorf("当前没有编辑供应商报价的权限")
	}
	if request == nil || request.OrderItemID <= 0 || request.SupplierID <= 0 {
		return nil, fmt.Errorf("请选择产品和供应商")
	}
	supplier, err := s.repo.GetSupplier(request.SupplierID)
	if err != nil {
		return nil, fmt.Errorf("供应商不存在")
	}
	validUntil, err := parseTradeDate(request.ValidUntil)
	if err != nil {
		return nil, fmt.Errorf("报价有效期格式无效")
	}
	request.Currency = strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(request.Currency), defaultTradeSupplierQuoteCurrency(supplier)))
	request.Notes = strings.TrimSpace(request.Notes)
	if err := s.repo.UpdateSupplierQuote(orderID, quoteID, request, validUntil); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) DeleteSupplierQuote(userID, orderID, quoteID int64) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageSupplierQuote)
	if err != nil {
		return nil, err
	}
	if !allowed || order.Stage != model.TradeStageSupplierQuote {
		return nil, fmt.Errorf("当前没有删除供应商报价的权限")
	}
	if err := s.repo.DeleteSupplierQuote(orderID, quoteID); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) SelectSupplierQuote(userID, orderID, quoteID int64) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageSupplierQuote)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("没有选择供应商报价的权限")
	}
	if order.Stage != model.TradeStageSupplierQuote {
		return nil, fmt.Errorf("当前业务单不在供应商询价阶段")
	}
	if err := s.repo.SelectSupplierQuote(orderID, quoteID, userID); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) CreateCustomerQuoteRound(userID, orderID int64, request *model.CreateTradeCustomerQuoteRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageQuotation)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("只有对客报价与议价岗位或业务负责人可以创建报价轮次")
	}
	if order.Stage != model.TradeStageQuotation {
		return nil, fmt.Errorf("当前业务单不在对客报价与议价阶段")
	}
	if request == nil {
		return nil, fmt.Errorf("请填写本轮每项产品的对客报价")
	}
	userAccess, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	orderAccess, err := s.orderAccessForUser(userID, order, userAccess)
	if err != nil {
		return nil, err
	}
	profitMarginPercent := 0.0
	if orderAccess.CanViewSupplierPricing {
		profitMarginPercent = nonNegativeTradeValue(request.ProfitMarginPercent)
		if profitMarginPercent > 1000 {
			return nil, fmt.Errorf("成本加价率不能超过 1000%%")
		}
	}
	if len(request.Items) == 0 {
		return nil, fmt.Errorf("请填写本轮每项产品的对客报价")
	}
	status := strings.ToLower(strings.TrimSpace(request.Status))
	if status == "" {
		status = "sent"
	}
	if status != "draft" && status != "sent" {
		return nil, fmt.Errorf("新报价只能保存为草稿或标记为已发送")
	}
	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	inputPrices := make(map[int64]float64, len(request.Items))
	for _, input := range request.Items {
		if input.OrderItemID <= 0 || input.UnitPrice <= 0 {
			return nil, fmt.Errorf("每项产品都必须填写大于零的对客单价")
		}
		if _, exists := inputPrices[input.OrderItemID]; exists {
			return nil, fmt.Errorf("同一产品不能重复报价")
		}
		inputPrices[input.OrderItemID] = input.UnitPrice
	}
	quoteItems := make([]model.TradeCustomerQuoteItem, 0, len(items))
	goodsAmount := 0.0
	for _, item := range items {
		unitPrice, exists := inputPrices[item.ID]
		if !exists {
			return nil, fmt.Errorf("产品 %s 尚未填写对客报价", firstNonEmptyTrade(item.SKU, item.ProductName))
		}
		amount := item.Quantity * unitPrice
		goodsAmount += amount
		quoteItems = append(quoteItems, model.TradeCustomerQuoteItem{
			OrderItemID: item.ID, LineNo: item.LineNo, SKU: item.SKU, ProductName: item.ProductName,
			Quantity: item.Quantity, Unit: item.Unit, UnitPrice: unitPrice, Amount: amount,
		})
	}
	if len(inputPrices) != len(items) {
		return nil, fmt.Errorf("报价中包含不属于该业务单的产品")
	}
	currency := strings.ToUpper(strings.TrimSpace(request.Currency))
	if currency == "" {
		currency = order.Currency
	}
	exchangeRateCNY := nonNegativeTradeValue(request.ExchangeRateCNY)
	if strings.EqualFold(currency, "CNY") {
		exchangeRateCNY = 1
	} else if exchangeRateCNY <= 0 {
		return nil, fmt.Errorf("请填写 1 %s 兑人民币的报价汇率", currency)
	}
	freightMode := strings.ToLower(strings.TrimSpace(request.FreightMode))
	if freightMode == "" {
		freightMode = "customer_forwarder"
	}
	if freightMode != "customer_forwarder" && freightMode != "quoted" {
		return nil, fmt.Errorf("无效的运费方式")
	}
	freightAmount := nonNegativeTradeValue(request.FreightAmount)
	if freightMode == "quoted" && freightAmount <= 0 {
		return nil, fmt.Errorf("选择我方报价运费后，请填写大于零的运费金额")
	}
	if freightMode == "customer_forwarder" {
		freightAmount = 0
	}
	totalAmount := goodsAmount + freightAmount
	round := &model.TradeCustomerQuoteRound{
		OrderID: orderID, Currency: currency, Status: status, GoodsAmount: goodsAmount,
		ExchangeRateCNY: exchangeRateCNY, ProfitMarginPercent: profitMarginPercent,
		FreightMode: freightMode, FreightAmount: freightAmount,
		TotalAmount: totalAmount, TotalAmountCNY: totalAmount * exchangeRateCNY,
		Items: quoteItems, CustomerFeedback: strings.TrimSpace(request.CustomerFeedback),
		Notes: strings.TrimSpace(request.Notes), CreatedBy: userID,
	}
	if err := s.repo.CreateCustomerQuoteRound(round); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	if order.ChannelID != nil {
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:      fmt.Sprintf("业务单 %s 已生成第 %d 轮对客报价，商品 %.2f、运费 %.2f，合计 %s %.2f（约 CNY %.2f）。", order.OrderNo, round.RoundNo, round.GoodsAmount, round.FreightAmount, round.Currency, round.TotalAmount, round.TotalAmountCNY),
			InternalOnly: true,
		})
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UpdateCustomerQuoteRoundStatus(userID, orderID, quoteID int64, request *model.UpdateTradeCustomerQuoteStatusRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageQuotation)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("没有更新对客报价状态的权限")
	}
	if order.Stage != model.TradeStageQuotation {
		return nil, fmt.Errorf("当前业务单不在对客报价与议价阶段")
	}
	if request == nil {
		return nil, fmt.Errorf("报价状态不能为空")
	}
	status := strings.ToLower(strings.TrimSpace(request.Status))
	switch status {
	case "sent", "negotiating", "accepted", "rejected":
	default:
		return nil, fmt.Errorf("无效的报价状态")
	}
	quotes, err := s.repo.ListCustomerQuoteRounds(orderID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, quote := range quotes {
		if quote.ID == quoteID {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("对客报价不存在")
	}
	if status == "accepted" && (len(quotes) == 0 || quotes[0].ID != quoteID) {
		return nil, fmt.Errorf("只能将最新一轮报价标记为客户接受")
	}
	if err := s.repo.UpdateCustomerQuoteRoundStatus(
		orderID, quoteID, status, strings.TrimSpace(request.CustomerFeedback), strings.TrimSpace(request.Notes),
	); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	if order.ChannelID != nil {
		statusText := tradeCustomerQuoteStatusLabel(status)
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:      fmt.Sprintf("业务单 %s 的对客报价已更新为【%s】。", order.OrderNo, statusText),
			InternalOnly: true,
		})
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UpdateCustomerQuotePayment(userID, orderID, quoteID int64, request *model.UpdateTradeCustomerPaymentRequest) (*model.TradeOrder, error) {
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
	orderAccess, err := s.orderAccessForUser(userID, order, access)
	if err != nil {
		return nil, err
	}
	if !orderAccess.CanManagePaymentStatus {
		return nil, fmt.Errorf("没有核对全部付款记录或登记付款金额的权限")
	}
	if request == nil {
		return nil, fmt.Errorf("付款信息不能为空")
	}
	status := strings.ToLower(strings.TrimSpace(request.PaymentStatus))
	if status != "unpaid" && status != "partial" && status != "paid" {
		return nil, fmt.Errorf("付款状态仅支持未付款、部分付款或已付款")
	}
	quotes, err := s.repo.ListCustomerQuoteRounds(orderID)
	if err != nil {
		return nil, err
	}
	var selected *model.TradeCustomerQuoteRound
	for index := range quotes {
		if quotes[index].ID == quoteID {
			selected = &quotes[index]
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("对客报价不存在")
	}
	if selected.Status != "accepted" {
		return nil, fmt.Errorf("只有客户已接受的报价可以登记付款")
	}
	currency := strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(request.PaymentCurrency), selected.Currency, order.Currency, "USD"))
	amount := nonNegativeTradeValue(request.PaidAmount)
	if status == "unpaid" {
		amount = 0
	} else if amount <= 0 {
		return nil, fmt.Errorf("部分付款或已付款时，到账金额必须大于零")
	}
	if err := s.repo.UpdateCustomerQuotePayment(orderID, quoteID, status, currency, amount); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UploadCustomerPaymentProof(userID, orderID, quoteID int64, note string, file multipart.File, header *multipart.FileHeader) (*model.TradePaymentProof, error) {
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
	orderAccess, err := s.orderAccessForUser(userID, order, access)
	if err != nil {
		return nil, err
	}
	if !orderAccess.CanUploadPaymentProofs {
		return nil, fmt.Errorf("没有上传客户付款凭证的权限")
	}
	quotes, err := s.repo.ListCustomerQuoteRounds(orderID)
	if err != nil {
		return nil, err
	}
	found := false
	for _, quote := range quotes {
		if quote.ID == quoteID && quote.Status == "accepted" {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("客户已接受的报价不存在")
	}
	attachment, err := s.uploadSvc.Upload(file, header, userID)
	if err != nil {
		return nil, err
	}
	mimeType := strings.ToLower(strings.TrimSpace(attachment.MimeType))
	isImage := strings.HasPrefix(mimeType, "image/")
	isPDF := mimeType == "application/pdf" || (mimeType == "" && strings.HasSuffix(strings.ToLower(header.Filename), ".pdf"))
	if !isImage && !isPDF {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, fmt.Errorf("付款凭证仅支持图片或 PDF")
	}
	proof := &model.TradePaymentProof{
		OrderID: orderID, QuoteID: quoteID, AttachmentID: attachment.ID,
		Note: strings.TrimSpace(note), UploadedBy: userID,
	}
	if err := s.repo.CreatePaymentProof(proof); err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	if user, userErr := s.userRepo.GetByID(userID); userErr == nil && user != nil {
		proof.UploadedByName = user.Username
	}
	if canonical, canonicalErr := s.uploadSvc.GetAttachment(attachment.ID); canonicalErr == nil {
		proof.Filename = canonical.Filename
		proof.MimeType = canonical.MimeType
		proof.Size = canonical.Size
	}
	proof.AttachmentURL, _ = s.uploadSvc.GetFileURL(attachment.ID)
	proof.ThumbnailURL = s.uploadSvc.GetThumbnailURL(attachment.ID, 480)
	s.notifyOrderUpdated(orderID)
	return proof, nil
}

func (s *TradeService) UploadTradePIBankImage(userID, orderID, quoteID int64, file multipart.File, header *multipart.FileHeader) (*model.TradeOrder, error) {
	order, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	if order.Access == nil || !order.Access.CanGeneratePI {
		return nil, fmt.Errorf("没有修改当前 PI 收款图片的权限")
	}
	if _, err := selectTradePIQuote(order.CustomerQuotes, &model.TradePIRequest{QuoteID: quoteID}); err != nil {
		return nil, err
	}
	if file == nil || header == nil {
		return nil, fmt.Errorf("请选择收款信息图片")
	}
	if header.Size <= 0 {
		return nil, fmt.Errorf("收款信息图片不能为空")
	}
	if header.Size > 20<<20 {
		return nil, fmt.Errorf("收款信息图片不能超过 20MB")
	}
	attachment, err := s.uploadSvc.Upload(file, header, userID)
	if err != nil {
		return nil, err
	}
	mimeType := strings.ToLower(strings.TrimSpace(attachment.MimeType))
	if !strings.HasPrefix(mimeType, "image/") {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, fmt.Errorf("PI 收款信息仅支持图片文件")
	}
	previousAttachmentID, err := s.repo.UpdateCustomerQuotePIBankImage(orderID, quoteID, &attachment.ID)
	if err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	if previousAttachmentID != nil && *previousAttachmentID != attachment.ID {
		_ = s.uploadSvc.DeleteFile(*previousAttachmentID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) RemoveTradePIBankImage(userID, orderID, quoteID int64) (*model.TradeOrder, error) {
	order, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	if order.Access == nil || !order.Access.CanGeneratePI {
		return nil, fmt.Errorf("没有修改当前 PI 收款图片的权限")
	}
	if _, err := selectTradePIQuote(order.CustomerQuotes, &model.TradePIRequest{QuoteID: quoteID}); err != nil {
		return nil, err
	}
	previousAttachmentID, err := s.repo.UpdateCustomerQuotePIBankImage(orderID, quoteID, nil)
	if err != nil {
		return nil, err
	}
	if previousAttachmentID != nil {
		_ = s.uploadSvc.DeleteFile(*previousAttachmentID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) DeleteCustomerPaymentProof(userID, orderID, proofID int64) error {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return err
	}
	if !admin {
		return fmt.Errorf("仅管理员可以删除付款凭证")
	}
	if _, err := s.repo.GetOrder(orderID, userID, true); err != nil {
		return sql.ErrNoRows
	}
	if err := s.repo.SoftDeletePaymentProof(orderID, proofID, userID); err != nil {
		return err
	}
	s.notifyOrderUpdated(orderID)
	return nil
}

func (s *TradeService) ListPositions(userID int64) ([]model.TradePosition, error) {
	positions, err := s.repo.ListPositions()
	if err != nil {
		return nil, err
	}
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if admin {
		return positions, nil
	}
	for index := range positions {
		members := positions[index].Members[:0]
		for _, member := range positions[index].Members {
			if member.UserID == userID {
				members = append(members, member)
			}
		}
		positions[index].Members = members
	}
	return positions, nil
}

func (s *TradeService) UpdatePositionAssignments(userID int64, request *model.TradePositionAssignmentsRequest) ([]model.TradePosition, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, fmt.Errorf("只有管理员可以配置业务职位")
	}
	if request == nil {
		return nil, fmt.Errorf("职位配置不能为空")
	}
	if err := s.repo.SetPositionAssignments(request.Assignments, userID); err != nil {
		return nil, err
	}
	return s.repo.ListPositions()
}

func (s *TradeService) GetSettings(userID int64) (*model.TradeSettings, error) {
	settings, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		settings.PaymentRecordPermissions = []model.TradePaymentRecordPermission{}
	}
	s.hydrateTradePIProfile(&settings.PIProfile)
	return settings, nil
}

func (s *TradeService) UpdateSettings(userID int64, request *model.UpdateTradeSettingsRequest) (*model.TradeSettings, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !admin {
		return nil, fmt.Errorf("只有管理员可以修改外贸业务设置")
	}
	if request == nil {
		return nil, fmt.Errorf("设置不能为空")
	}
	methods := normalizeTradeTextList(request.PaymentMethods, 50)
	if len(methods) == 0 {
		return nil, fmt.Errorf("至少保留一种付款方式")
	}
	current, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	profile := current.PIProfile
	previousBankImageID := profile.BankDetailsImageAttachmentID
	if request.PIProfile != nil {
		profile = *request.PIProfile
	}
	profile = normalizeTradePIProfile(profile)
	if profile.BankDetailsImageAttachmentID != nil {
		attachment, attachmentErr := s.uploadSvc.GetAttachment(*profile.BankDetailsImageAttachmentID)
		if attachmentErr != nil {
			return nil, fmt.Errorf("PI 银行信息图片不存在")
		}
		if !strings.HasPrefix(strings.ToLower(strings.TrimSpace(attachment.MimeType)), "image/") {
			return nil, fmt.Errorf("PI 银行信息仅支持图片文件")
		}
		if attachment.Size > 20<<20 {
			return nil, fmt.Errorf("PI 银行信息图片不能超过 20MB")
		}
	}
	paymentRecordPermissions := current.PaymentRecordPermissions
	if request.PaymentRecordPermissions != nil {
		paymentRecordPermissions, err = s.normalizeTradePaymentRecordPermissions(request.PaymentRecordPermissions)
		if err != nil {
			return nil, err
		}
	}
	if strings.TrimSpace(profile.CompanyName) == "" {
		return nil, fmt.Errorf("PI 公司名称不能为空")
	}
	if strings.TrimSpace(profile.AccountName) == "" {
		profile.AccountName = profile.CompanyName
	}
	settings := &model.TradeSettings{
		PaymentMethods: methods, PaymentRecordPermissions: paymentRecordPermissions, PIProfile: profile,
	}
	if err := s.repo.UpdateSettings(userID, settings); err != nil {
		return nil, err
	}
	if previousBankImageID != nil && (profile.BankDetailsImageAttachmentID == nil || *previousBankImageID != *profile.BankDetailsImageAttachmentID) {
		_ = s.uploadSvc.DeleteFile(*previousBankImageID)
	}
	s.hydrateTradePIProfile(&settings.PIProfile)
	return settings, nil
}

func (s *TradeService) normalizeTradePaymentRecordPermissions(input []model.TradePaymentRecordPermission) ([]model.TradePaymentRecordPermission, error) {
	byUser := make(map[int64]string, len(input))
	for _, permission := range input {
		if permission.UserID <= 0 {
			return nil, fmt.Errorf("付款记录权限包含无效员工")
		}
		user, err := s.userRepo.GetByID(permission.UserID)
		if err != nil || user == nil || user.Status != 1 {
			return nil, fmt.Errorf("付款记录权限员工 #%d 不存在或已停用", permission.UserID)
		}
		byUser[permission.UserID] = normalizeTradePaymentRecordAccess(permission.Access)
	}
	userIDs := make([]int64, 0, len(byUser))
	for userID := range byUser {
		userIDs = append(userIDs, userID)
	}
	sort.Slice(userIDs, func(left, right int) bool { return userIDs[left] < userIDs[right] })
	result := make([]model.TradePaymentRecordPermission, 0, len(userIDs))
	for _, userID := range userIDs {
		result = append(result, model.TradePaymentRecordPermission{UserID: userID, Access: byUser[userID]})
	}
	return result, nil
}

func normalizeTradePIProfile(profile model.TradePIProfile) model.TradePIProfile {
	profile.CompanyName = strings.TrimSpace(profile.CompanyName)
	profile.Address = strings.TrimSpace(profile.Address)
	profile.ContactName = strings.TrimSpace(profile.ContactName)
	profile.Phone = strings.TrimSpace(profile.Phone)
	profile.Email = strings.TrimSpace(profile.Email)
	profile.TaxID = strings.TrimSpace(profile.TaxID)
	profile.BankName = strings.TrimSpace(profile.BankName)
	profile.BankAddress = strings.TrimSpace(profile.BankAddress)
	profile.AccountName = strings.TrimSpace(profile.AccountName)
	profile.AccountNumber = strings.TrimSpace(profile.AccountNumber)
	profile.SwiftCode = strings.ToUpper(strings.TrimSpace(profile.SwiftCode))
	profile.BeneficiaryAddress = strings.TrimSpace(profile.BeneficiaryAddress)
	if profile.BankDetailsImageAttachmentID != nil && *profile.BankDetailsImageAttachmentID <= 0 {
		profile.BankDetailsImageAttachmentID = nil
	}
	profile.BankDetailsImageURL = ""
	profile.DefaultNotes = strings.TrimSpace(profile.DefaultNotes)
	return profile
}

func (s *TradeService) hydrateTradePIProfile(profile *model.TradePIProfile) {
	if profile == nil || profile.BankDetailsImageAttachmentID == nil {
		return
	}
	profile.BankDetailsImageURL, _ = s.uploadSvc.GetFileURL(*profile.BankDetailsImageAttachmentID)
}

func (s *TradeService) UpdateLabelSettings(userID, orderID int64, request *model.UpdateTradeLabelSettingsRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, err
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStagePacking)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("没有修改装箱标签的权限")
	}
	if request == nil || request.WidthMM < 20 || request.HeightMM < 15 || request.WidthMM > 300 || request.HeightMM > 300 {
		return nil, fmt.Errorf("标签尺寸超出允许范围")
	}
	request.PaperSize = strings.ToUpper(strings.TrimSpace(request.PaperSize))
	if request.PaperSize == "" {
		request.PaperSize = "A4"
	}
	request.Orientation = strings.ToLower(strings.TrimSpace(request.Orientation))
	if request.Orientation != "portrait" && request.Orientation != "landscape" {
		return nil, fmt.Errorf("纸张方向仅支持纵向或横向")
	}
	if request.PaperWidthMM < 50 || request.PaperHeightMM < 50 || request.PaperWidthMM > 500 || request.PaperHeightMM > 500 {
		return nil, fmt.Errorf("纸张尺寸超出允许范围")
	}
	pageWidth, pageHeight := request.PaperWidthMM, request.PaperHeightMM
	if request.Orientation == "landscape" {
		pageWidth, pageHeight = pageHeight, pageWidth
	}
	offsetX := request.MarginLeftMM
	if request.OffsetXMM != nil {
		offsetX = *request.OffsetXMM
	}
	offsetY := request.MarginTopMM
	if request.OffsetYMM != nil {
		offsetY = *request.OffsetYMM
	}
	usableWidth := pageWidth - offsetX - request.MarginRightMM
	usableHeight := pageHeight - offsetY - request.MarginBottomMM
	columns := int((usableWidth + request.GapXMM) / (request.WidthMM + request.GapXMM))
	rows := int((usableHeight + request.GapYMM) / (request.HeightMM + request.GapYMM))
	if columns <= 0 || rows <= 0 {
		return nil, fmt.Errorf("当前标签、边距和纸张尺寸无法排入一张标签")
	}
	capacity := columns * rows
	if request.StartSlot >= capacity {
		request.StartSlot = capacity - 1
	}
	if offsetX+request.WidthMM > pageWidth || offsetY+request.HeightMM > pageHeight {
		return nil, fmt.Errorf("标签起始位置超出纸张范围")
	}
	if err := s.repo.UpdateLabelSettings(orderID, request); err != nil {
		return nil, err
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UploadInspectionPhoto(userID, orderID int64, itemID *int64, note string, file multipart.File, header *multipart.FileHeader) (*model.TradeInspectionPhoto, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageInspection)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("只有质检岗位或业务负责人可以上传质检照片")
	}
	if order.Stage != model.TradeStageInspection {
		return nil, fmt.Errorf("当前业务单不在质检阶段")
	}
	if itemID != nil {
		belongs, belongsErr := s.repo.OrderItemBelongsToOrder(orderID, *itemID)
		if belongsErr != nil {
			return nil, belongsErr
		}
		if !belongs {
			return nil, fmt.Errorf("所选产品不属于当前业务单")
		}
	}
	attachment, err := s.uploadSvc.Upload(file, header, userID)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, fmt.Errorf("质检附件必须是图片")
	}
	directoryID := order.InspectionGalleryDirectoryID
	if directoryID == nil {
		visibility := "public"
		directory, createErr := s.uploadSvc.CreateGalleryDirectory(userID, "质检照片 - "+order.OrderNo, nil, &visibility)
		if createErr != nil {
			_ = s.uploadSvc.DeleteFile(attachment.ID)
			return nil, createErr
		}
		directoryID = &directory.ID
		if err := s.repo.SetInspectionGalleryDirectory(orderID, directory.ID); err != nil {
			_ = s.uploadSvc.DeleteFile(attachment.ID)
			return nil, err
		}
	}
	effectiveAttachmentID, duplicate, err := s.uploadSvc.SaveImageToGalleryDeduplicated(attachment.ID, directoryID, nil, userID)
	if err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	if duplicate && effectiveAttachmentID != attachment.ID {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
	}
	photo := &model.TradeInspectionPhoto{
		OrderID: orderID, OrderItemID: itemID, AttachmentID: effectiveAttachmentID,
		GalleryDirectoryID: directoryID, Note: strings.TrimSpace(note), UploadedBy: userID,
	}
	if err := s.repo.CreateInspectionPhoto(photo); err != nil {
		return nil, err
	}
	if user, userErr := s.userRepo.GetByID(userID); userErr == nil && user != nil {
		photo.UploadedByName = user.Username
	}
	canonical, _ := s.uploadSvc.GetAttachment(effectiveAttachmentID)
	if canonical != nil {
		photo.Filename = canonical.Filename
	}
	photo.AttachmentURL, _ = s.uploadSvc.GetFileURL(effectiveAttachmentID)
	photo.ThumbnailURL = s.uploadSvc.GetThumbnailURL(effectiveAttachmentID, 480)
	s.notifyOrderUpdated(orderID)
	return photo, nil
}

func (s *TradeService) LinkInspectionPhotos(userID, orderID int64, request *model.LinkTradeInspectionPhotosRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStageInspection)
	if err != nil {
		return nil, err
	}
	if !allowed || order.Stage != model.TradeStageInspection {
		return nil, fmt.Errorf("当前没有关联质检图片的权限")
	}
	if request == nil || len(request.AttachmentIDs) == 0 {
		return nil, fmt.Errorf("请选择至少一张图库图片")
	}
	if request.OrderItemID != nil {
		belongs, belongsErr := s.repo.OrderItemBelongsToOrder(orderID, *request.OrderItemID)
		if belongsErr != nil {
			return nil, belongsErr
		}
		if !belongs {
			return nil, fmt.Errorf("所选产品不属于当前业务单")
		}
	}
	seen := make(map[int64]struct{}, len(request.AttachmentIDs))
	for _, attachmentID := range request.AttachmentIDs {
		if attachmentID <= 0 {
			continue
		}
		if _, duplicate := seen[attachmentID]; duplicate {
			continue
		}
		seen[attachmentID] = struct{}{}
		allowed, err := s.uploadSvc.CanAccessGalleryImage(userID, attachmentID)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, fmt.Errorf("图库图片 #%d 不存在或无权访问", attachmentID)
		}
		attachment, err := s.uploadSvc.GetAttachment(attachmentID)
		if err != nil || !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
			return nil, fmt.Errorf("图库资源 #%d 不是有效图片", attachmentID)
		}
		photo := &model.TradeInspectionPhoto{
			OrderID: orderID, OrderItemID: request.OrderItemID, AttachmentID: attachmentID,
			Note: strings.TrimSpace(request.Note), UploadedBy: userID,
		}
		if err := s.repo.CreateInspectionPhoto(photo); err != nil {
			return nil, err
		}
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) UpdatePackingGroups(userID, orderID int64, request *model.UpdateTradePackingGroupsRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	allowed, _, err := s.canOperateStageForStage(userID, order, model.TradeStagePacking)
	if err != nil {
		return nil, err
	}
	if !allowed || order.Stage != model.TradeStagePacking {
		return nil, fmt.Errorf("当前没有编辑装箱组合的权限")
	}
	if request == nil || len(request.Groups) == 0 {
		return nil, fmt.Errorf("请至少添加一个装箱组合")
	}
	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return nil, err
	}
	itemByID := make(map[int64]model.TradeOrderItem, len(items))
	for _, item := range items {
		itemByID[item.ID] = item
	}
	packedTotals := make(map[int64]float64)
	groups := make([]model.TradePackingGroup, 0, len(request.Groups))
	for groupIndex, input := range request.Groups {
		if input.LengthCM <= 0 || input.WidthCM <= 0 || input.HeightCM <= 0 || input.WeightKG <= 0 {
			return nil, fmt.Errorf("第 %d 个箱组请填写有效的长、宽、高和实际重量", groupIndex+1)
		}
		if input.Copies <= 0 {
			return nil, fmt.Errorf("第 %d 个箱组的箱数必须大于零", groupIndex+1)
		}
		group := model.TradePackingGroup{
			OrderID: orderID, GroupNo: groupIndex + 1, LengthCM: input.LengthCM, WidthCM: input.WidthCM,
			HeightCM: input.HeightCM, WeightKG: input.WeightKG,
			VolumetricWeightKG: input.LengthCM * input.WidthCM * input.HeightCM / 5000,
			Copies:             input.Copies, Notes: strings.TrimSpace(input.Notes), Items: []model.TradePackingGroupItem{},
		}
		seenItems := make(map[int64]struct{}, len(input.Items))
		for _, itemInput := range input.Items {
			item, exists := itemByID[itemInput.OrderItemID]
			if !exists {
				return nil, fmt.Errorf("第 %d 个箱组包含不属于订单的产品", groupIndex+1)
			}
			if _, duplicate := seenItems[item.ID]; duplicate {
				return nil, fmt.Errorf("第 %d 个箱组中产品 %s 重复", groupIndex+1, firstNonEmptyTrade(item.SKU, item.ProductName))
			}
			if itemInput.Quantity <= 0 {
				return nil, fmt.Errorf("第 %d 个箱组的产品数量必须大于零", groupIndex+1)
			}
			seenItems[item.ID] = struct{}{}
			packedTotals[item.ID] += itemInput.Quantity * float64(input.Copies)
			group.Items = append(group.Items, model.TradePackingGroupItem{
				OrderItemID: item.ID, LineNo: item.LineNo, SKU: item.SKU,
				ProductName: item.ProductName, Quantity: itemInput.Quantity,
			})
		}
		groups = append(groups, group)
	}
	for _, item := range items {
		expected := firstNonZeroTrade(item.AcceptedQuantity, item.ReceivedQuantity, item.Quantity)
		if packedTotals[item.ID] > expected+0.000001 {
			return nil, fmt.Errorf("产品 %s 的装箱数量 %.2f 超过可装数量 %.2f", firstNonEmptyTrade(item.SKU, item.ProductName), packedTotals[item.ID], expected)
		}
	}
	if err := s.repo.ReplacePackingGroups(orderID, groups); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) ReturnOrderToPurchase(userID, orderID int64, request *model.ReturnTradeOrderToPurchaseRequest) (*model.TradeOrder, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, fmt.Errorf("业务单不存在或无权访问")
	}
	if request == nil || strings.TrimSpace(request.Reason) == "" {
		return nil, fmt.Errorf("请填写采购或发货异常原因")
	}
	if order.Stage == model.TradeStageInquiry || order.Stage == model.TradeStageSupplierQuote ||
		order.Stage == model.TradeStageQuotation || order.Stage == model.TradeStagePurchase ||
		order.Stage == model.TradeStageCancelled {
		return nil, fmt.Errorf("当前阶段不能发起重新采购")
	}
	allowed, _, err := s.canOperateStage(userID, order)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("只有当前环节负责人、业务负责人或管理员可以退回采购")
	}
	reason := strings.TrimSpace(request.Reason)
	if err := s.repo.MarkOrderForRepurchase(orderID, userID, reason); err != nil {
		return nil, err
	}
	if order.WorkbookID != nil {
		_ = s.syncOrderWorkspaceInternal(userID, orderID)
	}
	order.Stage = model.TradeStagePurchase
	s.notifyStageAssignees(order, model.TradeStagePurchase, "采购异常待重新处理："+reason)
	s.notifyOrderUpdated(orderID)
	return s.GetOrder(userID, orderID)
}

func (s *TradeService) SyncOrderWorkspace(userID, orderID int64) error {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return err
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return sql.ErrNoRows
	}
	if !access.profile.CanViewAllOrders {
		return fmt.Errorf("没有同步流程工作簿的权限")
	}
	return s.syncOrderWorkspaceInternal(userID, orderID)
}

func (s *TradeService) ensureOrderWorkspace(userID int64, order *model.TradeOrder) error {
	if order == nil {
		return fmt.Errorf("业务单不存在")
	}
	if order.WorkbookID != nil {
		exists, err := s.sheetRepo.ActiveWorkbookExists(*order.WorkbookID)
		if err != nil {
			return err
		}
		if exists {
			return nil
		}
	}
	items, err := s.repo.ListOrderItems(order.ID)
	if err != nil {
		return err
	}
	customer, err := s.repo.GetCustomerIncludingDeleted(order.CustomerID, userID, true)
	if err != nil {
		return err
	}
	if err := s.ensureWritableTradeFolder(userID, order.WorkspaceFolderID); err != nil {
		order.WorkspaceFolderID = nil
	}
	workbook, firstSheetID, err := s.createOrderWorkspace(userID, order, customer, items, true)
	if err != nil {
		return err
	}
	if err := s.repo.SetOrderWorkspace(order.ID, order.OwnerID, workbook.ID, order.WorkspaceFolderID); err != nil {
		_ = s.sheetSvc.DeleteWorkbookForUser(userID, workbook.ID)
		return err
	}
	order.WorkbookID = &workbook.ID
	order.WorkbookSheetID = &firstSheetID
	if order.ChannelID != nil {
		_, _ = s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
			Content:          fmt.Sprintf("业务单 %s 的原流程工作簿不可用，系统已重新创建并完成关联。", order.OrderNo),
			LinkedWorkbookID: &workbook.ID,
			InternalOnly:     true,
		})
	}
	return nil
}

func (s *TradeService) syncOrderWorkspaceInternal(userID, orderID int64) error {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return err
	}
	if err := s.ensureOrderWorkspace(userID, order); err != nil {
		return err
	}
	items, err := s.repo.ListOrderItems(orderID)
	if err != nil {
		return err
	}
	customer, err := s.repo.GetCustomerIncludingDeleted(order.CustomerID, userID, true)
	if err != nil {
		return err
	}
	quotes, err := s.repo.ListSupplierQuotes(orderID)
	if err != nil {
		return err
	}
	shipment, shipmentErr := s.repo.GetShipment(orderID)
	if shipmentErr != nil && !errors.Is(shipmentErr, sql.ErrNoRows) {
		return shipmentErr
	}
	customerQuotes, err := s.repo.ListCustomerQuoteRounds(orderID)
	if err != nil {
		return err
	}
	order.Items = items
	order.Customer = customer
	order.SupplierQuotes = quotes
	order.CustomerQuotes = customerQuotes
	order.Shipment = shipment
	suppliers, _ := s.repo.ListSuppliers("")
	definitions := tradeWorkbookDefinitionsWithContext(order, customer, items, suppliers, quotes, customerQuotes, shipment)
	existingSheets, err := s.sheetRepo.GetSheetsByWorkbook(*order.WorkbookID)
	if err != nil {
		return err
	}
	byName := make(map[string]*model.Sheet, len(existingSheets))
	for index := range existingSheets {
		byName[existingSheets[index].Name] = &existingSheets[index]
	}
	for definitionIndex, definition := range definitions {
		sheet := byName[definition.Name]
		columns, _ := json.Marshal(definition.Columns)
		if sheet == nil {
			sheet = &model.Sheet{WorkbookID: *order.WorkbookID, Name: definition.Name, Columns: columns, Frozen: json.RawMessage(`{"row":1,"col":0}`), Config: json.RawMessage(`{}`)}
			if err := s.sheetSvc.CreateSheetForUserWithSource(userID, sheet, "trade_erp", "补齐外贸流程工作表"); err != nil {
				return err
			}
		}
		sheet.Columns = columns
		sheet.SortOrder = definitionIndex
		if err := s.sheetSvc.UpdateSheetWithSource(userID, sheet, "trade_erp", "同步外贸流程字段", "同步外贸流程工作表", true); err != nil {
			return err
		}
		if err := s.replaceTradeRows(userID, sheet.ID, definition.Columns, definition.Rows); err != nil {
			return err
		}
	}
	s.notifyOrderUpdated(orderID)
	return nil
}

func (s *TradeService) replaceTradeRows(actorID, sheetID int64, columns []map[string]any, desired []map[string]any) error {
	existing, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return err
	}
	columnKeys := make([]string, 0, len(columns))
	for _, column := range columns {
		if key, ok := column["key"].(string); ok && key != "" {
			columnKeys = append(columnKeys, key)
		}
	}
	rowCount := len(desired)
	if len(existing) > rowCount {
		rowCount = len(existing)
	}
	changes := make([]model.CellUpdate, 0, rowCount*len(columnKeys))
	existingValues := make(map[int]map[string]any, len(existing))
	for _, row := range existing {
		var values map[string]any
		if err := json.Unmarshal(row.Data, &values); err != nil {
			return err
		}
		existingValues[row.RowIndex] = values
	}
	for rowIndex := 0; rowIndex < rowCount; rowIndex++ {
		var values map[string]any
		if rowIndex < len(desired) {
			values = desired[rowIndex]
		}
		for _, key := range columnKeys {
			var value any
			if values != nil {
				value = values[key]
			}
			current, currentExists := existingValues[rowIndex][key]
			if values == nil && !currentExists {
				continue
			}
			encoded, err := json.Marshal(value)
			if err != nil {
				return err
			}
			currentEncoded, err := json.Marshal(current)
			if err != nil {
				return err
			}
			if currentExists && string(currentEncoded) == string(encoded) {
				continue
			}
			changes = append(changes, model.CellUpdate{SheetID: sheetID, Row: rowIndex, Col: key, Value: encoded})
		}
	}
	return s.applyTradeCellChanges(actorID, changes)
}

func (s *TradeService) HandleCellChanges(userID int64, changes []model.CellUpdate, source string) {
	if source == "trade_erp" || len(changes) == 0 {
		return
	}
	bySheet := make(map[int64]map[int]struct{})
	for _, change := range changes {
		if bySheet[change.SheetID] == nil {
			bySheet[change.SheetID] = map[int]struct{}{}
		}
		bySheet[change.SheetID][change.Row] = struct{}{}
	}
	for sheetID, rowIndexes := range bySheet {
		orderID, sheetName, err := s.repo.FindOrderBySheetID(sheetID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			log.Printf("resolve trade sheet %d: %v", sheetID, err)
			continue
		}
		handled, matrix, permissionErr := s.TradeSheetPermissionMatrix(userID, sheetID)
		if permissionErr != nil {
			log.Printf("check trade sheet %d permission: %v", sheetID, permissionErr)
			continue
		}
		if handled && (matrix == nil || !matrix.Sheet.CanEdit) {
			log.Printf("ignore unauthorized trade sheet update: user=%d sheet=%d", userID, sheetID)
			continue
		}
		if err := s.syncChangedTradeRows(userID, orderID, sheetID, sheetName, rowIndexes); err != nil {
			log.Printf("sync trade sheet %d to order %d: %v", sheetID, orderID, err)
			continue
		}
	}
}

func (s *TradeService) syncChangedTradeRows(userID, orderID, sheetID int64, sheetName string, rowIndexes map[int]struct{}) error {
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return err
	}
	rowsByIndex := make(map[int]map[string]any, len(rows))
	for _, row := range rows {
		var values map[string]any
		if err := json.Unmarshal(row.Data, &values); err != nil {
			return err
		}
		rowsByIndex[row.RowIndex] = values
	}
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return err
	}
	for rowIndex := range rowIndexes {
		values := rowsByIndex[rowIndex]
		if values == nil {
			continue
		}
		switch sheetName {
		case "订单总览":
			if rowIndex != 0 {
				continue
			}
			order.Priority = tradePriorityValue(tradeString(values["priority"]))
			order.Currency = strings.ToUpper(firstNonEmptyTrade(tradeString(values["currency"]), order.Currency))
			order.DestinationCountry = mergeTradeDestination(
				tradeString(values["destination_country"]),
				tradeString(values["destination_port"]),
			)
			order.DestinationPort = ""
			order.QuoteDeadline, _ = parseTradeDate(tradeString(values["quote_deadline"]))
			order.PaymentMethod = tradeString(values["payment_method"])
			order.Notes = tradeString(values["notes"])
			order.AdditionalCostAmount = nonNegativeTradeValue(tradeFloat(values["additional_cost"]))
			order.AdditionalCostNotes = tradeString(values["additional_cost_notes"])
			if err := s.repo.UpdateOrderFromWorkbook(order); err != nil {
				return err
			}
		case "询价明细", "报价单", "采购跟进", "仓库到货", "质检记录", "装箱清单":
			if err := s.syncTradeItemRow(orderID, rowIndex, sheetName, values); err != nil {
				return err
			}
		case "供应商询价":
			if err := s.syncSupplierQuoteRow(userID, order, rowIndex, values); err != nil {
				return err
			}
		case "发货跟踪":
			shipment := &model.TradeShipment{
				OrderID: orderID, BookingNo: tradeString(values["booking_no"]), Carrier: tradeString(values["carrier"]),
				VesselFlight: tradeString(values["vessel_flight"]), BLNo: tradeString(values["bl_no"]),
				ShippingStatus:         normalizeTradeShippingStatus(tradeString(values["shipping_status"])),
				ActualFreightCurrency:  strings.ToUpper(firstNonEmptyTrade(tradeString(values["actual_freight_currency"]), "CNY")),
				ActualFreightAmount:    nonNegativeTradeValue(tradeFloat(values["actual_freight_amount"])),
				ActualFreightToCNYRate: nonNegativeTradeValue(tradeFloat(values["actual_freight_to_cny_rate"])),
				ActualFreightNotes:     tradeString(values["actual_freight_notes"]), Notes: tradeString(values["notes"]),
			}
			if strings.EqualFold(shipment.ActualFreightCurrency, "CNY") {
				shipment.ActualFreightToCNYRate = 1
			}
			if order.FreightMode == "customer_forwarder" {
				shipment.ActualFreightAmount = 0
				shipment.ActualFreightToCNYRate = 1
			}
			shipment.ETD, _ = parseTradeDate(tradeString(values["etd"]))
			shipment.ETA, _ = parseTradeDate(tradeString(values["eta"]))
			if err := s.repo.UpsertShipment(shipment); err != nil {
				return err
			}
		}
	}
	if err := s.repo.RecalculateOrderTotal(orderID); err != nil {
		return err
	}
	if sheetName == "报价单" {
		if err := s.syncCustomerQuoteStateFromWorkbook(userID, order, rowsByIndex); err != nil {
			return err
		}
	}
	return s.syncOrderWorkspaceInternal(userID, orderID)
}

func (s *TradeService) syncTradeItemRow(orderID int64, rowIndex int, sheetName string, values map[string]any) error {
	lineNo := tradeInt(values["line_no"], rowIndex+1)
	if lineNo <= 0 {
		return nil
	}
	item, err := s.repo.GetOrderItemByLineNo(orderID, lineNo)
	if errors.Is(err, sql.ErrNoRows) {
		item = &model.TradeOrderItem{OrderID: orderID, LineNo: lineNo, Unit: "件", Status: "pending"}
	} else if err != nil {
		return err
	}
	switch sheetName {
	case "询价明细":
		item.SKU = tradeString(values["sku"])
		item.ProductName = tradeString(values["product_name"])
		item.Specification = tradeString(values["specification"])
		item.Quantity = tradeFloat(values["quantity"])
		item.Unit = firstNonEmptyTrade(tradeString(values["unit"]), "件")
		item.TargetPrice = tradeFloat(values["target_price"])
		item.Description = tradeString(values["customer_notes"])
		inquiryStatus := firstNonEmptyTrade(tradeString(values["status"]), "待询价")
		setTradeWorkflowValue(item, "inquiry_status", inquiryStatus)
		item.Status = inquiryStatus
	case "报价单":
		item.QuotedPrice = tradeFloat(values["unit_price"])
		item.Status = firstNonEmptyTrade(tradeString(values["quote_status"]), item.Status)
	case "采购跟进":
		item.SupplierName = tradeString(values["supplier"])
		item.PurchaseCurrency = strings.ToUpper(firstNonEmptyTrade(tradeString(values["purchase_currency"]), item.PurchaseCurrency))
		item.PurchasePrice = tradeFloat(values["purchase_price"])
		setTradeWorkflowValue(item, "purchase_status", tradeString(values["purchase_status"]))
		setTradeWorkflowValue(item, "cost_exchange_rate", nonNegativeTradeValue(tradeFloat(values["cost_exchange_rate"])))
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "purchase_status"), item.Status)
	case "仓库到货":
		item.ReceivedQuantity = tradeFloat(values["received_qty"])
		setTradeWorkflowValue(item, "warehouse_location", tradeString(values["warehouse_location"]))
		setTradeWorkflowValue(item, "received_date", tradeString(values["received_date"]))
		setTradeWorkflowValue(item, "receipt_status", tradeString(values["receipt_status"]))
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "receipt_status"), item.Status)
	case "质检记录":
		item.AcceptedQuantity = tradeFloat(values["passed_qty"])
		setTradeWorkflowValue(item, "sample_qty", tradeFloat(values["sample_qty"]))
		setTradeWorkflowValue(item, "inspection_result", tradeString(values["result"]))
		setTradeWorkflowValue(item, "inspection_issue", tradeString(values["issue"]))
		setTradeWorkflowValue(item, "inspector", tradeString(values["inspector"]))
		setTradeWorkflowValue(item, "inspection_date", tradeString(values["inspection_date"]))
		item.Status = firstNonEmptyTrade(tradeWorkflowString(item, "inspection_result"), item.Status)
	case "装箱清单":
		item.PackedQuantity = tradeFloat(values["quantity"])
		item.CartonCount = tradeInt(values["carton_count"], item.CartonCount)
		item.GrossWeight = tradeFloat(values["gross_weight"])
		item.NetWeight = tradeFloat(values["net_weight"])
		setTradeWorkflowValue(item, "carton_no", tradeString(values["carton_no"]))
		setTradeWorkflowValue(item, "carton_size", tradeString(values["carton_size"]))
		setTradeWorkflowValue(item, "marks", tradeString(values["marks"]))
	}
	return s.repo.UpsertOrderItemFromWorkbook(item)
}

func (s *TradeService) syncCustomerQuoteStateFromWorkbook(userID int64, order *model.TradeOrder, rows map[int]map[string]any) error {
	items, err := s.repo.ListOrderItems(order.ID)
	if err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}
	allConfirmed := true
	anyRejected := false
	anyNegotiating := false
	quoteItems := make([]model.TradeCustomerQuoteItem, 0, len(items))
	for _, item := range items {
		row := rows[item.LineNo-1]
		status := tradeString(row["quote_status"])
		allConfirmed = allConfirmed && status == "客户确认" && item.QuotedPrice > 0
		anyRejected = anyRejected || status == "客户拒绝"
		anyNegotiating = anyNegotiating || status == "客户议价"
		quoteItems = append(quoteItems, model.TradeCustomerQuoteItem{
			OrderItemID: item.ID, LineNo: item.LineNo, SKU: item.SKU, ProductName: item.ProductName,
			Quantity: item.Quantity, Unit: item.Unit, UnitPrice: item.QuotedPrice, Amount: item.Quantity * item.QuotedPrice,
		})
	}
	quotes, err := s.repo.ListCustomerQuoteRounds(order.ID)
	if err != nil {
		return err
	}
	var latest *model.TradeCustomerQuoteRound
	if len(quotes) > 0 {
		latest = &quotes[0]
	}
	if !allConfirmed {
		if latest == nil || latest.Status != "accepted" {
			return nil
		}
		status := "sent"
		if anyRejected {
			status = "rejected"
		} else if anyNegotiating {
			status = "negotiating"
		}
		return s.repo.UpdateCustomerQuoteRoundStatus(order.ID, latest.ID, status, "由报价单工作表更新客户状态", "工作表同步")
	}
	if latest != nil && latest.Status == "accepted" && sameTradeCustomerQuoteItems(latest.Items, quoteItems) &&
		strings.EqualFold(latest.Currency, order.Currency) && latest.ExchangeRateCNY == order.QuoteExchangeRateCNY &&
		latest.FreightMode == order.FreightMode && latest.FreightAmount == order.QuotedFreightAmount {
		return nil
	}
	total := 0.0
	for _, item := range quoteItems {
		total += item.Amount
	}
	exchangeRateCNY := order.QuoteExchangeRateCNY
	if strings.EqualFold(order.Currency, "CNY") {
		exchangeRateCNY = 1
	}
	freightMode := firstNonEmptyTrade(order.FreightMode, "customer_forwarder")
	freightAmount := order.QuotedFreightAmount
	if freightMode == "customer_forwarder" {
		freightAmount = 0
	}
	round := &model.TradeCustomerQuoteRound{
		OrderID: order.ID, Currency: order.Currency, Status: "accepted", GoodsAmount: total,
		ExchangeRateCNY: exchangeRateCNY, FreightMode: freightMode, FreightAmount: freightAmount,
		TotalAmount: total + freightAmount, TotalAmountCNY: (total + freightAmount) * exchangeRateCNY,
		Items: quoteItems, CustomerFeedback: "客户确认工作表报价", Notes: "由报价单工作表同步", CreatedBy: userID,
	}
	return s.repo.CreateCustomerQuoteRound(round)
}

func sameTradeCustomerQuoteItems(left, right []model.TradeCustomerQuoteItem) bool {
	if len(left) != len(right) {
		return false
	}
	byID := make(map[int64]model.TradeCustomerQuoteItem, len(left))
	for _, item := range left {
		byID[item.OrderItemID] = item
	}
	for _, item := range right {
		current, exists := byID[item.OrderItemID]
		if !exists || current.UnitPrice != item.UnitPrice || current.Quantity != item.Quantity {
			return false
		}
	}
	return true
}

func setTradeWorkflowValue(item *model.TradeOrderItem, key string, value any) {
	if item.WorkflowData == nil {
		item.WorkflowData = map[string]any{}
	}
	item.WorkflowData[key] = value
}

func (s *TradeService) syncSupplierQuoteRow(userID int64, order *model.TradeOrder, rowIndex int, values map[string]any) error {
	lineNo := tradeInt(values["line_no"], rowIndex+1)
	supplierName := tradeString(values["supplier"])
	if lineNo <= 0 || supplierName == "" {
		return nil
	}
	item, err := s.repo.GetOrderItemByLineNo(order.ID, lineNo)
	if err != nil {
		return err
	}
	suppliers, err := s.repo.ListSuppliers(supplierName)
	if err != nil {
		return err
	}
	var supplier *model.TradeSupplier
	for index := range suppliers {
		if strings.EqualFold(strings.TrimSpace(suppliers[index].Name), supplierName) || strings.EqualFold(strings.TrimSpace(suppliers[index].CompanyName), supplierName) {
			supplier = &suppliers[index]
			break
		}
	}
	if supplier == nil {
		supplier, err = s.CreateSupplier(userID, &model.CreateTradeSupplierRequest{Name: supplierName, CompanyName: supplierName, DefaultCurrency: order.Currency})
		if err != nil {
			return err
		}
	}
	currency := strings.ToUpper(firstNonEmptyTrade(tradeString(values["currency"]), order.Currency))
	validUntil, _ := parseTradeDate(tradeString(values["valid_until"]))
	quoteID, err := s.repo.UpsertSupplierQuoteFromSheet(
		order.ID, item.ID, supplier.ID, rowIndex, currency, tradeFloat(values["unit_price"]),
		tradeFloat(values["moq"]), tradeInt(values["lead_time_days"], 0), validUntil,
		tradeString(values["notes"]), userID,
	)
	if err != nil {
		return err
	}
	if tradeBool(values["selected"]) {
		return s.repo.SelectSupplierQuote(order.ID, quoteID, userID)
	}
	return nil
}

func (s *TradeService) enrichOrderPermissions(userID int64, order *model.TradeOrder) {
	if order == nil {
		return
	}
	allowed, position, err := s.canOperateStage(userID, order)
	if err == nil {
		order.CanOperateStage = allowed
		if position != nil {
			order.RequiredPositionCode = position.Code
			order.RequiredPositionName = position.Name
		}
	}
	order.AdvanceBlockers = nil
	if order.Items != nil {
		order.AdvanceBlockers = tradeOrderAdvanceBlockers(order)
	}
	order.CanAdvance = allowed && order.Stage != model.TradeStageCancelled && nextTradeStage(order.Stage) != "" && len(order.AdvanceBlockers) == 0
	order.CanReturn = allowed && prevTradeStage(order.Stage) != ""
}

func (s *TradeService) loadTradeOrderAdvanceBlockers(order *model.TradeOrder) ([]string, error) {
	if order == nil || order.ID <= 0 {
		return []string{"业务单数据不完整"}, nil
	}
	if order.Items == nil {
		items, err := s.repo.ListOrderItems(order.ID)
		if err != nil {
			return nil, err
		}
		order.Items = items
	}
	switch order.Stage {
	case model.TradeStageSupplierQuote:
		if order.SupplierQuotes == nil {
			quotes, err := s.repo.ListSupplierQuotes(order.ID)
			if err != nil {
				return nil, err
			}
			order.SupplierQuotes = quotes
		}
	case model.TradeStageQuotation:
		if order.CustomerQuotes == nil {
			quotes, err := s.repo.ListCustomerQuoteRounds(order.ID)
			if err != nil {
				return nil, err
			}
			order.CustomerQuotes = quotes
		}
	case model.TradeStageInspection:
		if order.InspectionPhotos == nil {
			photos, err := s.repo.ListInspectionPhotos(order.ID)
			if err != nil {
				return nil, err
			}
			order.InspectionPhotos = photos
		}
	case model.TradeStageShipment:
		if order.Shipment == nil {
			shipment, err := s.repo.GetShipment(order.ID)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			order.Shipment = shipment
		}
		if order.CustomerQuotes == nil {
			quotes, err := s.repo.ListCustomerQuoteRounds(order.ID)
			if err != nil {
				return nil, err
			}
			proofs, err := s.repo.ListPaymentProofs(order.ID)
			if err != nil {
				return nil, err
			}
			proofsByQuote := make(map[int64][]model.TradePaymentProof)
			for _, proof := range proofs {
				proofsByQuote[proof.QuoteID] = append(proofsByQuote[proof.QuoteID], proof)
			}
			for index := range quotes {
				quotes[index].PaymentProofs = proofsByQuote[quotes[index].ID]
			}
			order.CustomerQuotes = quotes
		}
	}
	return tradeOrderAdvanceBlockers(order), nil
}

func tradeOrderAdvanceBlockers(order *model.TradeOrder) []string {
	if order == nil {
		return []string{"业务单数据不完整"}
	}
	items := order.Items
	if len(items) == 0 {
		return []string{"至少需要一项有效产品"}
	}
	blockers := make([]string, 0, 3)
	switch order.Stage {
	case model.TradeStageInquiry:
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			return strings.TrimSpace(item.ProductName) == "" || item.Quantity <= 0
		}); labels != "" {
			blockers = append(blockers, "产品名称或询价数量不完整："+labels)
		}
	case model.TradeStageSupplierQuote:
		selected := make(map[int64]bool, len(order.SupplierQuotes))
		for _, quote := range order.SupplierQuotes {
			if quote.IsSelected {
				selected[quote.OrderItemID] = true
			}
		}
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			return !selected[item.ID]
		}); labels != "" {
			blockers = append(blockers, "尚未采用供应商报价："+labels)
		}
	case model.TradeStageQuotation:
		accepted := false
		for _, quote := range order.CustomerQuotes {
			if quote.Status == "accepted" {
				accepted = true
				if !strings.EqualFold(quote.Currency, "CNY") && quote.ExchangeRateCNY <= 0 {
					blockers = append(blockers, "客户已接受的报价缺少兑人民币汇率")
				}
				break
			}
		}
		if !accepted {
			blockers = append(blockers, "尚未有客户接受的对客报价；如客户砍价，请记录反馈并创建下一轮报价")
		}
	case model.TradeStagePurchase:
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			return strings.TrimSpace(item.SupplierName) == "" || item.PurchasePrice <= 0 || !tradePurchaseStatusReady(item.Status)
		}); labels != "" {
			blockers = append(blockers, "尚未确认采购下单："+labels)
		}
	case model.TradeStageReceiving:
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			return item.ReceivedQuantity < item.Quantity
		}); labels != "" {
			blockers = append(blockers, "尚未登记全部到货数量："+labels)
		}
	case model.TradeStageInspection:
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			return item.ReceivedQuantity <= 0 || item.AcceptedQuantity < item.ReceivedQuantity
		}); labels != "" {
			blockers = append(blockers, "尚未完成质检合格数量："+labels)
		}
		if len(order.InspectionPhotos) == 0 {
			blockers = append(blockers, "至少上传一张关联订单的质检照片")
		}
	case model.TradeStagePacking:
		if labels := tradeMissingItemLabels(items, func(item model.TradeOrderItem) bool {
			expected := firstNonZeroTrade(item.AcceptedQuantity, item.ReceivedQuantity, item.Quantity)
			return item.PackedQuantity < expected || item.CartonCount <= 0
		}); labels != "" {
			blockers = append(blockers, "尚未完成装箱数量或箱数："+labels)
		}
	case model.TradeStageShipment:
		shipment := order.Shipment
		if shipment == nil {
			blockers = append(blockers, "尚未填写发货跟踪资料")
			break
		}
		carrier := strings.ToUpper(strings.TrimSpace(shipment.Carrier))
		if carrier != "DHL" && carrier != "FEDEX" {
			blockers = append(blockers, "物流公司请选择 DHL 或 FedEx")
		}
		if strings.TrimSpace(shipment.BookingNo) == "" {
			blockers = append(blockers, "请填写物流订单号")
		}
		status := normalizeTradeShippingStatus(shipment.ShippingStatus)
		if status != "已发货" {
			blockers = append(blockers, "物流状态更新为“已发货”后才能完成订单")
		}
		paymentProofFound := false
		for _, quote := range order.CustomerQuotes {
			if quote.Status == "accepted" && len(quote.PaymentProofs) > 0 {
				paymentProofFound = true
				break
			}
		}
		if !paymentProofFound {
			blockers = append(blockers, "完成订单前必须上传客户付款凭证")
		}
		if order.FreightMode == "quoted" {
			if shipment.ActualFreightAmount <= 0 {
				blockers = append(blockers, "我方已向客户报价运费，请填写最终实际运费")
			} else if !strings.EqualFold(shipment.ActualFreightCurrency, "CNY") && shipment.ActualFreightToCNYRate <= 0 {
				blockers = append(blockers, "请填写实际运费兑人民币汇率")
			}
		}
	}
	return blockers
}

func tradePurchaseStatusReady(status string) bool {
	switch strings.TrimSpace(status) {
	case "已下单", "生产中", "已完成":
		return true
	default:
		return false
	}
}

func tradeMissingItemLabels(items []model.TradeOrderItem, missing func(model.TradeOrderItem) bool) string {
	labels := make([]string, 0, 3)
	total := 0
	for _, item := range items {
		if !missing(item) {
			continue
		}
		total++
		if len(labels) >= 3 {
			continue
		}
		name := firstNonEmptyTrade(item.SKU, item.ProductName, fmt.Sprintf("第 %d 行", item.LineNo))
		labels = append(labels, fmt.Sprintf("%d. %s", item.LineNo, name))
	}
	if total == 0 {
		return ""
	}
	result := strings.Join(labels, "、")
	if total > len(labels) {
		result += fmt.Sprintf(" 等 %d 项", total)
	}
	return result
}

func (s *TradeService) canOperateStage(userID int64, order *model.TradeOrder) (bool, *model.TradePosition, error) {
	if order == nil {
		return false, nil, fmt.Errorf("业务单不能为空")
	}
	return s.canOperateStageForStage(userID, order, order.Stage)
}

func (s *TradeService) canOperateStageForStage(userID int64, order *model.TradeOrder, stage string) (bool, *model.TradePosition, error) {
	admin, err := s.isAdmin(userID)
	if err != nil {
		return false, nil, err
	}
	position, positionErr := s.repo.PositionForStage(stage)
	if admin {
		if positionErr != nil && !errors.Is(positionErr, sql.ErrNoRows) {
			return false, nil, positionErr
		}
		return true, position, nil
	}
	managerPosition, managerErr := s.repo.PositionForStage(model.TradeStageCompleted)
	if managerErr == nil {
		isManager, checkErr := s.repo.UserHasPosition(userID, managerPosition.ID)
		if checkErr != nil {
			return false, position, checkErr
		}
		if isManager {
			return true, position, nil
		}
	}
	if errors.Is(positionErr, sql.ErrNoRows) {
		return order.OwnerID == userID, nil, nil
	}
	if positionErr != nil {
		return false, nil, positionErr
	}
	userIDs, err := s.repo.PositionUserIDs(position.ID)
	if err != nil {
		return false, position, err
	}
	if len(userIDs) == 0 {
		return order.OwnerID == userID, position, nil
	}
	hasPosition, err := s.repo.UserHasPosition(userID, position.ID)
	return hasPosition, position, err
}

func (s *TradeService) notifyStageAssignees(order *model.TradeOrder, stage, note string) {
	if order == nil || s.automationRepo == nil {
		return
	}
	position, err := s.repo.PositionForStage(stage)
	if err != nil {
		return
	}
	userIDs, err := s.repo.PositionUserIDs(position.ID)
	if err != nil {
		return
	}
	if len(userIDs) == 0 && order.OwnerID > 0 {
		userIDs = []int64{order.OwnerID}
	}
	metadata, _ := json.Marshal(map[string]any{"order_id": order.ID, "order_no": order.OrderNo, "stage": stage, "position": position.Code})
	entityID := order.ID
	createdFor, err := s.automationRepo.CreateNotifications(userIDs, model.UserNotification{
		NotificationType: "trade_workflow", Title: fmt.Sprintf("%s：%s", position.Name, order.OrderNo),
		Content: firstNonEmptyTrade(note, fmt.Sprintf("业务单已进入%s阶段，请继续处理。", tradeStageLabel(stage))),
		LinkURL: fmt.Sprintf("/trade?order=%d", order.ID), EntityType: "trade_order", EntityID: &entityID, Metadata: metadata,
	})
	if err == nil && len(createdFor) > 0 && s.notificationHook != nil {
		go s.notificationHook(createdFor)
	}
}

type tradeSheetDefinition struct {
	Name    string
	Columns []map[string]any
	Rows    []map[string]any
}

func tradeWorkbookDefinitions(order *model.TradeOrder, customer *model.TradeCustomer, items []model.TradeOrderItem) []tradeSheetDefinition {
	return tradeWorkbookDefinitionsWithContext(order, customer, items, nil, nil, nil, nil)
}

func tradeWorkbookDefinitionsWithContext(
	order *model.TradeOrder,
	customer *model.TradeCustomer,
	items []model.TradeOrderItem,
	suppliers []model.TradeSupplier,
	supplierQuotes []model.TradeSupplierQuote,
	customerQuotes []model.TradeCustomerQuoteRound,
	shipment *model.TradeShipment,
) []tradeSheetDefinition {
	profit := buildTradeProfitSummary(order, items)
	stageOptions := []string{"询价", "供应商询价", "对客报价与议价", "采购", "仓库到货", "质检", "装箱", "发货", "已完成", "已取消"}
	priorityOptions := []string{"低", "普通", "高", "紧急"}
	priorityColors := map[string]any{
		"低":  map[string]string{"backgroundColor": "#F1F5F9", "textColor": "#475569"},
		"普通": map[string]string{"backgroundColor": "#DBEAFE", "textColor": "#1D4ED8"},
		"高":  map[string]string{"backgroundColor": "#FFEDD5", "textColor": "#C2410C"},
		"紧急": map[string]string{"backgroundColor": "#FEE2E2", "textColor": "#B91C1C"},
	}
	definitions := []tradeSheetDefinition{
		{
			Name: "订单总览",
			Columns: []map[string]any{
				tradeColumn("order_no", "业务单号", "text", 150),
				tradeColumn("customer", "客户", "text", 180),
				tradeSelectColumn("stage", "当前阶段", stageOptions, tradeStageColors, false, 120),
				tradeSelectColumn("priority", "优先级", priorityOptions, priorityColors, false, 90),
				tradeColumn("owner", "负责人", "text", 100),
				tradeColumn("currency", "币种", "text", 70),
				tradeColumn("destination_country", "目的地 / 目的港", "text", 220),
				tradeColumn("quote_deadline", "报价截止", "date", 110),
				tradeColumn("payment_method", "付款方式", "text", 190),
				tradeCurrencyColumn("goods_amount", "商品报价", order.Currency, 110),
				tradeCurrencyColumn("quoted_freight", "报价运费", order.Currency, 110),
				tradeColumn("quote_exchange_rate_cny", "报价兑人民币", "number", 120),
				tradeCurrencyColumn("sales_amount", "销售额", order.Currency, 110),
				tradeCurrencyColumn("product_cost", "产品成本", order.Currency, 110),
				tradeCurrencyColumn("actual_freight", "实际运费折合", order.Currency, 120),
				tradeCurrencyColumn("freight_profit", "运费利润", order.Currency, 110),
				tradeCurrencyColumn("additional_cost", "附加成本", order.Currency, 110),
				tradeCurrencyColumn("gross_profit", "毛利润", order.Currency, 110),
				tradeColumn("profit_margin", "利润率/%", "number", 90),
				tradeCurrencyColumn("profit_cny", "人民币利润", "CNY", 120),
				tradeColumn("additional_cost_notes", "附加成本说明", "text", 220),
				tradeColumn("stage_updated_at", "阶段更新时间", "text", 150),
				tradeColumn("notes", "备注", "text", 260),
			},
			Rows: []map[string]any{{
				"order_no": order.OrderNo, "customer": firstNonEmptyTrade(customer.CompanyName, customer.Name),
				"stage": tradeStageLabel(order.Stage), "priority": tradePriorityLabel(order.Priority),
				"owner": order.OwnerName, "currency": order.Currency,
				"destination_country": mergeTradeDestination(order.DestinationCountry, order.DestinationPort),
				"quote_deadline":      formatTradeDate(order.QuoteDeadline),
				"payment_method":      firstNonEmptyTrade(order.PaymentMethod, order.PaymentTerms),
				"goods_amount":        profit.GoodsRevenue, "quoted_freight": profit.FreightRevenue,
				"quote_exchange_rate_cny": profit.ExchangeRateCNY,
				"sales_amount":            profit.Revenue, "product_cost": profit.ProductCost,
				"actual_freight": profit.ActualFreightCost, "freight_profit": profit.FreightProfit,
				"additional_cost": profit.AdditionalCost, "gross_profit": profit.ProfitAmount,
				"profit_margin": profit.ProfitMargin, "profit_cny": profit.ProfitAmountCNY,
				"additional_cost_notes": profit.AdditionalCostNotes,
				"stage_updated_at":      time.Now().Format("2006-01-02 15:04"), "notes": order.Notes,
			}},
		},
	}

	inquiryRows := make([]map[string]any, 0, len(items))
	supplierQuoteRows := make([]map[string]any, 0, len(items))
	quoteRows := make([]map[string]any, 0, len(items))
	purchaseRows := make([]map[string]any, 0, len(items))
	receivingRows := make([]map[string]any, 0, len(items))
	inspectionRows := make([]map[string]any, 0, len(items))
	packingRows := make([]map[string]any, 0, len(items))
	selectedQuotes := make(map[int64]model.TradeSupplierQuote)
	quotesByItem := make(map[int64][]model.TradeSupplierQuote)
	latestCustomerQuoteStatus := ""
	latestCustomerQuoteCurrency := order.Currency
	latestCustomerQuoteExchangeRateCNY := order.QuoteExchangeRateCNY
	latestFreightMode := order.FreightMode
	latestFreightAmount := order.QuotedFreightAmount
	if len(customerQuotes) > 0 {
		latestCustomerQuoteStatus = customerQuotes[0].Status
		latestCustomerQuoteCurrency = customerQuotes[0].Currency
		latestCustomerQuoteExchangeRateCNY = customerQuotes[0].ExchangeRateCNY
		latestFreightMode = customerQuotes[0].FreightMode
		latestFreightAmount = customerQuotes[0].FreightAmount
	}
	for _, quote := range supplierQuotes {
		quotesByItem[quote.OrderItemID] = append(quotesByItem[quote.OrderItemID], quote)
		if quote.IsSelected {
			selectedQuotes[quote.OrderItemID] = quote
		}
	}
	for _, item := range items {
		quoteStatus := "待报价"
		if item.QuotedPrice > 0 {
			quoteStatus = "已报价"
		}
		switch latestCustomerQuoteStatus {
		case "negotiating":
			quoteStatus = "客户议价"
		case "accepted":
			quoteStatus = "客户确认"
		case "rejected":
			quoteStatus = "客户拒绝"
		}
		inquiryRows = append(inquiryRows, map[string]any{
			"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
			"specification": item.Specification, "quantity": item.Quantity, "unit": item.Unit,
			"target_price": item.TargetPrice, "customer_notes": item.Description,
			"status": firstNonEmptyTrade(tradeWorkflowString(&item, "inquiry_status"), "待询价"),
		})
		quoteRows = append(quoteRows, map[string]any{
			"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
			"specification": item.Specification, "quantity": item.Quantity, "unit": item.Unit,
			"unit_price": item.QuotedPrice, "amount": fmt.Sprintf("=E%d*G%d", item.LineNo+1, item.LineNo+1), "quote_status": quoteStatus,
			"quote_currency": latestCustomerQuoteCurrency, "exchange_rate_cny": latestCustomerQuoteExchangeRateCNY,
			"freight_mode": tradeFreightModeLabel(latestFreightMode), "freight_amount": latestFreightAmount,
		})
		itemQuotes := quotesByItem[item.ID]
		if len(itemQuotes) == 0 {
			supplierQuoteRows = append(supplierQuoteRows, blankTradeSupplierQuoteRow(order, item))
		} else {
			for _, quote := range itemQuotes {
				supplierQuoteRows = append(supplierQuoteRows, tradeSupplierQuoteRow(item, quote))
			}
		}
		selectedQuote := selectedQuotes[item.ID]
		supplierName := firstNonEmptyTrade(item.SupplierName, selectedQuote.SupplierName)
		supplierQuotePrice := selectedQuote.UnitPrice
		if supplierQuotePrice <= 0 {
			supplierQuotePrice = item.PurchasePrice
		}
		purchaseRows = append(purchaseRows, map[string]any{
			"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
			"quantity": item.Quantity, "unit": item.Unit, "supplier": supplierName, "supplier_quote": supplierQuotePrice,
			"purchase_currency": firstNonEmptyTrade(item.PurchaseCurrency, order.Currency),
			"purchase_price":    item.PurchasePrice, "cost_exchange_rate": tradeProfitExchangeRate(order.Currency, order.QuoteExchangeRateCNY, &item),
			"lead_time_days":  selectedQuote.LeadTimeDays,
			"purchase_status": firstNonEmptyTrade(tradeWorkflowString(&item, "purchase_status"), "待采购"),
		})
		receiptStatus := "待到货"
		if item.ReceivedQuantity >= item.Quantity && item.Quantity > 0 {
			receiptStatus = "全部到货"
		}
		receiptStatus = firstNonEmptyTrade(tradeWorkflowString(&item, "receipt_status"), receiptStatus)
		receivingRows = append(receivingRows, map[string]any{
			"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
			"expected_qty": item.Quantity, "received_qty": item.ReceivedQuantity,
			"warehouse_location": tradeWorkflowString(&item, "warehouse_location"),
			"received_date":      tradeWorkflowString(&item, "received_date"), "receipt_status": receiptStatus,
		})
		inspectionBaseQuantity := firstNonZeroTrade(tradeWorkflowFloat(&item, "sample_qty"), item.ReceivedQuantity, item.Quantity)
		inspectionResult := "待检"
		if item.AcceptedQuantity > 0 && item.AcceptedQuantity >= inspectionBaseQuantity {
			inspectionResult = "合格"
		}
		inspectionResult = firstNonEmptyTrade(tradeWorkflowString(&item, "inspection_result"), inspectionResult)
		inspectionRows = append(inspectionRows, map[string]any{
			"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
			"sample_qty": inspectionBaseQuantity, "passed_qty": item.AcceptedQuantity,
			"failed_qty": nonNegativeTradeDifference(inspectionBaseQuantity, item.AcceptedQuantity), "result": inspectionResult,
			"issue": tradeWorkflowString(&item, "inspection_issue"), "inspector": tradeWorkflowString(&item, "inspector"),
			"inspection_date": tradeWorkflowString(&item, "inspection_date"),
		})
		packingRows = append(packingRows, map[string]any{
			"line_no": item.LineNo, "carton_no": tradeWorkflowString(&item, "carton_no"), "sku": item.SKU, "product_name": item.ProductName,
			"quantity": firstNonZeroTrade(item.PackedQuantity, item.Quantity), "carton_count": item.CartonCount,
			"carton_size": tradeWorkflowString(&item, "carton_size"), "gross_weight": item.GrossWeight,
			"net_weight": item.NetWeight, "marks": tradeWorkflowString(&item, "marks"),
		})
	}
	supplierOptions := make([]string, 0, len(suppliers))
	for _, supplier := range suppliers {
		supplierOptions = append(supplierOptions, supplier.Name)
	}
	definitions = append(definitions,
		tradeSheetDefinition{Name: "询价明细", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("specification", "规格", "text", 200),
			tradeColumn("quantity", "数量", "number", 90), tradeColumn("unit", "单位", "text", 70),
			tradeCurrencyColumn("target_price", "目标价", order.Currency, 100), tradeColumn("customer_notes", "客户要求", "text", 240),
			tradeSelectColumn("status", "询价状态", []string{"待询价", "已询价", "无法报价"}, standardStatusColors(), false, 100),
		}, Rows: inquiryRows},
		tradeSheetDefinition{Name: "供应商询价", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("specification", "规格", "text", 180),
			tradeColumn("quantity", "询价数量", "number", 100), tradeColumn("unit", "单位", "text", 70),
			tradeSelectColumn("supplier", "供应商", supplierOptions, map[string]any{}, true, 190),
			tradeColumn("currency", "币种", "text", 75), tradeCurrencyColumn("unit_price", "供应商单价", order.Currency, 110),
			tradeColumn("moq", "MOQ", "number", 90), tradeColumn("lead_time_days", "交期/天", "number", 90),
			tradeColumn("valid_until", "报价有效期", "date", 110),
			tradeSelectColumn("selected", "采用", []string{"否", "是"}, standardStatusColors(), false, 80),
			tradeColumn("notes", "供应商备注", "text", 220),
		}, Rows: supplierQuoteRows},
		tradeSheetDefinition{Name: "报价单", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("specification", "规格", "text", 200),
			tradeColumn("quantity", "数量", "number", 90), tradeColumn("unit", "单位", "text", 70),
			tradeCurrencyColumn("unit_price", "报价单价", order.Currency, 100), tradeFormulaColumn("amount", "金额", "=E2*G2", 110),
			tradeSelectColumn("quote_status", "报价状态", []string{"待报价", "已报价", "客户议价", "客户确认", "客户拒绝"}, standardStatusColors(), false, 110),
			tradeColumn("quote_currency", "报价币种", "text", 85), tradeColumn("exchange_rate_cny", "兑人民币汇率", "number", 115),
			tradeColumn("freight_mode", "运费方式", "text", 130), tradeCurrencyColumn("freight_amount", "报价运费", order.Currency, 105),
		}, Rows: quoteRows},
		tradeSheetDefinition{Name: "采购跟进", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("quantity", "采购数量", "number", 100),
			tradeColumn("unit", "单位", "text", 70), tradeColumn("supplier", "供应商", "text", 190),
			tradeCurrencyColumn("supplier_quote", "供应商报价", order.Currency, 110), tradeColumn("purchase_currency", "采购币种", "text", 90),
			tradeCurrencyColumn("purchase_price", "采购价", order.Currency, 100),
			tradeColumn("cost_exchange_rate", "成本换算率", "number", 105),
			tradeColumn("lead_time_days", "交期/天", "number", 90),
			tradeSelectColumn("purchase_status", "采购状态", []string{"待采购", "询价中", "已下单", "生产中", "已完成"}, standardStatusColors(), false, 110),
		}, Rows: purchaseRows},
		tradeSheetDefinition{Name: "仓库到货", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("expected_qty", "应到数量", "number", 100),
			tradeColumn("received_qty", "实到数量", "number", 100), tradeColumn("warehouse_location", "库位", "text", 110),
			tradeColumn("received_date", "到货日期", "date", 110),
			tradeSelectColumn("receipt_status", "到货状态", []string{"待到货", "部分到货", "全部到货", "数量异常"}, standardStatusColors(), false, 110),
		}, Rows: receivingRows},
		tradeSheetDefinition{Name: "质检记录", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("sku", "SKU", "text", 110),
			tradeColumn("product_name", "产品名称", "text", 180), tradeColumn("sample_qty", "抽检数量", "number", 100),
			tradeColumn("passed_qty", "合格数量", "number", 100), tradeColumn("failed_qty", "不合格数量", "number", 110),
			tradeSelectColumn("result", "质检结论", []string{"待检", "合格", "返工", "拒收"}, standardStatusColors(), false, 100),
			tradeColumn("issue", "问题描述", "text", 240), tradeColumn("inspector", "质检员", "text", 100), tradeColumn("inspection_date", "质检日期", "date", 110),
		}, Rows: inspectionRows},
		tradeSheetDefinition{Name: "装箱清单", Columns: []map[string]any{
			tradeColumn("line_no", "序号", "number", 60), tradeColumn("carton_no", "箱号", "text", 90),
			tradeColumn("sku", "SKU", "text", 110), tradeColumn("product_name", "产品名称", "text", 180),
			tradeColumn("quantity", "装箱数量", "number", 100), tradeColumn("carton_count", "箱数", "number", 80),
			tradeColumn("carton_size", "箱规", "text", 140),
			tradeColumn("gross_weight", "毛重/kg", "number", 100), tradeColumn("net_weight", "净重/kg", "number", 100),
			tradeColumn("marks", "唛头", "text", 220),
		}, Rows: packingRows},
		tradeSheetDefinition{Name: "发货跟踪", Columns: []map[string]any{
			tradeColumn("booking_no", "订舱号", "text", 130), tradeColumn("carrier", "承运人", "text", 140),
			tradeColumn("vessel_flight", "船名/航班", "text", 150), tradeColumn("etd", "ETD", "date", 100),
			tradeColumn("eta", "ETA", "date", 100), tradeColumn("bl_no", "提单号", "text", 150),
			tradeColumn("destination", "目的港", "text", 160),
			tradeSelectColumn("shipping_status", "运输状态", []string{"未发货", "已发货"}, standardStatusColors(), false, 110),
			tradeColumn("actual_freight_currency", "实际运费币种", "text", 110),
			tradeColumn("actual_freight_amount", "实际运费", "number", 100),
			tradeColumn("actual_freight_to_cny_rate", "实际运费兑人民币", "number", 135),
			tradeColumn("actual_freight_notes", "实际运费说明", "text", 200),
			tradeColumn("notes", "备注", "text", 240),
		}, Rows: []map[string]any{tradeShipmentRow(order, shipment)}},
	)
	return definitions
}

func tradeColumn(key, name, columnType string, width int) map[string]any {
	return map[string]any{"key": key, "name": name, "type": columnType, "width": width}
}

func tradeCurrencyColumn(key, name, currency string, width int) map[string]any {
	column := tradeColumn(key, name, "currency", width)
	column["currencyCode"] = currency
	return column
}

func tradeFormulaColumn(key, name, formula string, width int) map[string]any {
	column := tradeColumn(key, name, "formula", width)
	column["formula"] = formula
	return column
}

func tradeSelectColumn(key, name string, options []string, colors map[string]any, searchable bool, width int) map[string]any {
	column := tradeColumn(key, name, "select", width)
	column["options"] = options
	column["optionColors"] = colors
	if searchable {
		column["searchable"] = true
	}
	return column
}

func standardStatusColors() map[string]any {
	return map[string]any{
		"是":    map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"否":    map[string]string{"backgroundColor": "#F1F5F9", "textColor": "#475569"},
		"待询价":  map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"待报价":  map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"待采购":  map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"待到货":  map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"待检":   map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"询价中":  map[string]string{"backgroundColor": "#DBEAFE", "textColor": "#1D4ED8"},
		"生产中":  map[string]string{"backgroundColor": "#DBEAFE", "textColor": "#1D4ED8"},
		"运输中":  map[string]string{"backgroundColor": "#DBEAFE", "textColor": "#1D4ED8"},
		"已询价":  map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"已报价":  map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"客户议价": map[string]string{"backgroundColor": "#FEF3C7", "textColor": "#92400E"},
		"客户确认": map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"已下单":  map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"已完成":  map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"全部到货": map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"合格":   map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"已签收":  map[string]string{"backgroundColor": "#DCFCE7", "textColor": "#166534"},
		"无法报价": map[string]string{"backgroundColor": "#FEE2E2", "textColor": "#B91C1C"},
		"客户拒绝": map[string]string{"backgroundColor": "#FEE2E2", "textColor": "#B91C1C"},
		"数量异常": map[string]string{"backgroundColor": "#FEE2E2", "textColor": "#B91C1C"},
		"返工":   map[string]string{"backgroundColor": "#FFEDD5", "textColor": "#C2410C"},
		"拒收":   map[string]string{"backgroundColor": "#FEE2E2", "textColor": "#B91C1C"},
	}
}

func buildTradeOrderItems(inputs []model.CreateTradeOrderItemRequest) ([]model.TradeOrderItem, error) {
	items := make([]model.TradeOrderItem, 0, len(inputs))
	for index, input := range inputs {
		productName := strings.TrimSpace(input.ProductName)
		if productName == "" || input.Quantity <= 0 {
			return nil, fmt.Errorf("第 %d 行产品名称和数量不能为空", index+1)
		}
		unit := strings.TrimSpace(input.Unit)
		if unit == "" {
			unit = "件"
		}
		items = append(items, model.TradeOrderItem{
			SKU: strings.TrimSpace(input.SKU), ProductName: productName,
			Description: strings.TrimSpace(input.Description), Specification: strings.TrimSpace(input.Specification),
			Quantity: input.Quantity, Unit: unit, TargetPrice: input.TargetPrice,
		})
	}
	return items, nil
}

func validTradeCustomerSource(source string) bool {
	switch source {
	case "manual", "whatsapp", "email", "website", "exhibition", "referral", "marketplace", "other":
		return true
	default:
		return false
	}
}

func validTradeCustomerStatus(status string) bool {
	switch status {
	case "lead", "active", "inactive", "blocked":
		return true
	default:
		return false
	}
}

func validTradeStage(stage string) bool {
	if stage == model.TradeStageCancelled {
		return true
	}
	for _, candidate := range tradeStageOrder {
		if stage == candidate {
			return true
		}
	}
	return false
}

func nextTradeStage(stage string) string {
	for index, candidate := range tradeStageOrder {
		if candidate == stage && index+1 < len(tradeStageOrder) {
			return tradeStageOrder[index+1]
		}
	}
	return ""
}

func prevTradeStage(stage string) string {
	for index, candidate := range tradeStageOrder {
		if candidate == stage && index > 0 {
			return tradeStageOrder[index-1]
		}
	}
	return ""
}

func tradeStageLabel(stage string) string {
	if label := tradeStageLabels[stage]; label != "" {
		return label
	}
	return stage
}

func tradeCustomerQuoteStatusLabel(status string) string {
	switch status {
	case "draft":
		return "草稿"
	case "sent":
		return "已向客户报价"
	case "negotiating":
		return "客户议价中"
	case "accepted":
		return "客户已接受"
	case "rejected":
		return "客户已拒绝"
	case "superseded":
		return "已被新报价替代"
	default:
		return status
	}
}

func tradePriorityLabel(priority string) string {
	switch priority {
	case "low":
		return "低"
	case "high":
		return "高"
	case "urgent":
		return "紧急"
	default:
		return "普通"
	}
}

func parseTradeDate(value string) (*time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil, nil
	}
	if len(value) >= 10 {
		value = value[:10]
	}
	parsed, err := time.ParseInLocation("2006-01-02", value, time.Local)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func formatTradeDate(value *time.Time) string {
	if value == nil {
		return ""
	}
	return value.Format("2006-01-02")
}

func blankTradeSupplierQuoteRow(order *model.TradeOrder, item model.TradeOrderItem) map[string]any {
	currency := "USD"
	if order != nil {
		currency = firstNonEmptyTrade(order.Currency, currency)
	}
	return map[string]any{
		"line_no": item.LineNo, "sku": item.SKU, "product_name": item.ProductName,
		"specification": item.Specification, "quantity": item.Quantity, "unit": item.Unit,
		"supplier": "", "currency": currency, "unit_price": 0, "moq": 0,
		"lead_time_days": 0, "valid_until": "", "selected": "否", "notes": "",
	}
}

func tradeSupplierQuoteRow(item model.TradeOrderItem, quote model.TradeSupplierQuote) map[string]any {
	return map[string]any{
		"line_no": item.LineNo, "sku": firstNonEmptyTrade(quote.SKU, item.SKU),
		"product_name":  firstNonEmptyTrade(quote.ProductName, item.ProductName),
		"specification": item.Specification, "quantity": item.Quantity, "unit": item.Unit,
		"supplier": quote.SupplierName, "currency": quote.Currency, "unit_price": quote.UnitPrice,
		"moq": quote.MOQ, "lead_time_days": quote.LeadTimeDays, "valid_until": formatTradeDate(quote.ValidUntil),
		"selected": map[bool]string{true: "是", false: "否"}[quote.IsSelected], "notes": quote.Notes,
	}
}

func nonNegativeTradeDifference(total, completed float64) float64 {
	if total <= completed {
		return 0
	}
	return total - completed
}

func tradeShipmentRow(order *model.TradeOrder, shipment *model.TradeShipment) map[string]any {
	row := map[string]any{
		"booking_no": "", "carrier": "", "vessel_flight": "", "etd": "", "eta": "", "bl_no": "",
		"destination": order.DestinationPort, "shipping_status": "未发货",
		"actual_freight_currency": "CNY", "actual_freight_amount": 0, "actual_freight_to_cny_rate": 1,
		"actual_freight_notes": "", "notes": "",
	}
	if shipment == nil {
		return row
	}
	row["booking_no"] = shipment.BookingNo
	row["carrier"] = shipment.Carrier
	row["vessel_flight"] = shipment.VesselFlight
	row["etd"] = formatTradeDate(shipment.ETD)
	row["eta"] = formatTradeDate(shipment.ETA)
	row["bl_no"] = shipment.BLNo
	row["shipping_status"] = normalizeTradeShippingStatus(shipment.ShippingStatus)
	row["actual_freight_currency"] = shipment.ActualFreightCurrency
	row["actual_freight_amount"] = shipment.ActualFreightAmount
	row["actual_freight_to_cny_rate"] = shipment.ActualFreightToCNYRate
	row["actual_freight_notes"] = shipment.ActualFreightNotes
	row["notes"] = shipment.Notes
	return row
}

func tradeString(value any) string {
	if value == nil {
		return ""
	}
	switch typed := value.(type) {
	case string:
		return strings.TrimSpace(typed)
	case json.Number:
		return typed.String()
	case float64:
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case bool:
		if typed {
			return "是"
		}
		return "否"
	default:
		return strings.TrimSpace(fmt.Sprint(value))
	}
}

func tradeWorkflowString(item *model.TradeOrderItem, key string) string {
	if item == nil || item.WorkflowData == nil {
		return ""
	}
	return tradeString(item.WorkflowData[key])
}

func tradeWorkflowFloat(item *model.TradeOrderItem, key string) float64 {
	if item == nil || item.WorkflowData == nil {
		return 0
	}
	return tradeFloat(item.WorkflowData[key])
}

func tradeFloat(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case float32:
		return float64(typed)
	case int:
		return float64(typed)
	case json.Number:
		parsed, _ := typed.Float64()
		return parsed
	default:
		text := strings.TrimSpace(strings.ReplaceAll(fmt.Sprint(value), ",", ""))
		if strings.HasPrefix(text, "=") || text == "" {
			return 0
		}
		parsed, _ := strconv.ParseFloat(text, 64)
		return parsed
	}
}

func tradeInt(value any, fallback int) int {
	if parsed := int(tradeFloat(value)); parsed != 0 {
		return parsed
	}
	return fallback
}

func tradeBool(value any) bool {
	if typed, ok := value.(bool); ok {
		return typed
	}
	switch strings.ToLower(tradeString(value)) {
	case "是", "true", "yes", "y", "1", "采用", "已选择":
		return true
	default:
		return false
	}
}

func tradePriorityValue(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "低", "low":
		return "low"
	case "高", "high":
		return "high"
	case "紧急", "urgent":
		return "urgent"
	default:
		return "normal"
	}
}

func normalizeTradeTextList(values []string, limit int) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, value)
		if len(result) >= limit {
			break
		}
	}
	return result
}

func firstNonZeroTrade(values ...float64) float64 {
	for _, value := range values {
		if value != 0 {
			return value
		}
	}
	return 0
}

func phoneFromWhatsAppChat(chatID string) string {
	value := strings.Split(strings.TrimSpace(chatID), "@")[0]
	return tradePhoneDigitsPattern.ReplaceAllString(value, "")
}

func normalizeTradeTags(tags []string) []string {
	seen := make(map[string]struct{}, len(tags))
	result := make([]string, 0, len(tags))
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		key := strings.ToLower(tag)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, tag)
		if len(result) >= 20 {
			break
		}
	}
	return result
}

func firstNonEmptyTrade(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
