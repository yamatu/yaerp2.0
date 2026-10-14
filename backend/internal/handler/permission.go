package handler

import (
	"encoding/json"
	"strconv"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type PermissionHandler struct {
	permService *service.PermissionService
	broadcaster sheetBroadcaster
}

func NewPermissionHandler(permService *service.PermissionService, broadcaster ...sheetBroadcaster) *PermissionHandler {
	h := &PermissionHandler{permService: permService}
	if len(broadcaster) > 0 {
		h.broadcaster = broadcaster[0]
	}
	return h
}

// notifySheetReload makes open editors of the sheet reload, so a narrowed
// permission takes effect without waiting for the employee to refresh.
func (h *PermissionHandler) notifySheetReload(c *gin.Context, sheetID int64) {
	if h.broadcaster == nil || sheetID <= 0 {
		return
	}
	payload, err := json.Marshal(gin.H{"type": "sheet_reload", "sheetId": sheetID, "userId": c.GetInt64("user_id")})
	if err != nil {
		return
	}
	h.broadcaster.BroadcastToSheetExceptClientID(sheetID, payload, "")
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

	h.notifySheetReload(c, req.SheetID)
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

	h.notifySheetReload(c, req.SheetID)
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

	h.notifySheetReload(c, req.SheetID)
	response.OKMsg(c, "cell permission set")
}

func (h *PermissionHandler) SetPrincipalSheetPermission(c *gin.Context) {
	var req model.SetPrincipalSheetPermissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.permService.SetPrincipalSheetPermission(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	h.notifySheetReload(c, req.SheetID)
	response.OKMsg(c, "principal sheet permission set")
}

func (h *PermissionHandler) SetPrincipalCellPermission(c *gin.Context) {
	var req model.SetPrincipalCellPermissionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.permService.SetPrincipalCellPermission(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	h.notifySheetReload(c, req.SheetID)
	response.OKMsg(c, "principal range permission set")
}

func (h *PermissionHandler) DeletePrincipalSheetPermission(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	principalType := strings.TrimSpace(c.Param("principalType"))
	principalID, err := strconv.ParseInt(c.Param("principalId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid principal id")
		return
	}
	if err := h.permService.DeletePrincipalSheetPermission(sheetID, principalType, principalID); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	h.notifySheetReload(c, sheetID)
	response.OKMsg(c, "principal sheet permission reset")
}

func (h *PermissionHandler) GetPrincipalPermissionConfig(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	principalType := strings.TrimSpace(c.Param("principalType"))
	principalID, err := strconv.ParseInt(c.Param("principalId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid principal id")
		return
	}
	config, err := h.permService.GetPrincipalPermissionConfig(sheetID, principalType, principalID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, config)
}

func (h *PermissionHandler) DeletePrincipalCellPermission(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid range permission id")
		return
	}
	sheetID, err := h.permService.DeletePrincipalCellPermission(id)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	h.notifySheetReload(c, sheetID)
	response.OKMsg(c, "range permission deleted")
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

func (h *PermissionHandler) GetEffectivePermissionMatrixForUser(c *gin.Context) {
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

	explanation, err := h.permService.ExplainPermissionMatrix(sheetID, userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, explanation)
}

func (h *PermissionHandler) ListPermissionSheets(c *gin.Context) {
	sheets, err := h.permService.ListPermissionSheets()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, sheets)
}

func (h *PermissionHandler) GetSheetPermissionOverview(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	overview, err := h.permService.GetSheetPermissionOverview(sheetID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, overview)
}

// DeleteLegacySheetPermissions removes legacy rules of a sheet. The optional
// kind (role|user) and principalId narrow it to one role or one employee.
func (h *PermissionHandler) DeleteLegacySheetPermissions(c *gin.Context) {
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	kind := strings.TrimSpace(c.Param("kind"))
	var principalID int64
	if kind != "" {
		if kind != "role" && kind != "user" {
			response.BadRequest(c, "invalid legacy permission kind")
			return
		}
		if principalID, err = strconv.ParseInt(c.Param("principalId"), 10, 64); err != nil {
			response.BadRequest(c, "invalid principal id")
			return
		}
	}
	removed, err := h.permService.DeleteLegacySheetPermissions(sheetID, kind, principalID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	h.notifySheetReload(c, sheetID)
	response.OK(c, gin.H{"removed": removed})
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
