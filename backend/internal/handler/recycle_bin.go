package handler

import (
	"errors"
	"strconv"

	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type RecycleBinHandler struct {
	service *service.RecycleBinService
}

func NewRecycleBinHandler(recycleService *service.RecycleBinService) *RecycleBinHandler {
	return &RecycleBinHandler{service: recycleService}
}

func (h *RecycleBinHandler) List(c *gin.Context) {
	contents, err := h.service.List(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, contents)
}

func (h *RecycleBinHandler) RestoreWorkbook(c *gin.Context) {
	h.handleResourceAction(c, h.service.RestoreWorkbook, "workbook restored")
}

func (h *RecycleBinHandler) DeleteWorkbook(c *gin.Context) {
	h.handleResourceAction(c, h.service.DeleteWorkbookPermanently, "workbook permanently deleted")
}

func (h *RecycleBinHandler) RestoreFolder(c *gin.Context) {
	h.handleResourceAction(c, h.service.RestoreFolder, "folder restored")
}

func (h *RecycleBinHandler) DeleteFolder(c *gin.Context) {
	h.handleResourceAction(c, h.service.DeleteFolderPermanently, "folder permanently deleted")
}

func (h *RecycleBinHandler) RestoreTradeOrder(c *gin.Context) {
	h.handleResourceAction(c, h.service.RestoreTradeOrder, "trade order restored")
}

func (h *RecycleBinHandler) DeleteTradeOrder(c *gin.Context) {
	h.handleResourceAction(c, h.service.DeleteTradeOrderPermanently, "trade order permanently deleted")
}

func (h *RecycleBinHandler) RestoreTradePaymentProof(c *gin.Context) {
	h.handleResourceAction(c, h.service.RestoreTradePaymentProof, "trade payment proof restored")
}

func (h *RecycleBinHandler) DeleteTradePaymentProof(c *gin.Context) {
	h.handleResourceAction(c, h.service.DeleteTradePaymentProofPermanently, "trade payment proof permanently deleted")
}

func (h *RecycleBinHandler) handleResourceAction(
	c *gin.Context,
	action func(userID, resourceID int64) error,
	successMessage string,
) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid resource id")
		return
	}
	if err := action(c.GetInt64("user_id"), id); err != nil {
		if errors.Is(err, service.ErrRecycleBinAccessDenied) {
			response.Forbidden(c, "you do not have permission to manage this deleted resource")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, successMessage)
}
