package service

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type AITradeOrderPreviewRequest struct {
	AssistantID *int64 `json:"assistant_id"`
	RawText     string `json:"raw_text" binding:"required"`
	TargetStage string `json:"target_stage"`
}

type AITradeOrderImportItem struct {
	SKU               string  `json:"sku"`
	ProductName       string  `json:"product_name"`
	Description       string  `json:"description"`
	Specification     string  `json:"specification"`
	Quantity          float64 `json:"quantity"`
	Unit              string  `json:"unit"`
	SalesUnitPrice    float64 `json:"sales_unit_price"`
	SupplierName      string  `json:"supplier_name"`
	PurchaseCurrency  string  `json:"purchase_currency"`
	PurchaseUnitPrice float64 `json:"purchase_unit_price"`
}

type AITradeOrderImportDraft struct {
	ImportID           string                   `json:"import_id"`
	RawText            string                   `json:"raw_text"`
	AssistantID        int64                    `json:"assistant_id,omitempty"`
	Model              string                   `json:"model,omitempty"`
	TargetStage        string                   `json:"target_stage"`
	CustomerID         int64                    `json:"customer_id,omitempty"`
	CustomerQuery      string                   `json:"customer_query"`
	CustomerName       string                   `json:"customer_name"`
	Country            string                   `json:"country"`
	Title              string                   `json:"title"`
	Priority           string                   `json:"priority"`
	Currency           string                   `json:"currency"`
	DestinationCountry string                   `json:"destination_country"`
	PaymentMethod      string                   `json:"payment_method"`
	SettlementCurrency string                   `json:"settlement_currency"`
	SettlementAmount   float64                  `json:"settlement_amount"`
	GoodsAmount        float64                  `json:"goods_amount"`
	ShippingCost       float64                  `json:"shipping_cost"`
	TotalAmount        float64                  `json:"total_amount"`
	WorkbookFolderID   *int64                   `json:"workbook_folder_id,omitempty"`
	CreateWorkspace    bool                     `json:"create_workspace"`
	SharedWorkspace    bool                     `json:"shared_workspace"`
	Items              []AITradeOrderImportItem `json:"items"`
	Warnings           []string                 `json:"warnings"`
	MissingFields      []string                 `json:"missing_fields"`
	Confidence         float64                  `json:"confidence"`
}

type AITradeOrderApplyRequest struct {
	Draft AITradeOrderImportDraft `json:"draft" binding:"required"`
}

