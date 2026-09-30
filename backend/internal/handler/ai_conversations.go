package handler

import (
	"errors"
	"strconv"

	"github.com/gin-gonic/gin"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

func conversationID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		response.BadRequest(c, "无效的对话 ID")
		return 0, false
	}
	return id, true
}

func conversationError(c *gin.Context, err error) {
	if errors.Is(err, service.ErrConversationNotFound) {
		response.NotFound(c, err.Error())
		return
	}
	if errors.Is(err, service.ErrConversationBusy) {
		response.Conflict(c, err.Error())
		return
	}
	response.ServerError(c, err.Error())
}

func (h *AIHandler) ListConversations(c *gin.Context) {
	items, err := h.conversations.List(c.GetInt64("user_id"))
	if err != nil {
		conversationError(c, err)
		return
	}
	response.OK(c, items)
}

func (h *AIHandler) CreateConversation(c *gin.Context) {
	var req struct {
		AccountID   *int64                       `json:"account_id"`
		Title       string                       `json:"title"`
		AssistantID *int64                       `json:"assistant_id"`
		Messages    []service.DurableChatMessage `json:"messages"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	// A local-history import must not cross accounts if login changes while the
	// browser's asynchronous initialization is still in flight.
	if req.AccountID != nil && *req.AccountID != c.GetInt64("user_id") {
		response.Conflict(c, "登录账号已经切换，请重新打开对话")
		return
	}
	item, err := h.conversations.Create(c.GetInt64("user_id"), req.Title, req.AssistantID, req.Messages)
	if err != nil {
		conversationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) GetConversation(c *gin.Context) {
	id, ok := conversationID(c)
	if !ok {
		return
	}
	item, err := h.conversations.GetIfChanged(c.GetInt64("user_id"), id, c.Query("version"))
	if err != nil {
		conversationError(c, err)
		return
	}
	response.OK(c, item)
}

func (h *AIHandler) DeleteConversation(c *gin.Context) {
	id, ok := conversationID(c)
	if !ok {
		return
	}
	if err := h.conversations.Delete(c.GetInt64("user_id"), id); err != nil {
		conversationError(c, err)
		return
	}
	response.OKMsg(c, "对话已删除")
}

func (h *AIHandler) StartConversationTurn(c *gin.Context) {
	id, ok := conversationID(c)
	if !ok {
		return
	}
	var req service.StartConversationTurn
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	if len(req.Prompt) == 0 || len(req.Prompt) > maxChatMessageChars || len(req.RequestID) < 8 || len(req.RequestID) > 100 {
		response.BadRequest(c, "消息或请求标识无效")
		return
	}
	run, err := h.conversations.Start(c.GetInt64("user_id"), id, req)
	if err != nil {
		conversationError(c, err)
		return
	}
	response.OK(c, run)
}

func (h *AIHandler) StopConversationRun(c *gin.Context) {
	id, ok := conversationID(c)
	if !ok {
		return
	}
	runID, err := strconv.ParseInt(c.Param("run_id"), 10, 64)
	if err != nil || runID <= 0 {
		response.BadRequest(c, "无效的任务 ID")
		return
	}
	if err := h.conversations.Cancel(c.GetInt64("user_id"), id, runID); err != nil {
		conversationError(c, err)
		return
	}
	response.OKMsg(c, "已请求停止；已提交的操作不会自动回滚")
}

func (h *AIHandler) PatchConversationAction(c *gin.Context) {
	id, ok := conversationID(c)
	if !ok {
		return
	}
	var req struct {
		Kind    string `json:"kind"`
		State   string `json:"state"`
		Error   string `json:"error"`
		ClaimID string `json:"claim_id"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	if len(req.Error) > 2000 {
		response.BadRequest(c, "错误信息过长")
		return
	}
	if err := h.conversations.PatchActionState(c.GetInt64("user_id"), id, c.Param("message_id"), req.Kind, req.State, req.Error, req.ClaimID); err != nil {
		conversationError(c, err)
		return
	}
	response.OKMsg(c, "操作状态已同步")
}
