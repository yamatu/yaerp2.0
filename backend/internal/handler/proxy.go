package handler

import (
	"errors"
	"io"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type ProxyHandler struct{ service *service.ProxyService }

func NewProxyHandler(proxyService *service.ProxyService) *ProxyHandler {
	return &ProxyHandler{service: proxyService}
}

func (h *ProxyHandler) Status(c *gin.Context) {
	status, err := h.service.Status()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, status)
}

func (h *ProxyHandler) ImportSubscription(c *gin.Context) {
	var request model.ProxySubscriptionInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	status, err := h.service.ImportSubscription(request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "订阅导入成功", status)
}

func (h *ProxyHandler) RefreshSubscription(c *gin.Context) {
	status, err := h.service.RefreshSubscription()
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "订阅已刷新", status)
}

func (h *ProxyHandler) DeleteSubscription(c *gin.Context) {
	status, err := h.service.DeleteSubscription()
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "订阅已删除", status)
}

func (h *ProxyHandler) ListNodes(c *gin.Context) {
	nodes, groups, err := h.service.ListNodes()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, gin.H{"nodes": nodes, "groups": groups})
}

func (h *ProxyHandler) TestNodes(c *gin.Context) {
	var request model.ProxyTestInput
	if err := c.ShouldBindJSON(&request); err != nil && !errors.Is(err, io.EOF) {
		response.BadRequest(c, err.Error())
		return
	}
	results, err := h.service.TestNodes(request.Names)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, gin.H{"results": results})
}

func (h *ProxyHandler) SelectNode(c *gin.Context) {
	var request model.ProxySelectInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	status, err := h.service.SelectNode(request.Node)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "节点已切换", status)
}

func (h *ProxyHandler) Connect(c *gin.Context) {
	status, err := h.service.Connect()
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "代理已连接", status)
}

func (h *ProxyHandler) Disconnect(c *gin.Context) {
	status, err := h.service.Disconnect()
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "代理已断开", status)
}

func (h *ProxyHandler) UpdateToggles(c *gin.Context) {
	var request model.ProxyToggleInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	status, err := h.service.UpdateToggles(request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "代理分流设置已更新", status)
}

// UpdatePort changes the mixed port the core listens on and that consumers use.
func (h *ProxyHandler) UpdatePort(c *gin.Context) {
	var request model.ProxyPortInput
	if err := c.ShouldBindJSON(&request); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	status, err := h.service.UpdatePort(request)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsgData(c, "代理端口已更新", status)
}