var (
	aiTradeSKURegexp       = regexp.MustCompile(`(?i)\b[A-Z0-9]{2,}(?:-[A-Z0-9]{2,}){2,}\b`)
	aiTradeSalesRegexp     = regexp.MustCompile(`(?i)\$\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeQuantityRegexp  = regexp.MustCompile(`(?i)(?:卖|售|数量|qty\.?|quantity)\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeMultiplyRegexp  = regexp.MustCompile(`(?i)([0-9]+(?:\.[0-9]+)?)\s*[x×*]\s*([0-9]+(?:\.[0-9]+)?)\s*=\s*\$?\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeShippingRegexp  = regexp.MustCompile(`(?i)(?:shipping\s*(?:cost)?|freight|运费)\s*[:：]?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeTotalRegexp     = regexp.MustCompile(`(?i)(?:total|合计|总计)\s*[:：]?\s*\$?\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeSettlementRegex = regexp.MustCompile(`(?i)(?:pay|payment|支付|付款)\s*([A-Z]{3})?\s*[:：]?\s*([0-9]+(?:\.[0-9]+)?)`)
	aiTradeNumberRegexp    = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)`)
	aiTradeCustomerLine    = regexp.MustCompile(`(?i)^\s*(?:customer|client|buyer|consignee|客户|买家)\s*[:：]?\s*(.+?)\s*$`)
)

func (s *AIService) PreviewAITradeOrder(userID int64, request *AITradeOrderPreviewRequest) (*AITradeOrderImportDraft, error) {
	if s.tradeService == nil {
		return nil, fmt.Errorf("ERP Agent 尚未启用")
	}
	if request == nil || strings.TrimSpace(request.RawText) == "" {
		return nil, fmt.Errorf("请粘贴需要识别的订单原始资料")
	}
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, err
	}
	if !profile.CanCreateOrders {
		return nil, fmt.Errorf("当前岗位没有 AI 建单权限")
	}

	rawText := strings.TrimSpace(request.RawText)
	if len([]rune(rawText)) > 100000 {
		return nil, fmt.Errorf("订单原始资料不能超过 100000 个字符")
	}
	draft := heuristicAITradeOrderDraft(rawText)
	assistantID := int64(0)
	if request.AssistantID != nil {
		assistantID = *request.AssistantID
	}
	assistant, assistantErr := s.resolveAIAssistant(assistantID)
	if assistantErr == nil {
		aiDraft, parseErr := s.parseAITradeOrderWithAssistant(userID, assistant, rawText)
		if parseErr == nil {
			draft = aiDraft
			draft.AssistantID = assistant.ID
			draft.Model = assistant.Model
		} else {
			draft.Warnings = append(
				draft.Warnings,
				fmt.Sprintf("AI 模型识别失败，已自动使用本地规则解析：%v", parseErr),
			)
		}
	} else {
		draft.Warnings = append(draft.Warnings, "尚未配置可用 AI 助手，本次使用本地规则解析；建议在管理后台配置模型后重新识别。")
	}
	draft.RawText = rawText
	draft.ImportID = newAITradeImportID()
	draft.TargetStage = model.TradeStageReceiving
	draft.CreateWorkspace = true
	draft.SharedWorkspace = false
	s.normalizeAITradeOrderDraft(userID, draft)
	return draft, nil
}

func (s *AIService) parseAITradeOrderWithAssistant(userID int64, assistant *activeAIAssistant, rawText string) (*AITradeOrderImportDraft, error) {
	customers, _ := s.tradeService.ListCustomers(userID, "")
	suppliers, _ := s.tradeService.ListSuppliers(userID, "")
	if len(customers) > 120 {
		customers = customers[:120]
	}
	if len(suppliers) > 120 {
		suppliers = suppliers[:120]
	}
	customerContext := make([]map[string]any, 0, len(customers))
	for _, customer := range customers {
		customerContext = append(customerContext, map[string]any{"id": customer.ID, "name": customer.Name, "company": customer.CompanyName, "country": customer.Country})
	}
	supplierContext := make([]map[string]any, 0, len(suppliers))
	for _, supplier := range suppliers {
		supplierContext = append(supplierContext, map[string]any{"id": supplier.ID, "name": supplier.Name, "company": supplier.CompanyName, "currency": supplier.DefaultCurrency})
	}
	contextJSON, _ := json.Marshal(map[string]any{"customers": customerContext, "suppliers": supplierContext})
	systemPrompt := `你是外贸 ERP 订单资料解析器。把任意语言、乱序、带算式或聊天式原文整理成一个 JSON 对象，不要输出 Markdown。不得猜测缺失币种、付款状态、到货数量或产品名称；SKU 可以暂时代替产品名称，但要把 product_name 加入 missing_fields。Pay/付款金额只表示付款指令，不代表已经收款。目标阶段固定 receiving，表示等待仓库登记到货。JSON 字段：customer_id,customer_query,customer_name,country,title,priority,currency,destination_country,payment_method,settlement_currency,settlement_amount,goods_amount,shipping_cost,total_amount,items,warnings,missing_fields,confidence。items 字段：sku,product_name,description,specification,quantity,unit,sales_unit_price,supplier_name,purchase_currency,purchase_unit_price。金额和数量使用数字。confidence 为 0 到 1。`
	response, err := s.callAssistantCompletionJSON(assistant, []ChatMessage{
		{Role: "system", Content: systemPrompt},
		{Role: "user", Content: fmt.Sprintf("现有可匹配资料：%s\n\n订单原文：\n%s", string(contextJSON), rawText)},
	}, aiTradeOrderImportSchema())
	if err != nil {
		return nil, fmt.Errorf("AI 订单识别失败: %w", err)
	}
	var draft AITradeOrderImportDraft
	if err := json.Unmarshal([]byte(extractJSONObject(response.Reply)), &draft); err != nil {
		return nil, fmt.Errorf("AI 返回的订单结构无法解析: %w", err)
	}
	draft.Model = firstNonEmpty(response.Model, assistant.Model)
	return &draft, nil
}

func aiTradeOrderImportSchema() map[string]any {
	text := map[string]any{"type": "string"}
	number := map[string]any{"type": "number"}
	item := map[string]any{
		"type": "object",
		"properties": map[string]any{
			"sku": text, "product_name": text, "description": text, "specification": text,
			"quantity": number, "unit": text, "sales_unit_price": number,
			"supplier_name": text, "purchase_currency": text, "purchase_unit_price": number,
		},
		"required":             []string{"sku", "product_name", "description", "specification", "quantity", "unit", "sales_unit_price", "supplier_name", "purchase_currency", "purchase_unit_price"},
		"additionalProperties": false,
	}
	return map[string]any{
		"type": "json_schema", "name": "yaerp_trade_order_import", "strict": true,
		"schema": map[string]any{
			"type": "object",
			"properties": map[string]any{
				"customer_id": map[string]any{"type": "integer"}, "customer_query": text, "customer_name": text,
				"country": text, "title": text, "priority": text, "currency": text,
				"destination_country": text, "payment_method": text, "settlement_currency": text,
				"settlement_amount": number, "goods_amount": number, "shipping_cost": number, "total_amount": number,
				"items":          map[string]any{"type": "array", "items": item},
				"warnings":       map[string]any{"type": "array", "items": text},
				"missing_fields": map[string]any{"type": "array", "items": text}, "confidence": number,
			},
			"required":             []string{"customer_id", "customer_query", "customer_name", "country", "title", "priority", "currency", "destination_country", "payment_method", "settlement_currency", "settlement_amount", "goods_amount", "shipping_cost", "total_amount", "items", "warnings", "missing_fields", "confidence"},
			"additionalProperties": false,
		},
	}
}

func (s *AIService) normalizeAITradeOrderDraft(userID int64, draft *AITradeOrderImportDraft) {
	if draft == nil {
		return
	}
	draft.CustomerQuery = strings.TrimSpace(firstNonEmptyTrade(draft.CustomerQuery, draft.CustomerName))
	draft.CustomerName = strings.TrimSpace(firstNonEmptyTrade(draft.CustomerName, draft.CustomerQuery))
	draft.Country = strings.TrimSpace(draft.Country)
	draft.Currency = strings.ToUpper(strings.TrimSpace(draft.Currency))
	currencyMissing := draft.Currency == ""
	if draft.Currency == "" {
		draft.Currency = "USD"
	}
	draft.SettlementCurrency = strings.ToUpper(strings.TrimSpace(draft.SettlementCurrency))
	draft.Priority = strings.ToLower(strings.TrimSpace(draft.Priority))
	if draft.Priority != "low" && draft.Priority != "high" && draft.Priority != "urgent" {
		draft.Priority = "normal"
	}
	draft.DestinationCountry = strings.TrimSpace(firstNonEmptyTrade(draft.DestinationCountry, draft.Country))
	draft.TargetStage = model.TradeStageReceiving
	draft.SharedWorkspace = false
	if draft.Confidence < 0 {
		draft.Confidence = 0
	}
	if draft.Confidence > 1 {
		draft.Confidence = 1
	}

	if draft.CustomerID <= 0 && draft.CustomerQuery != "" {
		if matches, err := s.tradeService.ListCustomers(userID, draft.CustomerQuery); err == nil {
			draft.CustomerID = uniqueAITradeCustomerMatch(matches, draft.CustomerQuery)
		}
	}
	missing := append([]string(nil), draft.MissingFields...)
	if currencyMissing {
		missing = append(missing, "报价币种")
		draft.Warnings = append(draft.Warnings, "原文未明确报价币种，订单暂以 USD 占位，请人工核对。")
	}
	if draft.CustomerID <= 0 {
		missing = append(missing, "客户")
	}
	if len(draft.Items) == 0 {
		draft.Items = []AITradeOrderImportItem{{Quantity: 1, Unit: "件"}}
		missing = append(missing, "产品明细")
	}
	calculatedGoods := 0.0
	for index := range draft.Items {
		item := &draft.Items[index]
		item.SKU = strings.TrimSpace(item.SKU)
		item.ProductName = strings.TrimSpace(item.ProductName)
		item.Specification = strings.TrimSpace(item.Specification)
		item.SupplierName = strings.TrimSpace(item.SupplierName)
		item.PurchaseCurrency = strings.ToUpper(strings.TrimSpace(item.PurchaseCurrency))
		if item.Quantity <= 0 {
			item.Quantity = 1
			missing = append(missing, fmt.Sprintf("第%d项数量", index+1))
		}
		if strings.TrimSpace(item.Unit) == "" {
			item.Unit = "件"
		}
		productNameMissing := item.ProductName == "" || (item.SKU != "" && strings.EqualFold(item.ProductName, item.SKU))
		if item.ProductName == "" {
			item.ProductName = item.SKU
		}
		if item.ProductName == "" {
			item.ProductName = fmt.Sprintf("待补产品 %d", index+1)
		}
		if productNameMissing {
			missing = append(missing, fmt.Sprintf("第%d项产品名称", index+1))
		}
		if item.SalesUnitPrice <= 0 {
			missing = append(missing, fmt.Sprintf("第%d项对客单价", index+1))
		}
		if item.SupplierName == "" {
			missing = append(missing, fmt.Sprintf("第%d项供应商", index+1))
		}
		if item.PurchaseUnitPrice > 0 && item.PurchaseCurrency == "" {
			missing = append(missing, fmt.Sprintf("第%d项采购币种", index+1))
		}
		if item.PurchaseUnitPrice <= 0 && item.SupplierName != "" {
			missing = append(missing, fmt.Sprintf("第%d项采购单价", index+1))
		}
		calculatedGoods += item.Quantity * math.Max(item.SalesUnitPrice, 0)
	}
	if draft.GoodsAmount <= 0 && calculatedGoods > 0 {
		draft.GoodsAmount = calculatedGoods
	}
	if calculatedGoods > 0 && draft.GoodsAmount > 0 && math.Abs(calculatedGoods-draft.GoodsAmount) > 0.02 {
		draft.Warnings = append(draft.Warnings, fmt.Sprintf("产品金额 %.2f 与原文商品金额 %.2f 不一致，请核对。", calculatedGoods, draft.GoodsAmount))
	}
	calculatedTotal := draft.GoodsAmount + math.Max(draft.ShippingCost, 0)
	if draft.TotalAmount <= 0 && calculatedTotal > 0 {
		draft.TotalAmount = calculatedTotal
	}
	if calculatedTotal > 0 && draft.TotalAmount > 0 && math.Abs(calculatedTotal-draft.TotalAmount) > 0.02 {
		draft.Warnings = append(draft.Warnings, fmt.Sprintf("商品加运费 %.2f 与原文总额 %.2f 不一致，请核对。", calculatedTotal, draft.TotalAmount))
	}
	if strings.TrimSpace(draft.Title) == "" {
		label := draft.CustomerName
		if label == "" {
			label = "待确认客户"
		}
		draft.Title = fmt.Sprintf("%s %s 到货资料", label, firstNonEmptyTrade(draft.Items[0].SKU, draft.Items[0].ProductName))
	}
	draft.MissingFields = uniqueTradeImportStrings(missing)
	draft.Warnings = uniqueTradeImportStrings(draft.Warnings)
}

func (s *AIService) ApplyAITradeOrder(userID int64, request *AITradeOrderApplyRequest) (*model.TradeOrder, error) {
	if request == nil {
		return nil, fmt.Errorf("AI 建单资料不能为空")
	}
	draft := request.Draft
	if strings.TrimSpace(draft.ImportID) == "" {
		return nil, fmt.Errorf("AI 建单编号缺失，请重新识别原始资料")
	}
	if len([]rune(strings.TrimSpace(draft.RawText))) > 100000 {
		return nil, fmt.Errorf("订单原始资料不能超过 100000 个字符")
	}
	profile, err := s.tradeService.AccessProfile(userID)
	if err != nil {
		return nil, err
	}
	if !profile.CanCreateOrders {
		return nil, fmt.Errorf("当前岗位没有 AI 建单权限")
	}
	unlockImport, err := s.tradeService.repo.LockAIImport(draft.ImportID)
	if errors.Is(err, repo.ErrAIImportInProgress) {
		return nil, fmt.Errorf("同一份 AI 订单资料正在创建，请稍后重新提交")
	}
	if err != nil {
		return nil, err
	}
	defer unlockImport()
	// Keep semantic gaps identified during preview (for example, an unspecified
	// currency that currently uses a display fallback), then merge structural
	// blockers recalculated from the edited values below. Completing the import
	// still requires a separate explicit acknowledgement on the created order.
	s.normalizeAITradeOrderDraft(userID, &draft)
	if existing, findErr := s.tradeService.repo.GetOrderByAIImportID(draft.ImportID, userID, profile.CanViewAllOrders); findErr == nil {
		return s.finishAITradeOrderImport(userID, &draft, existing)
	} else if !errors.Is(findErr, sql.ErrNoRows) {
		return nil, findErr
	}

	var customer *model.TradeCustomer
	if draft.CustomerID > 0 {
		customer, err = s.tradeService.getCustomer(userID, draft.CustomerID)
		if err != nil {
			return nil, fmt.Errorf("所选客户不存在或无权访问")
		}
	} else {
		// Unmatched names are common in pasted chat histories. Create a private
		// lead when the operator has customer-creation permission so the order
		// can still be staged for receiving and completed later.
		name := strings.TrimSpace(firstNonEmptyTrade(draft.CustomerName, draft.CustomerQuery))
		if name == "" {
			return nil, fmt.Errorf("请补充客户名称后再创建订单")
		}
		if !profile.CanCreateCustomers {
			return nil, fmt.Errorf("未匹配到已有客户，当前岗位也没有自动建立客户档案的权限")
		}
		createChannel := false
		customer, err = s.tradeService.CreateCustomer(userID, &model.CreateTradeCustomerRequest{
			Name: name, CompanyName: name, Country: draft.Country,
			Source: "other", CustomerLevel: "B", WorkbookFolderID: draft.WorkbookFolderID,
			Notes:         fmt.Sprintf("AI 自动建立的待核验客户档案。导入编号：%s", draft.ImportID),
			CreateChannel: &createChannel,
		})
		if err != nil {
			return nil, fmt.Errorf("自动建立客户档案失败: %w", err)
		}
		draft.CustomerID = customer.ID
		draft.Warnings = uniqueTradeImportStrings(append(draft.Warnings, "未匹配到已有客户，已自动建立待核验客户档案。"))
	}
	if !profile.IsAdmin && !profile.IsManager && customer.OwnerID != userID {
		return nil, fmt.Errorf("只有管理员、业务经理或客户负责人可以把历史资料直接导入到仓库到货阶段")
	}

	createWorkspace := false
	sharedWorkspace := false
	createRequest := model.CreateTradeOrderRequest{
		CustomerID: draft.CustomerID, Title: strings.TrimSpace(draft.Title), Priority: draft.Priority,
		Currency: draft.Currency, DestinationCountry: draft.DestinationCountry,
		PaymentMethod: draft.PaymentMethod, PaymentTerms: draft.PaymentMethod,
		WorkbookFolderID: draft.WorkbookFolderID, CreateWorkspace: &createWorkspace, SharedWorkspace: &sharedWorkspace,
		Notes: aiTradeImportNotes(&draft), Items: make([]model.CreateTradeOrderItemRequest, 0, len(draft.Items)),
		AIImportID: draft.ImportID, AISourceText: draft.RawText,
		AIMissingFields: append([]string(nil), draft.MissingFields...), AIImportModel: draft.Model,
	}
	for _, item := range draft.Items {
		createRequest.Items = append(createRequest.Items, model.CreateTradeOrderItemRequest{
			SKU: item.SKU, ProductName: item.ProductName, Description: item.Description,
			Specification: item.Specification, Quantity: item.Quantity, Unit: item.Unit, TargetPrice: item.SalesUnitPrice,
		})
	}
	order, err := s.tradeService.CreateOrder(userID, &createRequest)
	if err != nil {
		// The unique import id is written in the same transaction as the order and
		// its base items. A concurrent/retried request resumes that durable order.
		if existing, findErr := s.tradeService.repo.GetOrderByAIImportID(draft.ImportID, userID, profile.CanViewAllOrders); findErr == nil {
			return s.finishAITradeOrderImport(userID, &draft, existing)
		}
		return nil, err
	}
	return s.finishAITradeOrderImport(userID, &draft, order)
}

// finishAITradeOrderImport is intentionally idempotent. The base order stores
// its import id and raw audit data atomically, so a request interrupted during
// enrichment, stage advancement, or workspace creation can resume safely.
func (s *AIService) finishAITradeOrderImport(userID int64, draft *AITradeOrderImportDraft, order *model.TradeOrder) (*model.TradeOrder, error) {
	if draft == nil || order == nil {
		return nil, fmt.Errorf("AI 建单恢复资料不完整")
	}
	if order.Source != "ai_import" || strings.TrimSpace(order.AIImportID) != strings.TrimSpace(draft.ImportID) {
		return nil, fmt.Errorf("AI 建单编号与已有订单不匹配")
	}
	if order.Stage != model.TradeStageInquiry && order.Stage != model.TradeStageReceiving {
		return s.tradeService.GetOrder(userID, order.ID)
	}

	advanced := false
	if order.Stage == model.TradeStageInquiry {
		items, err := s.tradeService.repo.ListOrderItems(order.ID)
		if err != nil {
			return nil, err
		}
		if len(items) != len(draft.Items) {
			return nil, fmt.Errorf("AI 导入产品行数与已创建订单不一致，请保留导入编号并联系管理员处理")
		}
		for index := range items {
			input := draft.Items[index]
			item := &items[index]
			item.QuotedPrice = math.Max(input.SalesUnitPrice, 0)
			item.SupplierName = input.SupplierName
			item.PurchaseCurrency = input.PurchaseCurrency
			item.PurchasePrice = math.Max(input.PurchaseUnitPrice, 0)
			item.ReceivedQuantity = 0
			item.Status = "待到货"
			if item.WorkflowData == nil {
				item.WorkflowData = map[string]any{}
			}
			item.WorkflowData["purchase_status"] = "AI 导入，待核验"
			item.WorkflowData["receipt_status"] = "待到货"
			item.WorkflowData["ai_import"] = true
			if err := s.tradeService.repo.UpsertOrderItemFromWorkbook(item); err != nil {
				return nil, err
			}
		}
		if err := s.tradeService.repo.UpdateImportedOrderCommercials(order.ID, draft.Currency, math.Max(draft.ShippingCost, 0), aiTradeImportNotes(draft)); err != nil {
			return nil, err
		}
		if err := s.tradeService.repo.AdvanceOrder(order.ID, userID, true, model.TradeStageInquiry, model.TradeStageReceiving, "AI 历史资料导入至仓库到货，上游资料待人工核验"); err != nil {
			return nil, err
		}
		if err := s.tradeService.repo.SetOrderAIImportMetadata(order.ID, draft.ImportID, draft.RawText, draft.Model, draft.MissingFields); err != nil {
			return nil, err
		}
		advanced = true
	} else if order.DataStatus == "importing" {
		// This covers a previously interrupted run where the stage change was
		// committed but the final completeness state was not persisted.
		if err := s.tradeService.repo.SetOrderAIImportMetadata(order.ID, draft.ImportID, draft.RawText, draft.Model, draft.MissingFields); err != nil {
			return nil, err
		}
	}

	order, err := s.tradeService.repo.GetOrder(order.ID, userID, true)
	if err != nil {
		return nil, err
	}
	items, err := s.tradeService.repo.ListOrderItems(order.ID)
	if err != nil {
		return nil, err
	}
	if draft.CreateWorkspace && order.WorkbookID == nil {
		customer, customerErr := s.tradeService.repo.GetCustomerIncludingDeleted(order.CustomerID, userID, true)
		if customerErr != nil {
			return nil, customerErr
		}
		workbook, firstSheetID, workspaceErr := s.tradeService.createOrderWorkspace(userID, order, customer, items, false)
		if workspaceErr != nil {
			return nil, workspaceErr
		}
		if err := s.tradeService.repo.SetOrderWorkspace(order.ID, order.OwnerID, workbook.ID, order.WorkspaceFolderID); err != nil {
			_ = s.tradeService.sheetSvc.DeleteWorkbookForUser(userID, workbook.ID)
			return nil, err
		}
		order.WorkbookID = &workbook.ID
		order.WorkbookSheetID = &firstSheetID
	}
	if advanced {
		if order.ChannelID != nil {
			_, _ = s.tradeService.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
				Content:          fmt.Sprintf("AI 已从原始资料创建业务单 %s，并导入到【仓库到货】。待补字段：%s", order.OrderNo, firstNonEmptyTrade(strings.Join(draft.MissingFields, "、"), "无")),
				LinkedWorkbookID: order.WorkbookID, InternalOnly: true,
			})
		}
		s.tradeService.notifyStageAssignees(order, model.TradeStageReceiving, "AI 导入订单待核验并登记到货")
	}
	s.tradeService.notifyOrderUpdated(order.ID)
	return s.tradeService.GetOrder(userID, order.ID)
}

