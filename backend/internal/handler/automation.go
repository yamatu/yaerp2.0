package handler

import (
	"database/sql"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type AutomationHandler struct {
	service *service.AutomationService
}

func NewAutomationHandler(automationService *service.AutomationService) *AutomationHandler {
	return &AutomationHandler{service: automationService}
}

func (h *AutomationHandler) ListRules(c *gin.Context) {
	page, size := automationPagination(c, 20)
	items, total, err := h.service.ListRules(c.GetInt64("user_id"), page, size)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKPage(c, items, total, page, size)
}

func (h *AutomationHandler) GetRule(c *gin.Context) {
	ruleID, ok := automationPathID(c, "id", "rule")
	if !ok {
		return
	}
	item, err := h.service.GetRule(c.GetInt64("user_id"), ruleID)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AutomationHandler) CreateRule(c *gin.Context) {
	var input model.AutomationRuleInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid automation rule: "+err.Error())
		return
	}
	item, err := h.service.CreateRule(c.GetInt64("user_id"), &input)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AutomationHandler) UpdateRule(c *gin.Context) {
	ruleID, ok := automationPathID(c, "id", "rule")
	if !ok {
		return
	}
	var input model.AutomationRuleInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid automation rule: "+err.Error())
		return
	}
	item, err := h.service.UpdateRule(c.GetInt64("user_id"), ruleID, &input)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AutomationHandler) DeleteRule(c *gin.Context) {
	ruleID, ok := automationPathID(c, "id", "rule")
	if !ok {
		return
	}
	if err := h.service.DeleteRule(c.GetInt64("user_id"), ruleID); err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKMsg(c, "automation rule deleted")
}

func (h *AutomationHandler) TriggerRule(c *gin.Context) {
	ruleID, ok := automationPathID(c, "id", "rule")
	if !ok {
		return
	}
	var input model.ManualAutomationTriggerInput
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		response.BadRequest(c, "invalid trigger context")
		return
	}
	run, err := h.service.TriggerManual(c.GetInt64("user_id"), ruleID, &input)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, run)
}

func (h *AutomationHandler) ListRuns(c *gin.Context) {
	page, size := automationPagination(c, 20)
	status := strings.TrimSpace(c.Query("status"))
	if status != "" && !automationRunStatusValid(status) {
		response.BadRequest(c, "invalid automation run status")
		return
	}
	items, total, err := h.service.ListRuns(c.GetInt64("user_id"), status, page, size)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKPage(c, items, total, page, size)
}

func (h *AutomationHandler) GetRun(c *gin.Context) {
	runID, ok := automationPathID(c, "id", "run")
	if !ok {
		return
	}
	item, err := h.service.GetRunDetail(c.GetInt64("user_id"), runID)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AutomationHandler) ListCellApprovalStates(c *gin.Context) {
	sheetID, ok := automationPathID(c, "id", "sheet")
	if !ok {
		return
	}
	items, err := h.service.ListCellApprovalStates(c.GetInt64("user_id"), sheetID)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, items)
}

func (h *AutomationHandler) ListPendingApprovals(c *gin.Context) {
	page, size := automationPagination(c, 20)
	items, total, err := h.service.ListPendingApprovals(c.GetInt64("user_id"), page, size)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKPage(c, items, total, page, size)
}

func (h *AutomationHandler) DecideApproval(c *gin.Context) {
	requestID, ok := automationPathID(c, "id", "approval request")
	if !ok {
		return
	}
	var input model.ApprovalDecisionInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid approval decision: "+err.Error())
		return
	}
	if err := h.service.DecideApproval(c.GetInt64("user_id"), requestID, &input); err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKMsg(c, "approval decision submitted")
}

func (h *AutomationHandler) ListNotifications(c *gin.Context) {
	page, size := automationPagination(c, 30)
	unreadOnly := c.Query("unread_only") == "true" || c.Query("unread_only") == "1"
	items, total, err := h.service.ListNotifications(c.GetInt64("user_id"), unreadOnly, c.Query("category"), page, size)
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKPage(c, items, total, page, size)
}

func (h *AutomationHandler) MarkNotificationRead(c *gin.Context) {
	notificationID, ok := automationPathID(c, "id", "notification")
	if !ok {
		return
	}
	if err := h.service.MarkNotificationRead(c.GetInt64("user_id"), notificationID); err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKMsg(c, "notification marked as read")
}

func (h *AutomationHandler) MarkAllNotificationsRead(c *gin.Context) {
	if err := h.service.MarkAllNotificationsRead(c.GetInt64("user_id"), c.Query("category")); err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OKMsg(c, "notifications marked as read")
}

func (h *AutomationHandler) TaskCenterSummary(c *gin.Context) {
	summary, err := h.service.TaskCenterSummary(c.GetInt64("user_id"))
	if err != nil {
		respondAutomationError(c, err)
		return
	}
	response.OK(c, summary)
}

func automationPathID(c *gin.Context, parameter, label string) (int64, bool) {
	value, err := strconv.ParseInt(c.Param(parameter), 10, 64)
	if err != nil || value <= 0 {
		response.BadRequest(c, "invalid "+label+" id")
		return 0, false
	}
	return value, true
}

func automationPagination(c *gin.Context, defaultSize int) (int, int) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", strconv.Itoa(defaultSize)))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = defaultSize
	}
	if size > 100 {
		size = 100
	}
	return page, size
}

func automationRunStatusValid(status string) bool {
	switch status {
	case "running", "waiting_approval", "completed", "rejected", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func respondAutomationError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrAutomationAccessDenied),
		errors.Is(err, service.ErrSheetPermissionDenied),
		errors.Is(err, service.ErrProtectionDenied),
		errors.Is(err, service.ErrSheetLocked),
		errors.Is(err, service.ErrSheetArchived):
		response.Forbidden(c, err.Error())
	case errors.Is(err, service.ErrAutomationInvalid),
		strings.Contains(strings.ToLower(err.Error()), "approval is not assigned"),
		strings.Contains(strings.ToLower(err.Error()), "already been submitted"),
		strings.Contains(strings.ToLower(err.Error()), "no longer pending"):
		response.BadRequest(c, err.Error())
	case errors.Is(err, sql.ErrNoRows), strings.Contains(strings.ToLower(err.Error()), "not found"):
		response.NotFound(c, err.Error())
	default:
		response.Error(c, http.StatusInternalServerError, err.Error())
	}
}
