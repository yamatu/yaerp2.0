package handler

import (
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type TradeHandler struct {
	service *service.TradeService
}

func NewTradeHandler(tradeService *service.TradeService) *TradeHandler {
	return &TradeHandler{service: tradeService}
}

func (h *TradeHandler) AccessProfile(c *gin.Context) {
	profile, err := h.service.AccessProfile(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, profile)
}

func (h *TradeHandler) Dashboard(c *gin.Context) {
	dashboard, err := h.service.Dashboard(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, dashboard)
}

func (h *TradeHandler) BossDashboard(c *gin.Context) {
	dashboard, err := h.service.BossDashboard(c.GetInt64("user_id"))
	if err != nil {
		response.Forbidden(c, err.Error())
		return
	}
	response.OK(c, dashboard)
}

func (h *TradeHandler) GeneratePI(c *gin.Context) {
	orderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || orderID <= 0 {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.TradePIRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	file, err := h.service.BuildTradePIFile(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	setExportDownloadHeaders(c, file.Filename, "application/pdf", len(file.Data))
	if strings.TrimSpace(c.Query("download")) != "1" {
		disposition := c.Writer.Header().Get("Content-Disposition")
		c.Header("Content-Disposition", strings.Replace(disposition, "attachment;", "inline;", 1))
	}
	c.Data(http.StatusOK, "application/pdf", file.Data)
}

func (h *TradeHandler) SendPI(c *gin.Context) {
	orderID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || orderID <= 0 {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.TradePIRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	message, err := h.service.SendTradePIToCustomer(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, message)
}

func (h *TradeHandler) ListCustomers(c *gin.Context) {
	customers, err := h.service.ListCustomers(c.GetInt64("user_id"), c.Query("search"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, customers)
}

func (h *TradeHandler) CreateCustomer(c *gin.Context) {
	var request model.CreateTradeCustomerRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	customer, err := h.service.CreateCustomer(c.GetInt64("user_id"), &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, customer)
}

func (h *TradeHandler) UpdateCustomer(c *gin.Context) {
	customerID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的客户编号")
		return
	}
	var request model.UpdateTradeCustomerRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	customer, err := h.service.UpdateCustomer(c.GetInt64("user_id"), customerID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "客户不存在或无权编辑")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, customer)
}

func (h *TradeHandler) ListCustomerDeleteRequests(c *gin.Context) {
	requests, err := h.service.ListCustomerDeleteRequests(c.GetInt64("user_id"), c.Query("status"))
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, requests)
}

func (h *TradeHandler) RequestCustomerDelete(c *gin.Context) {
	customerID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的客户编号")
		return
	}
	var request model.TradeCustomerDeleteRequestInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	deleteRequest, err := h.service.RequestCustomerDelete(c.GetInt64("user_id"), customerID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "客户不存在或无权访问")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, deleteRequest)
}

func (h *TradeHandler) DecideCustomerDeleteRequest(c *gin.Context) {
	requestID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的删除申请编号")
		return
	}
	var request model.TradeCustomerDeleteDecisionInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	result, err := h.service.DecideCustomerDeleteRequest(c.GetInt64("user_id"), requestID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "客户或删除申请不存在")
		return
	}
	if err != nil {
		response.Forbidden(c, err.Error())
		return
	}
	response.OK(c, result)
}

func (h *TradeHandler) DeleteCustomer(c *gin.Context) {
	customerID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的客户编号")
		return
	}
	result, err := h.service.DeleteCustomer(c.GetInt64("user_id"), customerID)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "客户不存在")
		return
	}
	if err != nil {
		response.Forbidden(c, err.Error())
		return
	}
	response.OK(c, result)
}

func (h *TradeHandler) ListOrders(c *gin.Context) {
	filter := model.TradeOrderFilter{Search: c.Query("search"), Stage: strings.TrimSpace(c.Query("stage"))}
	if value := strings.TrimSpace(c.Query("customer_id")); value != "" {
		customerID, err := strconv.ParseInt(value, 10, 64)
		if err != nil || customerID <= 0 {
			response.BadRequest(c, "无效的客户编号")
			return
		}
		filter.CustomerID = customerID
	}
	orders, err := h.service.ListOrders(c.GetInt64("user_id"), filter)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, orders)
}