func heuristicAITradeOrderDraft(rawText string) *AITradeOrderImportDraft {
	draft := &AITradeOrderImportDraft{Priority: "normal", TargetStage: model.TradeStageReceiving, CreateWorkspace: true, Confidence: 0.56}
	item := AITradeOrderImportItem{Quantity: 1, Unit: "件"}
	if match := aiTradeSKURegexp.FindString(rawText); match != "" {
		item.SKU = strings.ToUpper(match)
	}
	if match := aiTradeSalesRegexp.FindStringSubmatch(rawText); len(match) > 1 {
		item.SalesUnitPrice = parseAITradeFloat(match[1])
		draft.Currency = "USD"
	}
	if match := aiTradeQuantityRegexp.FindStringSubmatch(rawText); len(match) > 1 {
		item.Quantity = parseAITradeFloat(match[1])
	}
	if match := aiTradeMultiplyRegexp.FindStringSubmatch(rawText); len(match) > 3 {
		if item.SalesUnitPrice <= 0 {
			item.SalesUnitPrice = parseAITradeFloat(match[1])
		}
		if item.Quantity <= 1 {
			item.Quantity = parseAITradeFloat(match[2])
		}
		draft.GoodsAmount = parseAITradeFloat(match[3])
	}
	if match := aiTradeShippingRegexp.FindStringSubmatch(rawText); len(match) > 1 {
		draft.ShippingCost = parseAITradeFloat(match[1])
	}
	if match := aiTradeTotalRegexp.FindStringSubmatch(rawText); len(match) > 1 {
		draft.TotalAmount = parseAITradeFloat(match[1])
	}
	if match := aiTradeSettlementRegex.FindStringSubmatch(rawText); len(match) > 2 {
		draft.SettlementCurrency = strings.ToUpper(strings.TrimSpace(match[1]))
		draft.SettlementAmount = parseAITradeFloat(match[2])
	}
	for _, line := range strings.Split(rawText, "\n") {
		trimmed := strings.TrimSpace(line)
		lower := strings.ToLower(trimmed)
		if strings.Contains(lower, "供应商") {
			value := strings.TrimSpace(strings.TrimPrefix(trimmed, "供应商"))
			value = strings.TrimSpace(strings.ReplaceAll(value, item.SKU, ""))
			parts := strings.Fields(value)
			if len(parts) > 0 {
				item.SupplierName = parts[0]
			}
			for _, part := range parts[1:] {
				if number := aiTradeNumberRegexp.FindString(part); number != "" {
					item.PurchaseUnitPrice = parseAITradeFloat(number)
					textPart := strings.TrimSpace(strings.Replace(part, number, "", 1))
					textPart = strings.TrimSpace(strings.TrimSuffix(textPart, "单价"))
					if textPart != "" {
						item.Specification = strings.TrimSpace(item.Specification + " " + textPart)
					}
				} else if !strings.Contains(part, "单价") {
					item.Specification = strings.TrimSpace(item.Specification + " " + part)
				}
			}
		}
		if strings.Contains(trimmed, "墨西哥") && !strings.ContainsAny(trimmed, "$=:：") {
			draft.Country = "墨西哥"
			draft.DestinationCountry = "墨西哥"
			name := strings.TrimSpace(strings.ReplaceAll(trimmed, "墨西哥", ""))
			if name != "" {
				draft.CustomerName = name
				draft.CustomerQuery = name
			}
		}
		if match := aiTradeCustomerLine.FindStringSubmatch(trimmed); len(match) > 1 {
			name := strings.TrimSpace(match[1])
			if name != "" {
				draft.CustomerName = name
				draft.CustomerQuery = name
			}
		}
	}
	item.ProductName = item.SKU
	draft.Items = []AITradeOrderImportItem{item}
	return draft
}

