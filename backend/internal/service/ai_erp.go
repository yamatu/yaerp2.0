package service

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
)

const aiERPPlanTTL = 30 * time.Minute

type ERPActionPreview struct {
	Kind        string   `json:"kind"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	TargetLabel string   `json:"target_label,omitempty"`
	Details     []string `json:"details,omitempty"`
	CustomerID  int64    `json:"customer_id,omitempty"`
	OrderID     int64    `json:"order_id,omitempty"`
}

type ERPPendingPlan struct {
	PlanToken string           `json:"plan_token"`
	Summary   string           `json:"summary"`
	ExpiresAt time.Time        `json:"expires_at"`
	Action    ERPActionPreview `json:"action"`
	Warnings  []string         `json:"warnings,omitempty"`
}

type ERPApplyRequest struct {
	PlanToken string `json:"plan_token" binding:"required"`
}

type ERPApplyResult struct {
	ActionKind       string `json:"action_kind"`
	Message          string `json:"message"`
	NextStep         string `json:"next_step,omitempty"`
	CustomerID       int64  `json:"customer_id,omitempty"`
	OrderID          int64  `json:"order_id,omitempty"`
	ResourcesChanged bool   `json:"resources_changed"`
}

type storedERPAction struct {
	Kind    string           `json:"kind"`
	Preview ERPActionPreview `json:"preview"`
	Payload json.RawMessage  `json:"payload"`
}

type erpCustomerUpdatePayload struct {
	CustomerID int64                            `json:"customer_id"`
	Request    model.UpdateTradeCustomerRequest `json:"request"`
}

type erpOrderPayload[T any] struct {
	OrderID int64 `json:"order_id"`
	Request T     `json:"request"`
}

type erpSupplierQuoteDraft struct {
	OrderItemID   int64   `json:"order_item_id"`
	SKU           string  `json:"sku"`
	ProductQuery  string  `json:"product_query"`
	SupplierID    int64   `json:"supplier_id"`
	SupplierQuery string  `json:"supplier_query"`
	Currency      string  `json:"currency"`
	UnitPrice     float64 `json:"unit_price"`
	MOQ           float64 `json:"moq"`
	LeadTimeDays  int     `json:"lead_time_days"`
	ValidUntil    string  `json:"valid_until"`
	Notes         string  `json:"notes"`
}

type erpCustomerQuoteItemDraft struct {
	OrderItemID  int64   `json:"order_item_id"`
	SKU          string  `json:"sku"`
	ProductQuery string  `json:"product_query"`
	UnitPrice    float64 `json:"unit_price"`
}

type erpCustomerQuoteDraft struct {
	Currency            string                      `json:"currency"`
	ExchangeRateCNY     float64                     `json:"exchange_rate_cny"`
	ProfitMarginPercent float64                     `json:"profit_margin_percent"`
	FreightMode         string                      `json:"freight_mode"`
	FreightAmount       float64                     `json:"freight_amount"`
	Status              string                      `json:"status"`
	CustomerFeedback    string                      `json:"customer_feedback"`
	Notes               string                      `json:"notes"`
	Items               []erpCustomerQuoteItemDraft `json:"items"`
}

func (s *AIService) toolGetERPContext(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, err
	}
	dashboard, err := s.tradeService.Dashboard(userID)
	if err != nil {
		return nil, err
	}
	limit, err := intArgWithDefault(args, "limit", 12)
	if err != nil {
		return nil, err
	}
	limit = clampInt(limit, 1, 30)
	orders, err := s.tradeService.ListOrders(userID, model.TradeOrderFilter{})
	if err != nil {
		return nil, err
	}
	if len(orders) > limit {
		orders = orders[:limit]
	}
	items := make([]map[string]any, 0, len(orders))
	for index := range orders {
		items = append(items, erpOrderHeaderForAgent(&orders[index]))
	}
	data := map[string]any{
		"access":        profile,
		"dashboard":     dashboard,
		"workflow":      erpWorkflowForAgent(),
		"recent_orders": items,
	}
	return &toolExecutionResult{Data: data, Summary: fmt.Sprintf("已读取 ERP 权限与 %d 条最近业务单", len(items))}, nil
}

func (s *AIService) toolSearchERPCustomers(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	query, _ := stringArgWithDefault(args, "query", "")
	limit, err := intArgWithDefault(args, "limit", 20)
	if err != nil {
		return nil, err
	}
	limit = clampInt(limit, 1, 50)
	customers, err := s.tradeService.ListCustomers(userID, query)
	if err != nil {
		return nil, err
	}
	if len(customers) > limit {
		customers = customers[:limit]
	}
	return &toolExecutionResult{
		Data:    map[string]any{"query": query, "matches": customers, "match_count": len(customers)},
		Summary: fmt.Sprintf("找到 %d 个当前账号可访问的客户", len(customers)),
	}, nil
}

func (s *AIService) toolSearchERPOrders(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	query, _ := stringArgWithDefault(args, "query", "")
	stage, _ := stringArgWithDefault(args, "stage", "")
	limit, err := intArgWithDefault(args, "limit", 15)
	if err != nil {
		return nil, err
	}
	limit = clampInt(limit, 1, 30)
	customerID := optionalERPInt64(args, "customer_id")
	orders, err := s.tradeService.ListOrders(userID, model.TradeOrderFilter{Search: query, Stage: stage, CustomerID: customerID})
	if err != nil {
		return nil, err
	}
	if len(orders) > limit {
		orders = orders[:limit]
	}
	matches := make([]map[string]any, 0, len(orders))
	for index := range orders {
		order, detailErr := s.tradeService.GetOrder(userID, orders[index].ID)
		if detailErr != nil {
			matches = append(matches, erpOrderHeaderForAgent(&orders[index]))
			continue
		}
		matches = append(matches, erpOrderForAgent(order))
	}
	return &toolExecutionResult{
		Data:    map[string]any{"query": query, "stage": stage, "matches": matches, "match_count": len(matches)},
		Summary: fmt.Sprintf("找到 %d 条当前账号可访问的 ERP 业务单", len(matches)),
	}, nil
}

func (s *AIService) toolGetERPOrder(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	order, err := s.resolveERPOrder(userID, args)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{
		Data:    erpOrderForAgent(order),
		Summary: fmt.Sprintf("已读取业务单 %s，当前环节为%s", order.OrderNo, tradeStageLabel(order.Stage)),
	}, nil
}

func (s *AIService) toolSearchERPSuppliers(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	query, _ := stringArgWithDefault(args, "query", "")
	limit, err := intArgWithDefault(args, "limit", 20)
	if err != nil {
		return nil, err
	}
	limit = clampInt(limit, 1, 50)
	suppliers, err := s.tradeService.ListSuppliers(userID, query)
	if err != nil {
		return nil, err
	}
	if len(suppliers) > limit {
		suppliers = suppliers[:limit]
	}
	return &toolExecutionResult{
		Data:    map[string]any{"query": query, "matches": suppliers, "match_count": len(suppliers)},
		Summary: fmt.Sprintf("找到 %d 个当前账号可访问的供应商", len(suppliers)),
	}, nil
}

func (s *AIService) toolPreviewERPAction(userID int64, args map[string]any) (*toolExecutionResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	rawAction := mapArg(args, "action")
	if len(rawAction) == 0 {
		rawAction = args
	}
	action, warnings, err := s.prepareERPAction(userID, rawAction)
	if err != nil {
		return nil, err
	}
	plan, err := s.storeERPPendingPlan(userID, action, warnings)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{
		Data: map[string]any{
			"plan_ready": true,
			"summary":    plan.Summary,
			"action":     plan.Action,
			"warnings":   plan.Warnings,
			"expires_at": plan.ExpiresAt,
		},
		Summary:        fmt.Sprintf("已准备待确认 ERP 操作：%s", action.Preview.Title),
		PendingERPPlan: plan,
	}, nil
}

func (s *AIService) prepareERPAction(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	kind := strings.ToLower(strings.TrimSpace(fmt.Sprint(raw["kind"])))
	if kind == "" || kind == "<nil>" {
		return nil, nil, fmt.Errorf("ERP 操作缺少 kind")
	}
	switch kind {
	case "create_customer":
		return s.prepareERPCreateCustomer(userID, raw)
	case "update_customer":
		return s.prepareERPUpdateCustomer(userID, raw)
	case "create_supplier":
		return s.prepareERPCreateSupplier(userID, raw)
	case "create_inquiry":
		return s.prepareERPCreateInquiry(userID, raw)
	case "add_inquiry_items":
		return s.prepareERPAddInquiryItems(userID, raw)
	case "record_supplier_quotes":
		return s.prepareERPRecordSupplierQuotes(userID, raw)
	case "create_customer_quote":
		return s.prepareERPCreateCustomerQuote(userID, raw)
	case "update_stage_data":
		return s.prepareERPUpdateStageData(userID, raw)
	case "advance_order":
		return s.prepareERPAdvanceOrder(userID, raw)
	default:
		return nil, nil, fmt.Errorf("暂不支持 ERP 操作 %s", kind)
	}
}

func (s *AIService) prepareERPCreateCustomer(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, nil, err
	}
	if !profile.CanCreateCustomers {
		return nil, nil, fmt.Errorf("当前岗位没有录入客户的权限")
	}
	customerData := nestedERPMap(raw, "customer")
	if len(customerData) == 0 {
		customerData = raw
	}
	var request model.CreateTradeCustomerRequest
	if err := decodeERPValue(customerData, &request); err != nil {
		return nil, nil, fmt.Errorf("客户资料格式无效: %w", err)
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		return nil, nil, fmt.Errorf("请先确认客户名称")
	}
	if strings.TrimSpace(request.Source) == "" {
		request.Source = "manual"
	}
	if strings.TrimSpace(request.CustomerLevel) == "" {
		request.CustomerLevel = "B"
	}
	request.Source = strings.ToLower(strings.TrimSpace(request.Source))
	if !validTradeCustomerSource(request.Source) {
		return nil, nil, fmt.Errorf("不支持的客户来源")
	}
	request.CustomerLevel = strings.ToUpper(strings.TrimSpace(request.CustomerLevel))
	if request.CustomerLevel != "A" && request.CustomerLevel != "B" && request.CustomerLevel != "C" {
		return nil, nil, fmt.Errorf("客户等级仅支持 A、B、C")
	}
	if err := s.tradeService.ensureWritableTradeFolder(userID, request.WorkbookFolderID); err != nil {
		return nil, nil, err
	}
	if request.CreateChannel == nil {
		createChannel := true
		request.CreateChannel = &createChannel
	}
	preview := ERPActionPreview{
		Kind: "create_customer", Title: "创建客户档案",
		Description: "确认后才会写入客户资料；如启用客户频道，也会在确认后创建。",
		TargetLabel: request.Name,
		Details: compactERPDetails([]string{
			"公司：" + firstNonEmptyTrade(request.CompanyName, request.Name),
			"联系人：" + emptyERPLabel(request.ContactName),
			"电话 / WhatsApp：" + emptyERPLabel(request.Phone),
			"邮箱：" + emptyERPLabel(request.Email),
			"国家/地区：" + emptyERPLabel(strings.TrimSpace(request.Country+" "+request.Region)),
			"来源：" + request.Source,
			"客户等级：" + strings.ToUpper(request.CustomerLevel),
			"创建客户频道：" + yesNoERP(request.CreateChannel != nil && *request.CreateChannel),
		}),
	}
	return newStoredERPAction("create_customer", preview, request)
}

func (s *AIService) prepareERPUpdateCustomer(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	customerID := optionalERPInt64(raw, "customer_id")
	query := stringValue(raw["customer_query"])
	customer, err := s.resolveERPCustomer(userID, customerID, query)
	if err != nil {
		return nil, nil, err
	}
	changes := nestedERPMap(raw, "changes")
	if len(changes) == 0 {
		return nil, nil, fmt.Errorf("请提供需要修改的客户字段")
	}
	request, changedDetails, err := mergeERPTradeCustomerUpdate(customer, changes)
	if err != nil {
		return nil, nil, err
	}
	if _, err := normalizeTradeCustomerUpdate(request); err != nil {
		return nil, nil, err
	}
	payload := erpCustomerUpdatePayload{CustomerID: customer.ID, Request: *request}
	preview := ERPActionPreview{
		Kind: "update_customer", Title: "修改客户资料",
		Description: "确认后会更新客户档案，未列出的字段保持不变。",
		TargetLabel: fmt.Sprintf("%s · %s", customer.CustomerCode, customer.Name),
		Details:     changedDetails,
		CustomerID:  customer.ID,
	}
	return newStoredERPAction("update_customer", preview, payload)
}

func (s *AIService) prepareERPCreateSupplier(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, nil, err
	}
	if !profile.CanManageSuppliers {
		return nil, nil, fmt.Errorf("当前岗位没有维护供应商的权限")
	}
	supplierData := nestedERPMap(raw, "supplier")
	if len(supplierData) == 0 {
		supplierData = raw
	}
	var request model.CreateTradeSupplierRequest
	if err := decodeERPValue(supplierData, &request); err != nil {
		return nil, nil, fmt.Errorf("供应商资料格式无效: %w", err)
	}
	request.Name = strings.TrimSpace(request.Name)
	if request.Name == "" {
		return nil, nil, fmt.Errorf("请先确认供应商名称")
	}
	if strings.TrimSpace(request.DefaultCurrency) == "" {
		request.DefaultCurrency = "USD"
	}
	preview := ERPActionPreview{
		Kind: "create_supplier", Title: "创建供应商档案",
		Description: "确认后才会写入供应商资料。",
		TargetLabel: request.Name,
		Details: compactERPDetails([]string{
			"公司：" + firstNonEmptyTrade(request.CompanyName, request.Name),
			"联系人：" + emptyERPLabel(request.ContactName),
			"电话 / WhatsApp：" + emptyERPLabel(firstNonEmptyTrade(request.Phone, request.WhatsApp)),
			"默认币种：" + strings.ToUpper(request.DefaultCurrency),
			"付款方式：" + emptyERPLabel(request.PaymentMethod),
		}),
	}
	return newStoredERPAction("create_supplier", preview, request)
}

func (s *AIService) prepareERPCreateInquiry(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, nil, err
	}
	if !profile.CanCreateOrders {
		return nil, nil, fmt.Errorf("当前岗位没有创建客户询价的权限")
	}
	inquiryData := nestedERPMap(raw, "inquiry")
	if len(inquiryData) == 0 {
		inquiryData = raw
	}
	var request model.CreateTradeOrderRequest
	if err := decodeERPValue(inquiryData, &request); err != nil {
		return nil, nil, fmt.Errorf("询价资料格式无效: %w", err)
	}
	if request.CustomerID <= 0 {
		request.CustomerID = optionalERPInt64(raw, "customer_id")
	}
	if request.CustomerID <= 0 {
		customerQuery := firstNonEmptyTrade(stringValue(inquiryData["customer_query"]), stringValue(raw["customer_query"]))
		customer, resolveErr := s.resolveERPCustomer(userID, 0, customerQuery)
		if resolveErr != nil {
			return nil, nil, resolveErr
		}
		request.CustomerID = customer.ID
	}
	customer, err := s.resolveERPCustomer(userID, request.CustomerID, "")
	if err != nil {
		return nil, nil, err
	}
	request.Title = strings.TrimSpace(request.Title)
	if request.Title == "" {
		return nil, nil, fmt.Errorf("请先确认询价主题")
	}
	if len(request.Items) == 0 {
		return nil, nil, fmt.Errorf("询价至少需要一个产品")
	}
	if _, err := buildTradeOrderItems(request.Items); err != nil {
		return nil, nil, err
	}
	if strings.TrimSpace(request.Priority) == "" {
		request.Priority = "normal"
	}
	request.Priority = strings.ToLower(strings.TrimSpace(request.Priority))
	if request.Priority != "low" && request.Priority != "normal" && request.Priority != "high" && request.Priority != "urgent" {
		return nil, nil, fmt.Errorf("无效的询价优先级")
	}
	if strings.TrimSpace(request.Currency) == "" {
		request.Currency = "USD"
	}
	request.Currency = strings.ToUpper(strings.TrimSpace(request.Currency))
	if _, err := parseTradeDate(request.QuoteDeadline); err != nil {
		return nil, nil, fmt.Errorf("报价截止日期格式无效")
	}
	if err := s.tradeService.ensureWritableTradeFolder(userID, request.WorkbookFolderID); err != nil {
		return nil, nil, err
	}
	if request.CreateWorkspace == nil {
		createWorkspace := true
		request.CreateWorkspace = &createWorkspace
	}
	if request.SharedWorkspace == nil {
		sharedWorkspace := false
		request.SharedWorkspace = &sharedWorkspace
	}
	details := []string{
		"客户：" + fmt.Sprintf("%s · %s", customer.CustomerCode, customer.Name),
		"询价主题：" + request.Title,
		"币种：" + strings.ToUpper(request.Currency),
		"付款方式：" + emptyERPLabel(firstNonEmptyTrade(request.PaymentMethod, request.PaymentTerms)),
		"目的地：" + emptyERPLabel(mergeTradeDestination(request.DestinationCountry, request.DestinationPort)),
		"生成流程工作簿：" + yesNoERP(request.CreateWorkspace != nil && *request.CreateWorkspace),
	}
	for index, item := range request.Items {
		details = append(details, fmt.Sprintf("产品 %d：%s · %s × %s %s", index+1, emptyERPLabel(item.SKU), item.ProductName, formatERPNumber(item.Quantity), firstNonEmptyTrade(item.Unit, "件")))
	}
	preview := ERPActionPreview{
		Kind: "create_inquiry", Title: "创建客户询价",
		Description: "确认后将创建 ERP 业务单，并按设置生成流程工作簿。",
		TargetLabel: customer.Name + " / " + request.Title,
		Details:     compactERPDetails(details),
		CustomerID:  customer.ID,
	}
	return newStoredERPAction("create_inquiry", preview, request)
}

func (s *AIService) prepareERPAddInquiryItems(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	order, err := s.resolveERPOrder(userID, raw)
	if err != nil {
		return nil, nil, err
	}
	if order.Access == nil || !order.Access.CanAddItems {
		return nil, nil, fmt.Errorf("当前账号或当前流程阶段不能新增产品")
	}
	itemsValue := raw["items"]
	if nested := nestedERPMap(raw, "request"); len(nested) > 0 {
		itemsValue = nested["items"]
	}
	var items []model.CreateTradeOrderItemRequest
	if err := decodeERPValue(itemsValue, &items); err != nil {
		return nil, nil, fmt.Errorf("产品资料格式无效: %w", err)
	}
	if len(items) == 0 {
		return nil, nil, fmt.Errorf("请至少提供一个新增产品")
	}
	if _, err := buildTradeOrderItems(items); err != nil {
		return nil, nil, err
	}
	details := []string{"业务单：" + order.OrderNo + " · " + order.Title}
	for index, item := range items {
		details = append(details, fmt.Sprintf("新增产品 %d：%s · %s × %s %s", index+1, emptyERPLabel(item.SKU), item.ProductName, formatERPNumber(item.Quantity), firstNonEmptyTrade(item.Unit, "件")))
	}
	payload := erpOrderPayload[model.AddTradeOrderItemsRequest]{OrderID: order.ID, Request: model.AddTradeOrderItemsRequest{Items: items}}
	preview := ERPActionPreview{Kind: "add_inquiry_items", Title: "向询价追加产品", Description: "确认后会同步更新 ERP 业务单和流程工作簿。", TargetLabel: order.OrderNo, Details: compactERPDetails(details), CustomerID: order.CustomerID, OrderID: order.ID}
	return newStoredERPAction("add_inquiry_items", preview, payload)
}

func (s *AIService) prepareERPRecordSupplierQuotes(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	order, err := s.resolveERPOrder(userID, raw)
	if err != nil {
		return nil, nil, err
	}
	if order.Stage != model.TradeStageSupplierQuote || !order.CanOperateStage {
		return nil, nil, fmt.Errorf("业务单 %s 当前不在可操作的供应商询价阶段", order.OrderNo)
	}
	var drafts []erpSupplierQuoteDraft
	if err := decodeERPValue(raw["quotes"], &drafts); err != nil {
		return nil, nil, fmt.Errorf("供应商报价格式无效: %w", err)
	}
	if len(drafts) == 0 {
		return nil, nil, fmt.Errorf("请至少提供一条供应商报价")
	}
	request := model.BatchTradeSupplierQuoteRequest{Quotes: make([]model.UpsertTradeSupplierQuoteRequest, 0, len(drafts))}
	details := []string{"业务单：" + order.OrderNo + " · " + order.Title}
	for index, draft := range drafts {
		if draft.UnitPrice < 0 || draft.MOQ < 0 || draft.LeadTimeDays < 0 {
			return nil, nil, fmt.Errorf("第 %d 条报价的价格、MOQ 或交期不能小于零", index+1)
		}
		if _, dateErr := parseTradeDate(draft.ValidUntil); dateErr != nil {
			return nil, nil, fmt.Errorf("第 %d 条报价有效期格式无效", index+1)
		}
		item, resolveErr := resolveERPOrderItem(order.Items, draft.OrderItemID, firstNonEmptyTrade(draft.SKU, draft.ProductQuery))
		if resolveErr != nil {
			return nil, nil, fmt.Errorf("第 %d 条报价: %w", index+1, resolveErr)
		}
		supplier, resolveErr := s.resolveERPSupplier(userID, draft.SupplierID, draft.SupplierQuery)
		if resolveErr != nil {
			return nil, nil, fmt.Errorf("第 %d 条报价: %w", index+1, resolveErr)
		}
		currency := strings.ToUpper(firstNonEmptyTrade(draft.Currency, order.Currency, "USD"))
		request.Quotes = append(request.Quotes, model.UpsertTradeSupplierQuoteRequest{
			OrderItemID: item.ID, SupplierID: supplier.ID, Currency: currency,
			UnitPrice: draft.UnitPrice, MOQ: draft.MOQ, LeadTimeDays: draft.LeadTimeDays,
			ValidUntil: draft.ValidUntil, Notes: strings.TrimSpace(draft.Notes),
		})
		details = append(details, fmt.Sprintf("%s · %s：%s %s / MOQ %s / 交期 %d 天", firstNonEmptyTrade(item.SKU, item.ProductName), supplier.Name, currency, formatERPNumber(draft.UnitPrice), formatERPNumber(draft.MOQ), draft.LeadTimeDays))
	}
	payload := erpOrderPayload[model.BatchTradeSupplierQuoteRequest]{OrderID: order.ID, Request: request}
	preview := ERPActionPreview{Kind: "record_supplier_quotes", Title: "录入供应商报价", Description: "产品和供应商已按当前账号可见数据完成匹配；确认后才会写入报价。", TargetLabel: order.OrderNo, Details: compactERPDetails(details), CustomerID: order.CustomerID, OrderID: order.ID}
	return newStoredERPAction("record_supplier_quotes", preview, payload)
}

func (s *AIService) prepareERPCreateCustomerQuote(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	order, err := s.resolveERPOrder(userID, raw)
	if err != nil {
		return nil, nil, err
	}
	if order.Stage != model.TradeStageQuotation || !order.CanOperateStage {
		return nil, nil, fmt.Errorf("业务单 %s 当前不在可操作的对客报价阶段", order.OrderNo)
	}
	quoteData := nestedERPMap(raw, "quote")
	if len(quoteData) == 0 {
		quoteData = raw
	}
	var draft erpCustomerQuoteDraft
	if err := decodeERPValue(quoteData, &draft); err != nil {
		return nil, nil, fmt.Errorf("对客报价格式无效: %w", err)
	}
	if len(draft.Items) == 0 {
		return nil, nil, fmt.Errorf("请填写每项产品的对客报价")
	}
	request := model.CreateTradeCustomerQuoteRequest{
		Currency:        strings.ToUpper(firstNonEmptyTrade(draft.Currency, order.Currency, "USD")),
		ExchangeRateCNY: draft.ExchangeRateCNY, ProfitMarginPercent: draft.ProfitMarginPercent,
		FreightMode:   draft.FreightMode,
		FreightAmount: draft.FreightAmount, Status: firstNonEmptyTrade(draft.Status, "draft"),
		CustomerFeedback: strings.TrimSpace(draft.CustomerFeedback), Notes: strings.TrimSpace(draft.Notes),
		Items: make([]model.TradeCustomerQuoteItemInput, 0, len(draft.Items)),
	}
	details := []string{"业务单：" + order.OrderNo + " · " + order.Title, "报价币种：" + request.Currency, "运费模式：" + firstNonEmptyTrade(request.FreightMode, "客户自有货代")}
	for index, itemDraft := range draft.Items {
		if itemDraft.UnitPrice <= 0 {
			return nil, nil, fmt.Errorf("第 %d 项对客单价必须大于零", index+1)
		}
		item, resolveErr := resolveERPOrderItem(order.Items, itemDraft.OrderItemID, firstNonEmptyTrade(itemDraft.SKU, itemDraft.ProductQuery))
		if resolveErr != nil {
			return nil, nil, fmt.Errorf("第 %d 项对客报价: %w", index+1, resolveErr)
		}
		request.Items = append(request.Items, model.TradeCustomerQuoteItemInput{OrderItemID: item.ID, UnitPrice: itemDraft.UnitPrice})
		details = append(details, fmt.Sprintf("%s：%s %s", firstNonEmptyTrade(item.SKU, item.ProductName), request.Currency, formatERPNumber(itemDraft.UnitPrice)))
	}
	payload := erpOrderPayload[model.CreateTradeCustomerQuoteRequest]{OrderID: order.ID, Request: request}
	preview := ERPActionPreview{Kind: "create_customer_quote", Title: "创建一轮对客报价", Description: "确认后会新增报价轮次；建议先保存为草稿，核对无误后再标记已发送。", TargetLabel: order.OrderNo, Details: compactERPDetails(details), CustomerID: order.CustomerID, OrderID: order.ID}
	warnings := []string{}
	if strings.EqualFold(request.Status, "sent") {
		warnings = append(warnings, "本轮报价会直接标记为已发送；如仍需人工复核，请改为 draft。")
	}
	return newStoredERPActionWithWarnings("create_customer_quote", preview, payload, warnings)
}

func (s *AIService) prepareERPUpdateStageData(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	order, err := s.resolveERPOrder(userID, raw)
	if err != nil {
		return nil, nil, err
	}
	if !order.CanOperateStage {
		return nil, nil, fmt.Errorf("当前阶段由%s处理，当前账号不能修改本环节数据", firstNonEmptyTrade(order.RequiredPositionName, "负责人"))
	}
	stageData := nestedERPMap(raw, "stage_data")
	if len(stageData) == 0 {
		stageData = nestedERPMap(raw, "request")
	}
	if len(stageData) == 0 {
		return nil, nil, fmt.Errorf("请提供当前环节需要写入的数据")
	}
	itemsRaw, _ := stageData["items"].([]any)
	for index, value := range itemsRaw {
		itemMap, ok := value.(map[string]any)
		if !ok {
			return nil, nil, fmt.Errorf("第 %d 项环节数据格式无效", index+1)
		}
		itemID := optionalERPInt64(itemMap, "order_item_id")
		query := firstNonEmptyTrade(stringValue(itemMap["sku"]), stringValue(itemMap["product_query"]), stringValue(itemMap["product_name"]))
		item, resolveErr := resolveERPOrderItem(order.Items, itemID, query)
		if resolveErr != nil {
			return nil, nil, fmt.Errorf("第 %d 项环节数据: %w", index+1, resolveErr)
		}
		itemMap["order_item_id"] = item.ID
	}
	stageData["items"] = itemsRaw
	var request model.UpdateTradeStageDataRequest
	if err := decodeERPValue(stageData, &request); err != nil {
		return nil, nil, fmt.Errorf("环节数据格式无效: %w", err)
	}
	details := []string{
		"业务单：" + order.OrderNo + " · " + order.Title,
		"当前环节：" + tradeStageLabel(order.Stage),
	}
	if len(request.Items) > 0 {
		for _, input := range request.Items {
			item, _ := resolveERPOrderItem(order.Items, input.OrderItemID, "")
			if item != nil {
				details = append(details, "更新产品："+firstNonEmptyTrade(item.SKU, item.ProductName))
			}
		}
	}
	if request.Shipment != nil {
		details = append(details, "物流："+emptyERPLabel(request.Shipment.Carrier), "运单号："+emptyERPLabel(request.Shipment.BookingNo), "发货状态："+firstNonEmptyTrade(request.Shipment.ShippingStatus, "未发货"))
	}
	payload := erpOrderPayload[model.UpdateTradeStageDataRequest]{OrderID: order.ID, Request: request}
	preview := ERPActionPreview{Kind: "update_stage_data", Title: "更新当前 ERP 环节数据", Description: "确认后会写入当前环节，并同步关联流程工作簿。", TargetLabel: order.OrderNo, Details: compactERPDetails(details), CustomerID: order.CustomerID, OrderID: order.ID}
	return newStoredERPAction("update_stage_data", preview, payload)
}

func (s *AIService) prepareERPAdvanceOrder(userID int64, raw map[string]any) (*storedERPAction, []string, error) {
	order, err := s.resolveERPOrder(userID, raw)
	if err != nil {
		return nil, nil, err
	}
	target := strings.ToLower(firstNonEmptyTrade(stringValue(raw["to_stage"]), stringValue(raw["target_stage"]), "next"))
	switch target {
	case "next", "下一步", "下一阶段":
		target = nextTradeStage(order.Stage)
	case "previous", "prev", "上一步", "上一阶段":
		target = prevTradeStage(order.Stage)
	}
	if target == "" || !validTradeStage(target) {
		return nil, nil, fmt.Errorf("无法确定有效的目标流程阶段")
	}
	isForward := target == nextTradeStage(order.Stage)
	isBackward := target == prevTradeStage(order.Stage)
	if isForward {
		if !order.CanAdvance {
			return nil, nil, fmt.Errorf("当前账号不能推进业务单 %s", order.OrderNo)
		}
		if len(order.AdvanceBlockers) > 0 {
			return nil, nil, fmt.Errorf("进入下一步前仍需完成：%s", strings.Join(order.AdvanceBlockers, "；"))
		}
	} else if isBackward {
		if !order.CanReturn {
			return nil, nil, fmt.Errorf("当前账号不能退回业务单 %s", order.OrderNo)
		}
	} else {
		return nil, nil, fmt.Errorf("流程只能进入相邻的上一步或下一步")
	}
	request := model.AdvanceTradeOrderRequest{ToStage: target, Note: strings.TrimSpace(stringValue(raw["note"]))}
	direction := "推进"
	if isBackward {
		direction = "退回"
	}
	preview := ERPActionPreview{
		Kind: "advance_order", Title: direction + " ERP 流程",
		Description: "确认后才会改变业务单阶段，并通知下一环节对应岗位。",
		TargetLabel: order.OrderNo,
		CustomerID:  order.CustomerID,
		OrderID:     order.ID,
		Details: compactERPDetails([]string{
			"业务单：" + order.OrderNo + " · " + order.Title,
			"当前环节：" + tradeStageLabel(order.Stage),
			"目标环节：" + tradeStageLabel(target),
			"交接说明：" + emptyERPLabel(request.Note),
		}),
	}
	payload := erpOrderPayload[model.AdvanceTradeOrderRequest]{OrderID: order.ID, Request: request}
	return newStoredERPAction("advance_order", preview, payload)
}

func (s *AIService) storeERPPendingPlan(userID int64, action *storedERPAction, warnings []string) (*ERPPendingPlan, error) {
	if action == nil {
		return nil, fmt.Errorf("ERP 待确认操作不能为空")
	}
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return nil, fmt.Errorf("生成 ERP 确认令牌失败: %w", err)
	}
	token := base64.RawURLEncoding.EncodeToString(tokenBytes)
	expiresAt := time.Now().Add(aiERPPlanTTL)
	actionJSON, err := json.Marshal(action)
	if err != nil {
		return nil, fmt.Errorf("编码 ERP 操作失败: %w", err)
	}
	summary := action.Preview.Title
	if action.Preview.TargetLabel != "" {
		summary += "：" + action.Preview.TargetLabel
	}
	if _, err := s.db.Exec(
		`INSERT INTO ai_erp_plans (plan_token, user_id, summary, action, expires_at)
		 VALUES ($1, $2, $3, $4, $5)`,
		token, userID, summary, actionJSON, expiresAt,
	); err != nil {
		return nil, fmt.Errorf("保存 ERP 待确认方案失败: %w", err)
	}
	_, _ = s.db.Exec(`UPDATE ai_erp_plans SET status = 'expired', updated_at = NOW() WHERE status = 'pending' AND expires_at <= NOW()`)
	_, _ = s.db.Exec(`DELETE FROM ai_erp_plans WHERE created_at < NOW() - INTERVAL '30 days' AND status IN ('applied', 'failed', 'expired')`)
	return &ERPPendingPlan{PlanToken: token, Summary: summary, ExpiresAt: expiresAt, Action: action.Preview, Warnings: warnings}, nil
}

func (s *AIService) ApplyERPPlan(userID int64, planToken string) (*ERPApplyResult, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	planToken = strings.TrimSpace(planToken)
	if planToken == "" {
		return nil, fmt.Errorf("ERP 确认令牌不能为空")
	}
	var rawAction []byte
	err := s.db.QueryRow(
		`UPDATE ai_erp_plans
		 SET status = 'applying', updated_at = NOW()
		 WHERE plan_token = $1 AND user_id = $2 AND status = 'pending' AND expires_at > NOW()
		 RETURNING action`,
		planToken, userID,
	).Scan(&rawAction)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, s.erpPlanUnavailableError(userID, planToken)
	}
	if err != nil {
		return nil, fmt.Errorf("读取 ERP 待确认方案失败: %w", err)
	}
	var action storedERPAction
	if err := json.Unmarshal(rawAction, &action); err != nil {
		s.markERPPlanFailed(planToken, "ERP 操作数据损坏")
		return nil, fmt.Errorf("ERP 操作数据损坏")
	}
	result, err := s.executeERPAction(userID, &action)
	if err != nil {
		s.markERPPlanFailed(planToken, err.Error())
		return nil, err
	}
	resultJSON, _ := json.Marshal(result)
	if _, err := s.db.Exec(
		`UPDATE ai_erp_plans
		 SET status = 'applied', applied_at = NOW(), result = $2, last_error = '', updated_at = NOW()
		 WHERE plan_token = $1 AND user_id = $3`,
		planToken, resultJSON, userID,
	); err != nil {
		return nil, fmt.Errorf("ERP 操作已执行，但确认状态保存失败: %w", err)
	}
	return result, nil
}

func (s *AIService) erpPlanUnavailableError(userID int64, token string) error {
	var status string
	var expiresAt time.Time
	err := s.db.QueryRow(`SELECT status, expires_at FROM ai_erp_plans WHERE plan_token = $1 AND user_id = $2`, token, userID).Scan(&status, &expiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("ERP 待确认方案不存在或不属于当前账号")
	}
	if err != nil {
		return fmt.Errorf("读取 ERP 确认状态失败: %w", err)
	}
	if status == "applied" {
		return fmt.Errorf("该 ERP 方案已经执行，不能重复导入")
	}
	if status == "applying" {
		return fmt.Errorf("该 ERP 方案正在执行，请勿重复提交")
	}
	if time.Now().After(expiresAt) || status == "expired" {
		return fmt.Errorf("该 ERP 方案已过期，请让 AI 根据最新数据重新生成")
	}
	if status == "failed" {
		return fmt.Errorf("该 ERP 方案执行失败，请根据最新数据重新生成")
	}
	return fmt.Errorf("该 ERP 方案当前不可执行")
}

func (s *AIService) markERPPlanFailed(token, message string) {
	_, _ = s.db.Exec(`UPDATE ai_erp_plans SET status = 'failed', last_error = $2, updated_at = NOW() WHERE plan_token = $1`, token, message)
}

func (s *AIService) executeERPAction(userID int64, action *storedERPAction) (*ERPApplyResult, error) {
	if action == nil {
		return nil, fmt.Errorf("ERP 操作不能为空")
	}
	switch action.Kind {
	case "create_customer":
		var request model.CreateTradeCustomerRequest
		if err := json.Unmarshal(action.Payload, &request); err != nil {
			return nil, err
		}
		customer, err := s.tradeService.CreateCustomer(userID, &request)
		if err != nil {
			return nil, err
		}
		return &ERPApplyResult{ActionKind: action.Kind, Message: fmt.Sprintf("已创建客户 %s（%s）", customer.Name, customer.CustomerCode), NextStep: "下一步可让 AI 根据该客户创建询价，并先核对询价主题、币种和产品明细。", CustomerID: customer.ID, ResourcesChanged: true}, nil
	case "update_customer":
		var payload erpCustomerUpdatePayload
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		customer, err := s.tradeService.UpdateCustomer(userID, payload.CustomerID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return &ERPApplyResult{ActionKind: action.Kind, Message: fmt.Sprintf("已更新客户 %s（%s）", customer.Name, customer.CustomerCode), NextStep: "客户资料已更新，可继续查询该客户的业务单或创建新询价。", CustomerID: customer.ID, ResourcesChanged: true}, nil
	case "create_supplier":
		var request model.CreateTradeSupplierRequest
		if err := json.Unmarshal(action.Payload, &request); err != nil {
			return nil, err
		}
		supplier, err := s.tradeService.CreateSupplier(userID, &request)
		if err != nil {
			return nil, err
		}
		return &ERPApplyResult{ActionKind: action.Kind, Message: fmt.Sprintf("已创建供应商 %s（%s）", supplier.Name, supplier.SupplierCode), NextStep: "供应商已可用于供应商询价和报价匹配。", ResourcesChanged: true}, nil
	case "create_inquiry":
		var request model.CreateTradeOrderRequest
		if err := json.Unmarshal(action.Payload, &request); err != nil {
			return nil, err
		}
		order, err := s.tradeService.CreateOrder(userID, &request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已创建客户询价", order), nil
	case "add_inquiry_items":
		var payload erpOrderPayload[model.AddTradeOrderItemsRequest]
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		order, err := s.tradeService.AddOrderItems(userID, payload.OrderID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已追加询价产品", order), nil
	case "record_supplier_quotes":
		var payload erpOrderPayload[model.BatchTradeSupplierQuoteRequest]
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		order, err := s.tradeService.BatchCreateSupplierQuotes(userID, payload.OrderID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已录入供应商报价", order), nil
	case "create_customer_quote":
		var payload erpOrderPayload[model.CreateTradeCustomerQuoteRequest]
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		order, err := s.tradeService.CreateCustomerQuoteRound(userID, payload.OrderID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已创建对客报价", order), nil
	case "update_stage_data":
		var payload erpOrderPayload[model.UpdateTradeStageDataRequest]
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		order, err := s.tradeService.UpdateStageData(userID, payload.OrderID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已更新当前环节数据", order), nil
	case "advance_order":
		var payload erpOrderPayload[model.AdvanceTradeOrderRequest]
		if err := json.Unmarshal(action.Payload, &payload); err != nil {
			return nil, err
		}
		order, err := s.tradeService.AdvanceOrder(userID, payload.OrderID, &payload.Request)
		if err != nil {
			return nil, err
		}
		return erpApplyOrderResult(action.Kind, "已更新 ERP 流程", order), nil
	default:
		return nil, fmt.Errorf("暂不支持执行 ERP 操作 %s", action.Kind)
	}
}

func erpApplyOrderResult(kind, prefix string, order *model.TradeOrder) *ERPApplyResult {
	if order == nil {
		return &ERPApplyResult{ActionKind: kind, Message: prefix, ResourcesChanged: true}
	}
	return &ERPApplyResult{
		ActionKind:       kind,
		Message:          fmt.Sprintf("%s：%s · %s", prefix, order.OrderNo, order.Title),
		NextStep:         erpOrderNextStep(order),
		OrderID:          order.ID,
		CustomerID:       order.CustomerID,
		ResourcesChanged: true,
	}
}

func erpOrderNextStep(order *model.TradeOrder) string {
	if order == nil {
		return "请重新读取 ERP 数据确认后续步骤。"
	}
	if order.Stage == model.TradeStageCompleted {
		return "业务单已完成，可查看利润、PI、流程工作簿和归档资料。"
	}
	if order.Stage == model.TradeStageCancelled {
		return "业务单已取消；如需恢复，请由有权限的负责人退回上一阶段。"
	}
	if len(order.AdvanceBlockers) > 0 {
		return fmt.Sprintf("当前处于%s。进入下一步前仍需完成：%s。", tradeStageLabel(order.Stage), strings.Join(order.AdvanceBlockers, "；"))
	}
	next := nextTradeStage(order.Stage)
	if next == "" {
		return fmt.Sprintf("当前处于%s，请核对当前环节数据。", tradeStageLabel(order.Stage))
	}
	return fmt.Sprintf("当前处于%s，数据核对无误后可准备进入%s；推进前仍会再次要求确认。", tradeStageLabel(order.Stage), tradeStageLabel(next))
}

func (s *AIService) resolveERPCustomer(userID, customerID int64, query string) (*model.TradeCustomer, error) {
	if customerID > 0 {
		return s.tradeService.getCustomer(userID, customerID)
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("请提供客户 ID 或客户名称/公司/电话用于匹配")
	}
	customers, err := s.tradeService.ListCustomers(userID, query)
	if err != nil {
		return nil, err
	}
	if len(customers) == 0 {
		return nil, fmt.Errorf("没有找到当前账号可访问的客户“%s”", query)
	}
	exact := make([]model.TradeCustomer, 0)
	needle := normalizeERPMatchText(query)
	for _, customer := range customers {
		for _, candidate := range []string{customer.CustomerCode, customer.Name, customer.CompanyName, customer.Phone, customer.Email, customer.WhatsAppChatName} {
			if normalizeERPMatchText(candidate) == needle {
				exact = append(exact, customer)
				break
			}
		}
	}
	if len(exact) == 1 {
		return &exact[0], nil
	}
	if len(exact) == 0 && len(customers) == 1 {
		return &customers[0], nil
	}
	labels := make([]string, 0, minInt(len(customers), 5))
	for _, customer := range customers[:minInt(len(customers), 5)] {
		labels = append(labels, fmt.Sprintf("%s(%s, ID:%d)", customer.Name, customer.CustomerCode, customer.ID))
	}
	return nil, fmt.Errorf("客户“%s”匹配到多个结果，请确认客户 ID：%s", query, strings.Join(labels, "、"))
}

func (s *AIService) resolveERPOrder(userID int64, raw map[string]any) (*model.TradeOrder, error) {
	orderID := optionalERPInt64(raw, "order_id")
	if orderID <= 0 {
		if nested := nestedERPMap(raw, "request"); len(nested) > 0 {
			orderID = optionalERPInt64(nested, "order_id")
		}
	}
	if orderID > 0 {
		return s.tradeService.GetOrder(userID, orderID)
	}
	query := firstNonEmptyTrade(stringValue(raw["order_query"]), stringValue(raw["order_no"]), stringValue(raw["inquiry_title"]))
	if query == "" {
		return nil, fmt.Errorf("请提供业务单 ID、业务单号、询价主题或 SKU 用于匹配")
	}
	orders, err := s.tradeService.ListOrders(userID, model.TradeOrderFilter{Search: query})
	if err != nil {
		return nil, err
	}
	if len(orders) == 0 {
		return nil, fmt.Errorf("没有找到当前账号可访问的业务单“%s”", query)
	}
	needle := normalizeERPMatchText(query)
	exact := make([]model.TradeOrder, 0)
	for _, order := range orders {
		if normalizeERPMatchText(order.OrderNo) == needle || normalizeERPMatchText(order.Title) == needle {
			exact = append(exact, order)
		}
	}
	selected := (*model.TradeOrder)(nil)
	if len(exact) == 1 {
		selected = &exact[0]
	} else if len(exact) == 0 && len(orders) == 1 {
		selected = &orders[0]
	}
	if selected != nil {
		return s.tradeService.GetOrder(userID, selected.ID)
	}
	labels := make([]string, 0, minInt(len(orders), 5))
	for _, order := range orders[:minInt(len(orders), 5)] {
		labels = append(labels, fmt.Sprintf("%s / %s (ID:%d)", order.OrderNo, order.Title, order.ID))
	}
	return nil, fmt.Errorf("业务单“%s”匹配到多个结果，请确认业务单 ID：%s", query, strings.Join(labels, "、"))
}

func (s *AIService) resolveERPSupplier(userID, supplierID int64, query string) (*model.TradeSupplier, error) {
	if supplierID > 0 {
		suppliers, err := s.tradeService.ListSuppliers(userID, "")
		if err != nil {
			return nil, err
		}
		for index := range suppliers {
			if suppliers[index].ID == supplierID {
				return &suppliers[index], nil
			}
		}
		return nil, fmt.Errorf("供应商 ID %d 不存在或当前账号无权访问", supplierID)
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("请提供供应商 ID 或名称用于匹配")
	}
	suppliers, err := s.tradeService.ListSuppliers(userID, query)
	if err != nil {
		return nil, err
	}
	if len(suppliers) == 0 {
		return nil, fmt.Errorf("没有找到当前账号可访问的供应商“%s”", query)
	}
	needle := normalizeERPMatchText(query)
	exact := make([]model.TradeSupplier, 0)
	for _, supplier := range suppliers {
		for _, candidate := range []string{supplier.SupplierCode, supplier.Name, supplier.CompanyName, supplier.Phone, supplier.Email} {
			if normalizeERPMatchText(candidate) == needle {
				exact = append(exact, supplier)
				break
			}
		}
	}
	if len(exact) == 1 {
		return &exact[0], nil
	}
	if len(exact) == 0 && len(suppliers) == 1 {
		return &suppliers[0], nil
	}
	labels := make([]string, 0, minInt(len(suppliers), 5))
	for _, supplier := range suppliers[:minInt(len(suppliers), 5)] {
		labels = append(labels, fmt.Sprintf("%s(%s, ID:%d)", supplier.Name, supplier.SupplierCode, supplier.ID))
	}
	return nil, fmt.Errorf("供应商“%s”匹配到多个结果，请确认供应商 ID：%s", query, strings.Join(labels, "、"))
}

func resolveERPOrderItem(items []model.TradeOrderItem, itemID int64, query string) (*model.TradeOrderItem, error) {
	if itemID > 0 {
		for index := range items {
			if items[index].ID == itemID {
				return &items[index], nil
			}
		}
		return nil, fmt.Errorf("产品 ID %d 不属于当前业务单或不可见", itemID)
	}
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, fmt.Errorf("请提供产品 ID、SKU 或产品名称用于匹配")
	}
	needle := normalizeERPMatchText(query)
	exact := make([]int, 0)
	contains := make([]int, 0)
	for index := range items {
		candidates := []string{items[index].SKU, items[index].ProductName, items[index].Specification}
		matchedContains := false
		for _, candidate := range candidates {
			normalized := normalizeERPMatchText(candidate)
			if normalized == needle && normalized != "" {
				exact = append(exact, index)
				matchedContains = true
				break
			}
			if needle != "" && strings.Contains(normalized, needle) {
				matchedContains = true
			}
		}
		if matchedContains && !containsInt(exact, index) {
			contains = append(contains, index)
		}
	}
	if len(exact) == 1 {
		return &items[exact[0]], nil
	}
	if len(exact) == 0 && len(contains) == 1 {
		return &items[contains[0]], nil
	}
	matches := exact
	if len(matches) == 0 {
		matches = contains
	}
	if len(matches) == 0 {
		return nil, fmt.Errorf("当前业务单中没有匹配产品“%s”", query)
	}
	labels := make([]string, 0, minInt(len(matches), 5))
	for _, index := range matches[:minInt(len(matches), 5)] {
		labels = append(labels, fmt.Sprintf("%s/%s(ID:%d)", items[index].SKU, items[index].ProductName, items[index].ID))
	}
	return nil, fmt.Errorf("产品“%s”匹配到多个结果，请确认产品 ID：%s", query, strings.Join(labels, "、"))
}

func mergeERPTradeCustomerUpdate(current *model.TradeCustomer, changes map[string]any) (*model.UpdateTradeCustomerRequest, []string, error) {
	if current == nil {
		return nil, nil, fmt.Errorf("客户资料不存在")
	}
	base := map[string]any{
		"name": current.Name, "company_name": current.CompanyName, "country": current.Country,
		"region": current.Region, "contact_name": current.ContactName, "email": current.Email,
		"phone": current.Phone, "source": current.Source, "status": current.Status,
		"customer_level": current.CustomerLevel, "whatsapp_account_id": current.WhatsAppAccountID,
		"whatsapp_chat_id": current.WhatsAppChatID, "whatsapp_chat_name": current.WhatsAppChatName,
		"avatar_url": current.AvatarURL, "tags": current.Tags, "notes": current.Notes,
		"workbook_folder_id": current.WorkbookFolderID,
	}
	labels := map[string]string{
		"name": "客户名称", "company_name": "公司全称", "country": "国家", "region": "地区",
		"contact_name": "联系人", "email": "邮箱", "phone": "电话 / WhatsApp", "source": "来源",
		"status": "状态", "customer_level": "客户等级", "whatsapp_chat_name": "WhatsApp 名称",
		"tags": "标签", "notes": "备注", "workbook_folder_id": "默认工作簿文件夹",
	}
	details := make([]string, 0, len(changes))
	keys := make([]string, 0, len(changes))
	for key := range changes {
		if _, allowed := base[key]; allowed {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	for _, key := range keys {
		base[key] = changes[key]
		label := firstNonEmptyTrade(labels[key], key)
		details = append(details, fmt.Sprintf("%s：%s", label, printableERPValue(changes[key])))
	}
	if len(details) == 0 {
		return nil, nil, fmt.Errorf("没有可修改的客户字段")
	}
	var request model.UpdateTradeCustomerRequest
	if err := decodeERPValue(base, &request); err != nil {
		return nil, nil, fmt.Errorf("客户修改内容无效: %w", err)
	}
	return &request, details, nil
}

func erpOrderHeaderForAgent(order *model.TradeOrder) map[string]any {
	if order == nil {
		return map[string]any{}
	}
	return map[string]any{
		"id": order.ID, "order_no": order.OrderNo, "title": order.Title,
		"customer_id": order.CustomerID, "customer_name": order.CustomerName,
		"stage": order.Stage, "stage_label": tradeStageLabel(order.Stage),
		"owner_name": order.OwnerName, "item_count": order.ItemCount,
		"required_position": order.RequiredPositionName,
		"can_operate_stage": order.CanOperateStage, "can_advance": order.CanAdvance,
		"can_return": order.CanReturn, "advance_blockers": order.AdvanceBlockers,
	}
}

func erpOrderForAgent(order *model.TradeOrder) map[string]any {
	result := erpOrderHeaderForAgent(order)
	if order == nil {
		return result
	}
	result["currency"] = order.Currency
	result["destination"] = mergeTradeDestination(order.DestinationCountry, order.DestinationPort)
	result["payment_method"] = firstNonEmptyTrade(order.PaymentMethod, order.PaymentTerms)
	result["access"] = order.Access
	result["items"] = order.Items
	result["supplier_quotes"] = order.SupplierQuotes
	result["customer_quotes"] = order.CustomerQuotes
	result["shipment"] = order.Shipment
	result["profit_summary"] = order.ProfitSummary
	result["recent_events"] = tailERPEvents(order.Events, 8)
	return result
}

func erpWorkflowForAgent() []map[string]string {
	stages := append([]string{}, tradeStageOrder...)
	result := make([]map[string]string, 0, len(stages))
	for _, stage := range stages {
		result = append(result, map[string]string{"stage": stage, "label": tradeStageLabel(stage)})
	}
	return result
}

func tailERPEvents(events []model.TradeOrderStageEvent, limit int) []model.TradeOrderStageEvent {
	if len(events) <= limit {
		return events
	}
	return events[len(events)-limit:]
}

func newStoredERPAction(kind string, preview ERPActionPreview, payload any) (*storedERPAction, []string, error) {
	return newStoredERPActionWithWarnings(kind, preview, payload, nil)
}

func newStoredERPActionWithWarnings(kind string, preview ERPActionPreview, payload any, warnings []string) (*storedERPAction, []string, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("编码 ERP 操作失败: %w", err)
	}
	return &storedERPAction{Kind: kind, Preview: preview, Payload: raw}, warnings, nil
}

func nestedERPMap(raw map[string]any, key string) map[string]any {
	if raw == nil {
		return nil
	}
	value, _ := raw[key].(map[string]any)
	return value
}

func decodeERPValue(value any, target any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, target)
}

func optionalERPInt64(raw map[string]any, key string) int64 {
	if raw == nil {
		return 0
	}
	switch value := raw[key].(type) {
	case float64:
		return int64(value)
	case int:
		return int64(value)
	case int64:
		return value
	case json.Number:
		parsed, _ := value.Int64()
		return parsed
	case string:
		parsed, _ := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		return parsed
	default:
		return 0
	}
}

func stringValue(value any) string {
	if value == nil {
		return ""
	}
	text, ok := value.(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(text)
}

func normalizeERPMatchText(value string) string {
	return strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(value)), " "))
}

func containsInt(values []int, target int) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

func clampInt(value, minimum, maximum int) int {
	if value < minimum {
		return minimum
	}
	if value > maximum {
		return maximum
	}
	return value
}

func compactERPDetails(values []string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
		if len(result) >= 18 {
			break
		}
	}
	return result
}

func emptyERPLabel(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return "未填写"
	}
	return value
}

func yesNoERP(value bool) string {
	if value {
		return "是"
	}
	return "否"
}

func printableERPValue(value any) string {
	if value == nil {
		return "清空"
	}
	if values, ok := value.([]any); ok {
		parts := make([]string, 0, len(values))
		for _, item := range values {
			parts = append(parts, fmt.Sprint(item))
		}
		return strings.Join(parts, "、")
	}
	text := strings.TrimSpace(fmt.Sprint(value))
	if text == "" {
		return "清空"
	}
	return text
}

func formatERPNumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func erpActionToolSchema() map[string]any {
	productProperties := map[string]any{
		"sku":           map[string]any{"type": "string"},
		"product_name":  map[string]any{"type": "string"},
		"description":   map[string]any{"type": "string"},
		"specification": map[string]any{"type": "string"},
		"quantity":      map[string]any{"type": "number"},
		"unit":          map[string]any{"type": "string"},
		"target_price":  map[string]any{"type": "number"},
	}
	orderReferenceProperties := map[string]any{
		"order_id":    map[string]any{"type": "integer"},
		"order_query": map[string]any{"type": "string", "description": "Order number, exact inquiry title, customer, SKU, or product keyword."},
	}
	actionProperties := map[string]any{
		"kind": map[string]any{
			"type": "string",
			"enum": []string{"create_customer", "update_customer", "create_supplier", "create_inquiry", "add_inquiry_items", "record_supplier_quotes", "create_customer_quote", "update_stage_data", "advance_order"},
		},
		"customer_id":    map[string]any{"type": "integer"},
		"customer_query": map[string]any{"type": "string"},
		"order_id":       orderReferenceProperties["order_id"],
		"order_query":    orderReferenceProperties["order_query"],
		"customer": map[string]any{
			"type":        "object",
			"description": "Customer fields for create_customer.",
			"properties": map[string]any{
				"name": map[string]any{"type": "string"}, "company_name": map[string]any{"type": "string"},
				"country": map[string]any{"type": "string"}, "region": map[string]any{"type": "string"},
				"contact_name": map[string]any{"type": "string"}, "email": map[string]any{"type": "string"},
				"phone": map[string]any{"type": "string"}, "source": map[string]any{"type": "string"},
				"customer_level": map[string]any{"type": "string"}, "tags": map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
				"notes": map[string]any{"type": "string"}, "workbook_folder_id": map[string]any{"type": "integer"},
				"create_channel": map[string]any{"type": "boolean"},
			},
		},
		"changes": map[string]any{"type": "object", "description": "Only changed customer fields for update_customer; empty strings intentionally clear a field."},
		"supplier": map[string]any{
			"type":        "object",
			"description": "Supplier fields for create_supplier.",
			"properties": map[string]any{
				"name": map[string]any{"type": "string"}, "company_name": map[string]any{"type": "string"},
				"contact_name": map[string]any{"type": "string"}, "phone": map[string]any{"type": "string"},
				"email": map[string]any{"type": "string"}, "whatsapp": map[string]any{"type": "string"},
				"country": map[string]any{"type": "string"}, "default_currency": map[string]any{"type": "string"},
				"payment_method": map[string]any{"type": "string"}, "notes": map[string]any{"type": "string"},
			},
		},
		"inquiry": map[string]any{
			"type":        "object",
			"description": "Create-inquiry fields. customer_id or customer_query must identify exactly one visible customer.",
			"properties": map[string]any{
				"customer_id": map[string]any{"type": "integer"}, "customer_query": map[string]any{"type": "string"},
				"title": map[string]any{"type": "string"}, "priority": map[string]any{"type": "string"},
				"quote_deadline": map[string]any{"type": "string"}, "currency": map[string]any{"type": "string"},
				"destination_country": map[string]any{"type": "string"}, "destination_port": map[string]any{"type": "string"},
				"payment_method": map[string]any{"type": "string"}, "notes": map[string]any{"type": "string"},
				"create_workspace": map[string]any{"type": "boolean"}, "shared_workspace": map[string]any{"type": "boolean"},
				"workbook_folder_id": map[string]any{"type": "integer"},
				"items":              map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": productProperties}},
			},
		},
		"items": map[string]any{"type": "array", "description": "Products for add_inquiry_items.", "items": map[string]any{"type": "object", "properties": productProperties}},
		"quotes": map[string]any{
			"type":        "array",
			"description": "Supplier quotes. Use IDs from search tools when possible; SKU and supplier_query are accepted only when they uniquely match.",
			"items": map[string]any{"type": "object", "properties": map[string]any{
				"order_item_id": map[string]any{"type": "integer"}, "sku": map[string]any{"type": "string"}, "product_query": map[string]any{"type": "string"},
				"supplier_id": map[string]any{"type": "integer"}, "supplier_query": map[string]any{"type": "string"},
				"currency": map[string]any{"type": "string"}, "unit_price": map[string]any{"type": "number"},
				"moq": map[string]any{"type": "number"}, "lead_time_days": map[string]any{"type": "integer"},
				"valid_until": map[string]any{"type": "string"}, "notes": map[string]any{"type": "string"},
			}},
		},
		"quote": map[string]any{
			"type":        "object",
			"description": "Customer quote fields for create_customer_quote.",
			"properties": map[string]any{
				"currency": map[string]any{"type": "string"}, "exchange_rate_cny": map[string]any{"type": "number"},
				"profit_margin_percent": map[string]any{"type": "number", "description": "Optional cost markup percentage; applied only when the current employee may view purchase costs."},
				"freight_mode":          map[string]any{"type": "string"}, "freight_amount": map[string]any{"type": "number"},
				"status":            map[string]any{"type": "string", "description": "draft or sent; prefer draft when user has not explicitly approved sending."},
				"customer_feedback": map[string]any{"type": "string"}, "notes": map[string]any{"type": "string"},
				"items": map[string]any{"type": "array", "items": map[string]any{"type": "object", "properties": map[string]any{
					"order_item_id": map[string]any{"type": "integer"}, "sku": map[string]any{"type": "string"},
					"product_query": map[string]any{"type": "string"}, "unit_price": map[string]any{"type": "number"},
				}}},
			},
		},
		"stage_data": map[string]any{
			"type":        "object",
			"description": "Current-stage item or shipment data. Product rows may identify an item with order_item_id, sku, or product_query.",
			"properties": map[string]any{
				"items":    map[string]any{"type": "array", "items": map[string]any{"type": "object"}},
				"shipment": map[string]any{"type": "object"},
			},
		},
		"to_stage": map[string]any{"type": "string", "description": "Use next/previous or an adjacent ERP stage code."},
		"note":     map[string]any{"type": "string"},
	}
	return map[string]any{
		"type": "object",
		"properties": map[string]any{
			"action": map[string]any{"type": "object", "properties": actionProperties, "required": []string{"kind"}},
		},
		"required": []string{"action"},
	}
}
