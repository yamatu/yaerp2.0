package handler

import (
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type PermissionHandler struct {
	permService *service.PermissionService
}

func NewPermissionHandler(permService *service.PermissionService) *PermissionHandler {
	return &PermissionHandler{permService: permService}
}

func (h *PermissionHandler) SetSheetPermission(c *gin.Context) {
	var req model.SetSheetPermissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.permService.SetSheetPermission(&req); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "sheet permission set")
}

func (h *PermissionHandler) SetUserSheetPermission(c *gin.Context) {
	var req model.SetUserSheetPermissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.permService.SetUserSheetPermission(&req); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "user sheet permission set")
}

func (h *PermissionHandler) SetCellPermission(c *gin.Context) {
	var req model.SetCellPermissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.permService.SetCellPermission(&req); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "cell permission set")
}

func (h *PermissionHandler) GetPermissionMatrix(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	userID := c.GetInt64("user_id")
	matrix, err := h.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, matrix)
}

func (h *PermissionHandler) GetPermissionMatrixForRole(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	roleID, err := strconv.ParseInt(c.Param("roleId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid role id")
		return
	}

	matrix, err := h.permService.GetPermissionMatrixForRole(sheetID, roleID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, matrix)
}

func (h *PermissionHandler) GetPermissionMatrixForUser(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}

	perm, err := h.permService.GetUserSheetPermission(sheetID, userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	if perm == nil {
		response.OK(c, model.UserSheetPermission{SheetID: sheetID, UserID: userID})
		return
	}

	response.OK(c, perm)
}

func (h *PermissionHandler) ListUserSheetPermissions(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	perms, err := h.permService.ListUserSheetPermissions(sheetID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, perms)
}