func (h *TradeHandler) CreateOrder(c *gin.Context) {
	var request model.CreateTradeOrderRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.CreateOrder(c.GetInt64("user_id"), &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) GetOrder(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	order, err := h.service.GetOrder(c.GetInt64("user_id"), orderID)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在或无权访问")
		return
	}
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateProfitSettings(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.UpdateTradeProfitSettingsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateProfitSettings(c.GetInt64("user_id"), orderID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) DeleteOrder(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	if err := h.service.DeleteOrder(c.GetInt64("user_id"), orderID); errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在")
		return
	} else if err != nil {
		response.Forbidden(c, err.Error())
		return
	}
	response.OKMsg(c, "业务订单已移入回收站，30天内可完整还原")
}

func (h *TradeHandler) AddOrderItems(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.AddTradeOrderItemsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.AddOrderItems(c.GetInt64("user_id"), orderID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在或无权访问")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) DeleteOrderItem(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	itemID, err := parseIDParam(c, "itemId")
	if err != nil {
		response.BadRequest(c, "无效的产品编号")
		return
	}
	order, err := h.service.DeleteOrderItem(c.GetInt64("user_id"), orderID, itemID)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "产品不存在、业务单不存在或无权操作")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateStageData(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.UpdateTradeStageDataRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateStageData(c.GetInt64("user_id"), orderID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在或无权访问")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) AdvanceOrder(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.AdvanceTradeOrderRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.AdvanceOrder(c.GetInt64("user_id"), orderID, &request)
	if errors.Is(err, sql.ErrNoRows) {
		response.NotFound(c, "业务单不存在或无权访问")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) ListSuppliers(c *gin.Context) {
	suppliers, err := h.service.ListSuppliers(c.GetInt64("user_id"), c.Query("search"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, suppliers)
}

func (h *TradeHandler) CreateSupplier(c *gin.Context) {
	var request model.CreateTradeSupplierRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	supplier, err := h.service.CreateSupplier(c.GetInt64("user_id"), &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, supplier)
}

func (h *TradeHandler) CreateSupplierQuote(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.UpsertTradeSupplierQuoteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.CreateSupplierQuote(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) BatchCreateSupplierQuotes(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.BatchTradeSupplierQuoteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.BatchCreateSupplierQuotes(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateSupplierQuote(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的供应商报价编号")
		return
	}
	var request model.UpsertTradeSupplierQuoteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateSupplierQuote(c.GetInt64("user_id"), orderID, quoteID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) DeleteSupplierQuote(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的供应商报价编号")
		return
	}
	order, err := h.service.DeleteSupplierQuote(c.GetInt64("user_id"), orderID, quoteID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) SelectSupplierQuote(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的供应商报价编号")
		return
	}
	order, err := h.service.SelectSupplierQuote(c.GetInt64("user_id"), orderID, quoteID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) CreateCustomerQuoteRound(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.CreateTradeCustomerQuoteRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.CreateCustomerQuoteRound(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateCustomerQuoteRoundStatus(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的对客报价编号")
		return
	}
	var request model.UpdateTradeCustomerQuoteStatusRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateCustomerQuoteRoundStatus(c.GetInt64("user_id"), orderID, quoteID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateCustomerQuotePayment(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的对客报价编号")
		return
	}
	var request model.UpdateTradeCustomerPaymentRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateCustomerQuotePayment(c.GetInt64("user_id"), orderID, quoteID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UploadCustomerPaymentProof(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	quoteID, err := strconv.ParseInt(c.Param("quoteId"), 10, 64)
	if err != nil || quoteID <= 0 {
		response.BadRequest(c, "无效的对客报价编号")
		return
	}
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "请选择付款凭证图片")
		return
	}
	defer file.Close()
	proof, err := h.service.UploadCustomerPaymentProof(
		c.GetInt64("user_id"), orderID, quoteID, c.PostForm("note"), file, header,
	)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, proof)
}

func (h *TradeHandler) ListPositions(c *gin.Context) {
	positions, err := h.service.ListPositions(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, positions)
}

func (h *TradeHandler) UpdatePositionAssignments(c *gin.Context) {
	var request model.TradePositionAssignmentsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	positions, err := h.service.UpdatePositionAssignments(c.GetInt64("user_id"), &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, positions)
}

func (h *TradeHandler) GetSettings(c *gin.Context) {
	settings, err := h.service.GetSettings(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, settings)
}

func (h *TradeHandler) UpdateSettings(c *gin.Context) {
	var request model.UpdateTradeSettingsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	settings, err := h.service.UpdateSettings(c.GetInt64("user_id"), &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, settings)
}

func (h *TradeHandler) SyncOrderWorkspace(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	if err := h.service.SyncOrderWorkspace(c.GetInt64("user_id"), orderID); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.GetOrder(c.GetInt64("user_id"), orderID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UploadInspectionPhoto(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "请选择质检图片")
		return
	}
	defer file.Close()
	var itemID *int64
	if value := strings.TrimSpace(c.PostForm("order_item_id")); value != "" {
		parsed, parseErr := strconv.ParseInt(value, 10, 64)
		if parseErr != nil || parsed <= 0 {
			response.BadRequest(c, "无效的产品编号")
			return
		}
		itemID = &parsed
	}
	photo, err := h.service.UploadInspectionPhoto(c.GetInt64("user_id"), orderID, itemID, c.PostForm("note"), file, header)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, photo)
}

func (h *TradeHandler) LinkInspectionPhotos(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.LinkTradeInspectionPhotosRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.LinkInspectionPhotos(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdatePackingGroups(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.UpdateTradePackingGroupsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdatePackingGroups(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) ReturnOrderToPurchase(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.ReturnTradeOrderToPurchaseRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.ReturnOrderToPurchase(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) UpdateLabelSettings(c *gin.Context) {
	orderID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "无效的业务单编号")
		return
	}
	var request model.UpdateTradeLabelSettingsRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	order, err := h.service.UpdateLabelSettings(c.GetInt64("user_id"), orderID, &request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}