func uniqueAITradeCustomerMatch(customers []model.TradeCustomer, query string) int64 {
	if len(customers) == 1 {
		return customers[0].ID
	}
	normalized := strings.ToLower(strings.TrimSpace(query))
	var matched int64
	for _, customer := range customers {
		for _, candidate := range []string{customer.Name, customer.CompanyName, customer.CustomerCode} {
			if strings.ToLower(strings.TrimSpace(candidate)) != normalized {
				continue
			}
			if matched != 0 && matched != customer.ID {
				return 0
			}
			matched = customer.ID
		}
	}
	return matched
}

func aiTradeImportNotes(draft *AITradeOrderImportDraft) string {
	if draft == nil {
		return "AI 导入订单"
	}
	parts := []string{"AI 从非结构化资料导入；当前阶段为仓库到货，未登记实到数量。"}
	if draft.SettlementCurrency != "" && draft.SettlementAmount > 0 {
		parts = append(parts, fmt.Sprintf("付款指令：%s %.2f（仅记录指令，未标记为已付款）。", draft.SettlementCurrency, draft.SettlementAmount))
	}
	if len(draft.Warnings) > 0 {
		parts = append(parts, "识别提示："+strings.Join(draft.Warnings, "；"))
	}
	if len(draft.MissingFields) > 0 {
		parts = append(parts, "待补字段："+strings.Join(draft.MissingFields, "、"))
	}
	return strings.Join(parts, "\n")
}

func newAITradeImportID() string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err == nil {
		return "ai-" + hex.EncodeToString(buffer)
	}
	return fmt.Sprintf("ai-%d", time.Now().UnixNano())
}

func parseAITradeFloat(value string) float64 {
	value = strings.ReplaceAll(strings.TrimSpace(value), ",", "")
	parsed, _ := strconv.ParseFloat(value, 64)
	return parsed
}

func uniqueTradeImportStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}
