package handler

import (
	"encoding/json"
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/internal/ws"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type AIHandler struct {
	aiService *service.AIService
	hub       *ws.Hub
}

func NewAIHandler(aiService *service.AIService, hub *ws.Hub) *AIHandler {
	return &AIHandler{aiService: aiService, hub: hub}
}

func (h *AIHandler) Chat(c *gin.Context) {
	userID := c.GetInt64("user_id")

	var req service.ChatRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if len(req.Messages) == 0 {
		response.BadRequest(c, "messages cannot be empty")
		return
	}

	assistantID := int64(0)
	if req.AssistantID != nil {
		assistantID = *req.AssistantID
	}
	result, err := h.aiService.ChatWithContext(userID, assistantID, req.Messages, req.Context)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	if h.hub != nil {
		for _, sheetID := range result.ChangedSheetIDs {
			payload, _ := json.Marshal(ws.Message{
				Type:    "sheet_sync",
				SheetID: sheetID,
				UserID:  userID,
			})
			h.hub.BroadcastToSheetExceptClientID(sheetID, payload, c.GetHeader("X-Client-Id"))
		}
	}

	response.OK(c, result)
}

func (h *AIHandler) GetConfig(c *gin.Context) {
	status := h.aiService.GetConfig()
	response.OK(c, status)
}

type UpdateAIConfigRequest struct {
	Endpoint string `json:"endpoint"`
	APIKey   string `json:"api_key"`
	Model    string `json:"model"`
}

func (h *AIHandler) UpdateConfig(c *gin.Context) {
	var req UpdateAIConfigRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.aiService.UpdateConfig(req.Endpoint, req.APIKey, req.Model); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "AI config updated")
}

func (h *AIHandler) PreviewSpreadsheetPlan(c *gin.Context) {
	var req service.SpreadsheetPlanRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	result, err := h.aiService.PreviewSpreadsheetPlan(c.GetInt64("user_id"), 0, &req)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, result)
}

func (h *AIHandler) ApplySpreadsheetPlan(c *gin.Context) {
	userID := c.GetInt64("user_id")

	var req service.SpreadsheetApplyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.aiService.ApplySpreadsheetPlan(userID, req.Operations); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	if h.hub != nil {
		touchedSheets := make(map[int64]struct{})
		for _, operation := range req.Operations {
			touchedSheets[operation.SheetID] = struct{}{}
		}
		for sheetID := range touchedSheets {
			payload, _ := json.Marshal(ws.Message{
				Type:    "sheet_sync",
				SheetID: sheetID,
				UserID:  userID,
			})
			h.hub.BroadcastToSheetExceptClientID(sheetID, payload, c.GetHeader("X-Client-Id"))
		}
	}

	response.OKMsg(c, "AI plan applied")
}

func (h *AIHandler) ListAvailableAssistants(c *gin.Context) {
	items, err := h.aiService.ListAIAssistants(false)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, items)
}

func (h *AIHandler) ListAssistants(c *gin.Context) {
	items, err := h.aiService.ListAIAssistants(true)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, items)
}

func (h *AIHandler) CreateAssistant(c *gin.Context) {
	var req model.AIAssistantInput
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	item, err := h.aiService.CreateAIAssistant(c.GetInt64("user_id"), &req)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) UpdateAssistant(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid assistant id")
		return
	}
	var req model.AIAssistantInput
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	item, err := h.aiService.UpdateAIAssistant(id, &req)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) DeleteAssistant(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid assistant id")
		return
	}
	if err := h.aiService.DeleteAIAssistant(id); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "AI assistant deleted")
}

func (h *AIHandler) SetDefaultAssistant(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid assistant id")
		return
	}
	item, err := h.aiService.SetDefaultAIAssistant(id)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) ListSummaryPages(c *gin.Context) {
	items, err := h.aiService.ListAISummaryPages(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, items)
}

func (h *AIHandler) GenerateSummaryPage(c *gin.Context) {
	var req model.AISummaryGenerateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	item, err := h.aiService.GenerateAISummaryPage(c.GetInt64("user_id"), &req)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) GetSummaryPage(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid summary id")
		return
	}
	item, err := h.aiService.GetAISummaryPage(c.GetInt64("user_id"), id)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) UpdateSummaryPage(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid summary id")
		return
	}
	var req model.AISummaryUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	item, err := h.aiService.UpdateAISummaryPage(c.GetInt64("user_id"), id, &req)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) DeleteSummaryPage(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "invalid summary id")
		return
	}
	if err := h.aiService.DeleteAISummaryPage(c.GetInt64("user_id"), id); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "AI summary page deleted")
}
