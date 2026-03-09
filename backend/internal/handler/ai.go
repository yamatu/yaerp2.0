package handler

import (
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type AIHandler struct {
	aiService *service.AIService
}

func NewAIHandler(aiService *service.AIService) *AIHandler {
	return &AIHandler{aiService: aiService}
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
