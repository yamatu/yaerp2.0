package handler

import (
	"encoding/json"
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

	result, err := h.aiService.Chat(userID, req.Messages)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	if h.hub != nil {
		for _, sheetID := range result.TouchedSheetIDs {
			payload, _ := json.Marshal(ws.Message{
				Type:    "sheet_reload",
				SheetID: sheetID,
				UserID:  userID,
			})
			h.hub.BroadcastToSheet(sheetID, payload, nil)
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

	result, err := h.aiService.PreviewSpreadsheetPlan(&req)
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
				Type:    "sheet_reload",
				SheetID: sheetID,
				UserID:  userID,
			})
			h.hub.BroadcastToSheet(sheetID, payload, nil)
		}
	}

	response.OKMsg(c, "AI plan applied")
}
