package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type SheetHistoryHandler struct {
	service     *service.SheetHistoryService
	broadcaster sheetBroadcaster
}

func NewSheetHistoryHandler(historyService *service.SheetHistoryService, broadcaster sheetBroadcaster) *SheetHistoryHandler {
	return &SheetHistoryHandler{service: historyService, broadcaster: broadcaster}
}

func (h *SheetHistoryHandler) ListVersions(c *gin.Context) {
	sheetID, ok := historyPathID(c, "id", "sheet")
	if !ok {
		return
	}
	page, size := historyPagination(c, 20)
	versions, total, err := h.service.ListVersions(c.GetInt64("user_id"), sheetID, page, size)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	response.OKPage(c, versions, total, page, size)
}

func (h *SheetHistoryHandler) CreateCheckpoint(c *gin.Context) {
	sheetID, ok := historyPathID(c, "id", "sheet")
	if !ok {
		return
	}
	var request model.CreateSheetCheckpointRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	version, err := h.service.CreateCheckpoint(c.GetInt64("user_id"), sheetID, request.Summary)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	response.OK(c, version)
}

func (h *SheetHistoryHandler) VersionDiff(c *gin.Context) {
	sheetID, ok := historyPathID(c, "id", "sheet")
	if !ok {
		return
	}
	versionID, ok := historyPathID(c, "versionId", "version")
	if !ok {
		return
	}
	diff, err := h.service.VersionDiff(c.GetInt64("user_id"), sheetID, versionID)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	response.OK(c, diff)
}

func (h *SheetHistoryHandler) RestoreVersion(c *gin.Context) {
	sheetID, ok := historyPathID(c, "id", "sheet")
	if !ok {
		return
	}
	versionID, ok := historyPathID(c, "versionId", "version")
	if !ok {
		return
	}
	var request model.RestoreSheetVersionRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	version, err := h.service.RestoreVersion(c.GetInt64("user_id"), sheetID, versionID, request.Reason)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	h.broadcastReload(c, sheetID)
	response.OK(c, version)
}

func (h *SheetHistoryHandler) ListSheetAuditLogs(c *gin.Context) {
	sheetID, ok := historyPathID(c, "id", "sheet")
	if !ok {
		return
	}
	filter, ok := parseOperationLogFilter(c, 50)
	if !ok {
		return
	}
	logs, total, err := h.service.ListSheetAuditLogs(c.GetInt64("user_id"), sheetID, filter)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	response.OKPage(c, logs, total, filter.Page, filter.PageSize)
}

func (h *SheetHistoryHandler) ListAllAuditLogs(c *gin.Context) {
	filter, ok := parseOperationLogFilter(c, 100)
	if !ok {
		return
	}
	if value := strings.TrimSpace(c.Query("sheet_id")); value != "" {
		sheetID, err := strconv.ParseInt(value, 10, 64)
		if err != nil || sheetID <= 0 {
			response.BadRequest(c, "invalid sheet id")
			return
		}
		filter.SheetID = &sheetID
	}
	logs, total, err := h.service.ListAllAuditLogs(c.GetInt64("user_id"), filter)
	if err != nil {
		handleSheetHistoryError(c, err)
		return
	}
	response.OKPage(c, logs, total, filter.Page, filter.PageSize)
}

func (h *SheetHistoryHandler) broadcastReload(c *gin.Context, sheetID int64) {
	if h.broadcaster == nil {
		return
	}
	payload, err := json.Marshal(gin.H{
		"type": "sheet_reload", "sheetId": sheetID,
		"userId": c.GetInt64("user_id"), "reason": "version_restore",
	})
	if err != nil {
		return
	}
	h.broadcaster.BroadcastToSheetExceptClientID(sheetID, payload, c.GetHeader("X-Client-Id"))
}

func historyPathID(c *gin.Context, parameter, label string) (int64, bool) {
	value, err := strconv.ParseInt(c.Param(parameter), 10, 64)
	if err != nil || value <= 0 {
		response.BadRequest(c, "invalid "+label+" id")
		return 0, false
	}
	return value, true
}

func historyPagination(c *gin.Context, defaultSize int) (int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", strconv.Itoa(defaultSize)))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = defaultSize
	}
	return page, size
}

func parseOperationLogFilter(c *gin.Context, defaultSize int) (model.OperationLogFilter, bool) {
	page, size := historyPagination(c, defaultSize)
	filter := model.OperationLogFilter{
		Action: strings.TrimSpace(c.Query("action")), Source: strings.TrimSpace(c.Query("source")),
		Keyword: strings.TrimSpace(c.Query("keyword")), Page: page, PageSize: size,
	}
	if len(filter.Keyword) > 200 || len(filter.Action) > 64 || len(filter.Source) > 32 {
		response.BadRequest(c, "audit filter is too long")
		return filter, false
	}
	if value := strings.TrimSpace(c.Query("user_id")); value != "" {
		userID, err := strconv.ParseInt(value, 10, 64)
		if err != nil || userID <= 0 {
			response.BadRequest(c, "invalid user id")
			return filter, false
		}
		filter.UserID = &userID
	}
	if value := strings.TrimSpace(c.Query("from")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			response.BadRequest(c, "invalid from time")
			return filter, false
		}
		filter.From = &parsed
	}
	if value := strings.TrimSpace(c.Query("to")); value != "" {
		parsed, err := time.Parse(time.RFC3339, value)
		if err != nil {
			response.BadRequest(c, "invalid to time")
			return filter, false
		}
		filter.To = &parsed
	}
	return filter, true
}

func handleSheetHistoryError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrSheetPermissionDenied),
		errors.Is(err, service.ErrSheetHistoryDetailsDenied),
		errors.Is(err, service.ErrSheetVersionRestoreDenied),
		errors.Is(err, service.ErrSheetLocked),
		errors.Is(err, service.ErrSheetArchived):
		response.Forbidden(c, err.Error())
	case strings.Contains(strings.ToLower(err.Error()), "not found"):
		response.NotFound(c, err.Error())
	default:
		response.Error(c, http.StatusInternalServerError, err.Error())
	}
}
