package handler

import (
	"net/http"
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type UserHandler struct {
	userRepo    *repo.UserRepo
	authService *service.AuthService
}

func NewUserHandler(userRepo *repo.UserRepo, authService *service.AuthService) *UserHandler {
	return &UserHandler{userRepo: userRepo, authService: authService}
}

func (h *UserHandler) ListUsers(c *gin.Context) {
	page, _ := strconv.Atoi(c.Query("page"))
	size, _ := strconv.Atoi(c.Query("size"))
	if page <= 0 {
		page = 1
	}
	if size <= 0 {
		size = 20
	}

	users, total, err := h.userRepo.List(page, size)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKPage(c, users, total, page, size)
}

func (h *UserHandler) UpdateUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}

	var req model.UpdateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.userRepo.Update(id, &req); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "user updated")
}

func (h *UserHandler) DeleteUser(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}

	if err := h.userRepo.Delete(id); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "user deleted")
}

func (h *UserHandler) AssignRoles(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}

	var req model.AssignRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.userRepo.AssignRoles(id, req.Roles); err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}

	response.OKMsg(c, "roles assigned")
}
