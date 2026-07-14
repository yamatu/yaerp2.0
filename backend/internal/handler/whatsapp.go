package handler

import (
	"errors"
	"io"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type WhatsAppHandler struct {
	service *service.WhatsAppService
}

func NewWhatsAppHandler(whatsAppService *service.WhatsAppService) *WhatsAppHandler {
	return &WhatsAppHandler{service: whatsAppService}
}

func (h *WhatsAppHandler) GetSettings(c *gin.Context) {
	settings, err := h.service.GetSettings()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, settings)
}

func (h *WhatsAppHandler) UpdateSettings(c *gin.Context) {
	var request model.WhatsAppSettings
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	settings, err := h.service.UpdateSettings(&request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, settings)
}

func (h *WhatsAppHandler) GetStatus(c *gin.Context) {
	status, err := h.service.GetStatus()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, status)
}

func (h *WhatsAppHandler) Start(c *gin.Context) {
	if err := h.service.Start(); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "WhatsApp 会话正在启动")
}

func (h *WhatsAppHandler) Restart(c *gin.Context) {
	if err := h.service.Restart(); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "WhatsApp 会话正在重启")
}

func (h *WhatsAppHandler) Logout(c *gin.Context) {
	if err := h.service.Logout(); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "WhatsApp 已退出登录")
}

func (h *WhatsAppHandler) ListChats(c *gin.Context) {
	chats, err := h.service.ListChats()
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, chats)
}

func (h *WhatsAppHandler) GetChannelLink(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	link, err := h.service.GetChannelLink(c.GetInt64("user_id"), channelID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, link)
}

func (h *WhatsAppHandler) UpdateChannelLink(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var request model.WhatsAppChannelLinkRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	link, err := h.service.UpdateChannelLink(c.GetInt64("user_id"), channelID, &request)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, link)
}

func (h *WhatsAppHandler) DeleteChannelLink(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	if err := h.service.DeleteChannelLink(c.GetInt64("user_id"), channelID); err != nil {
		if errors.Is(err, service.ErrChannelAccessDenied) || errors.Is(err, service.ErrChannelManageDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "已取消 WhatsApp 关联")
}

func (h *WhatsAppHandler) SendChannelMessage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := strconv.ParseInt(c.Param("messageId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	sent, err := h.service.SendChannelMessage(c.GetInt64("user_id"), channelID, messageID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, sent)
}

func (h *WhatsAppHandler) SendResource(c *gin.Context) {
	var request model.WhatsAppSendRequest
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	sent, err := h.service.SendResource(c.GetInt64("user_id"), &request)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, sent)
}

func (h *WhatsAppHandler) Webhook(c *gin.Context) {
	if !h.service.ValidateInternalSecret(c.GetHeader("X-WhatsApp-Secret")) {
		c.AbortWithStatus(http.StatusUnauthorized)
		return
	}
	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 40*1024*1024))
	if err != nil {
		c.AbortWithStatus(http.StatusBadRequest)
		return
	}
	if err := h.service.HandleWebhook(body); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "ok")
}
