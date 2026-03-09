package handler

import (
	"net/http"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type AuthHandler struct {
	authService *service.AuthService
}

func NewAuthHandler(authService *service.AuthService) *AuthHandler {
	return &AuthHandler{authService: authService}
}

func (h *AuthHandler) Login(c *gin.Context) {
	var req model.LoginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	token, err := h.authService.Login(&req)
	if err != nil {
		response.Unauthorized(c, err.Error())
		return
	}

	response.OK(c, token)
}

func (h *AuthHandler) Register(c *gin.Context) {
	var req model.RegisterRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.authService.Register(&req); err != nil {
		response.Error(c, http.StatusConflict, err.Error())
		return
	}

	response.OKMsg(c, "registered successfully")
}

func (h *AuthHandler) Me(c *gin.Context) {
	userID := c.GetInt64("user_id")
	profile, err := h.authService.GetProfile(userID)
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}

	response.OK(c, profile)
}

func (h *AuthHandler) RefreshToken(c *gin.Context) {
	var body struct {
		RefreshToken string `json:"refresh_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	token, err := h.authService.RefreshToken(body.RefreshToken)
	if err != nil {
		response.Unauthorized(c, err.Error())
		return
	}

	response.OK(c, token)
}

func (h *AuthHandler) Logout(c *gin.Context) {
	userID := c.GetInt64("user_id")
	if err := h.authService.Logout(userID); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "logged out")
}
