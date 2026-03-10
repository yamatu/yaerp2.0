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

	isDefaultAdmin, err := h.userRepo.IsDefaultAdminUser(id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if isDefaultAdmin && req.Status != nil && *req.Status == 0 {
		response.Error(c, http.StatusForbidden, "default admin user cannot be disabled")
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

	isDefaultAdmin, err := h.userRepo.IsDefaultAdminUser(id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if isDefaultAdmin {
		response.Error(c, http.StatusForbidden, "default admin user cannot be deleted")
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

	isDefaultAdmin, err := h.userRepo.IsDefaultAdminUser(id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if isDefaultAdmin {
		roles, err := h.userRepo.GetUserRoles(id)
		if err != nil {
			response.ServerError(c, err.Error())
			return
		}
		adminRoleID := int64(0)
		for _, role := range roles {
			if role.Code == "admin" {
				adminRoleID = role.ID
				break
			}
		}
		if adminRoleID != 0 {
			hasAdminRole := false
			for _, roleID := range req.Roles {
				if roleID == adminRoleID {
					hasAdminRole = true
					break
				}
			}
			if !hasAdminRole {
				response.Error(c, http.StatusForbidden, "default admin user must keep admin role")
				return
			}
		}
	}

	if err := h.userRepo.AssignRoles(id, req.Roles); err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}

	response.OKMsg(c, "roles assigned")
}

func (h *UserHandler) ResetPassword(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}

	var req model.ResetPasswordRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.authService.ResetPassword(id, req.NewPassword); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "password reset")
}
