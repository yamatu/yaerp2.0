package handler

import (
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/pkg/response"
)

func (h *TradeHandler) QuoteHistory(c *gin.Context) {
	filter := model.TradeQuoteHistoryFilter{Search: c.Query("search")}
	if value := strings.TrimSpace(c.Query("customer_id")); value != "" {
		customerID, err := strconv.ParseInt(value, 10, 64)
		if err != nil || customerID < 0 {
			response.BadRequest(c, "无效的客户编号")
			return
		}
		filter.CustomerID = customerID
	}
	history, err := h.service.QuoteHistory(c.GetInt64("user_id"), filter)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, history)
}

func (h *TradeHandler) UploadItemImage(c *gin.Context) {
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
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "请选择产品图片")
		return
	}
	defer file.Close()
	order, err := h.service.UploadItemImage(c.GetInt64("user_id"), orderID, itemID, file, header)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}

func (h *TradeHandler) DeleteItemImage(c *gin.Context) {
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
	imageID, err := parseIDParam(c, "imageId")
	if err != nil {
		response.BadRequest(c, "无效的图片编号")
		return
	}
	order, err := h.service.DeleteItemImage(c.GetInt64("user_id"), orderID, itemID, imageID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, order)
}
