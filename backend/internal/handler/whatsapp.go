package handler

import (
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

type WhatsAppHandler struct{ service *service.WhatsAppService }

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

func (h *WhatsAppHandler) GetOwnAccount(c *gin.Context) { h.getAccount(c, c.GetInt64("user_id")) }
func (h *WhatsAppHandler) StartOwnAccount(c *gin.Context) {
	h.accountAction(c, c.GetInt64("user_id"), "start")
}
func (h *WhatsAppHandler) RestartOwnAccount(c *gin.Context) {
	h.accountAction(c, c.GetInt64("user_id"), "restart")
}
func (h *WhatsAppHandler) LogoutOwnAccount(c *gin.Context) {
	h.accountAction(c, c.GetInt64("user_id"), "logout")
}

func (h *WhatsAppHandler) UpdateOwnPreferences(c *gin.Context) {
	var request struct {
		Enabled   bool `json:"enabled"`
		AutoStart bool `json:"auto_start"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	account, err := h.service.UpdateAccountPreferences(c.GetInt64("user_id"), c.GetInt64("user_id"), request.Enabled, request.AutoStart)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, account)
}

func (h *WhatsAppHandler) UpdateOwnAbout(c *gin.Context) {
	var request struct {
		About string `json:"about"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	account, err := h.service.UpdateAccountAbout(c.GetInt64("user_id"), c.GetInt64("user_id"), request.About)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, account)
}

func (h *WhatsAppHandler) ListOwnChats(c *gin.Context) {
	chats, err := h.service.ListChats(c.GetInt64("user_id"), c.GetInt64("user_id"))
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, chats)
}

func (h *WhatsAppHandler) MarkOwnChatRead(c *gin.Context) {
	chatID := strings.TrimSpace(c.Param("chatId"))
	if chatID == "" {
		response.BadRequest(c, "invalid WhatsApp chat id")
		return
	}
	if err := h.service.MarkOwnChatRead(c.GetInt64("user_id"), chatID); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "WhatsApp conversation marked as read")
}

func (h *WhatsAppHandler) SyncChannelHistory(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var request model.WhatsAppHistorySyncRequest
	if err := c.ShouldBindJSON(&request); err != nil && !errors.Is(err, io.EOF) {
		response.BadRequest(c, err.Error())
		return
	}
	result, err := h.service.SyncChannelHistory(c.GetInt64("user_id"), channelID, &request)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *WhatsAppHandler) SyncContactsToChannels(c *gin.Context) {
	var request model.WhatsAppContactSyncRequest
	if err := c.ShouldBindJSON(&request); err != nil && !errors.Is(err, io.EOF) {
		response.BadRequest(c, err.Error())
		return
	}
	result, err := h.service.SyncContactsToChannels(c.GetInt64("user_id"), &request)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *WhatsAppHandler) ListAccounts(c *gin.Context) {
	accounts, err := h.service.ListAccounts(c.GetInt64("user_id"))
	if err != nil {
		response.Forbidden(c, err.Error())
		return
	}
	response.OK(c, accounts)
}

func (h *WhatsAppHandler) GetManagedAccount(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}
	h.getAccount(c, userID)
}

func (h *WhatsAppHandler) ManagedAccountAction(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}
	h.accountAction(c, userID, c.Param("action"))
}

func (h *WhatsAppHandler) ListManagedChats(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}
	chats, err := h.service.ListChats(c.GetInt64("user_id"), userID)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, chats)
}

func (h *WhatsAppHandler) UpdateManagedPreferences(c *gin.Context) {
	userID, err := strconv.ParseInt(c.Param("userId"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}
	var request struct {
		Enabled   bool `json:"enabled"`
		AutoStart bool `json:"auto_start"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	account, err := h.service.UpdateAccountPreferences(c.GetInt64("user_id"), userID, request.Enabled, request.AutoStart)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, account)
}

func (h *WhatsAppHandler) getAccount(c *gin.Context, targetUserID int64) {
	account, err := h.service.GetAccount(c.GetInt64("user_id"), targetUserID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, account)
}

func (h *WhatsAppHandler) accountAction(c *gin.Context, targetUserID int64, action string) {
	var err error
	switch action {
	case "start":
		err = h.service.StartAccount(c.GetInt64("user_id"), targetUserID)
	case "restart":
		err = h.service.RestartAccount(c.GetInt64("user_id"), targetUserID)
	case "logout":
		err = h.service.LogoutAccount(c.GetInt64("user_id"), targetUserID)
	default:
		response.BadRequest(c, "unsupported action")
		return
	}
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "WhatsApp 账号操作已提交")
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
