package handler

import (
	"net/http"
	"strconv"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type UserHandler struct {
	userRepo      *repo.UserRepo
	authService   *service.AuthService
	uploadService *service.UploadService
}

func NewUserHandler(userRepo *repo.UserRepo, authService *service.AuthService, uploadService *service.UploadService) *UserHandler {
	return &UserHandler{userRepo: userRepo, authService: authService, uploadService: uploadService}
}

func (h *UserHandler) UpdateOwnAvatar(c *gin.Context) {
	var req model.UserAvatarRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	userID := c.GetInt64("user_id")
	attachment, err := h.uploadService.GetAttachment(req.AttachmentID)
	if err != nil {
		response.BadRequest(c, "avatar image not found")
		return
	}
	if attachment.UploaderID != userID {
		response.Forbidden(c, "只能使用自己上传的图片作为头像")
		return
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		response.BadRequest(c, "头像必须是图片")
		return
	}
	avatarURL, err := h.uploadService.GetFileURL(attachment.ID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if err := h.userRepo.Update(userID, &model.UpdateUserRequest{Avatar: &avatarURL}); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	profile, err := h.authService.GetProfile(userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, profile)
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

func (h *UserHandler) ListShareableUsers(c *gin.Context) {
	currentUserID := c.GetInt64("user_id")

	users, _, err := h.userRepo.List(1, 1000)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	shareable := make([]model.User, 0, len(users))
	for _, user := range users {
		if user.ID == currentUserID || user.Status != 1 {
			continue
		}
		shareable = append(shareable, model.User{
			ID:       user.ID,
			Username: user.Username,
			Email:    user.Email,
			Avatar:   user.Avatar,
			Status:   user.Status,
		})
	}

	response.OK(c, shareable)
}

func (h *UserHandler) CreateUser(c *gin.Context) {
	var req model.CreateUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	user, err := h.authService.CreateUser(&req)
	if err != nil {
		response.Error(c, http.StatusConflict, err.Error())
		return
	}

	if len(req.RoleIDs) > 0 {
		if err := h.userRepo.AssignRoles(user.ID, req.RoleIDs); err != nil {
			response.Error(c, http.StatusInternalServerError, err.Error())
			return
		}
	}

	roles, err := h.userRepo.GetUserRoles(user.ID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	user.Roles = roles

	response.OK(c, user)
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
	if req.Status != nil && *req.Status == 0 {
		if err := h.authService.RevokeUserSessions(id); err != nil {
			response.ServerError(c, err.Error())
			return
		}
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
	currentUserID := c.GetInt64("user_id")
	if id == currentUserID {
		response.Error(c, http.StatusForbidden, "cannot delete the currently signed-in account")
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

	if err := h.authService.RevokeUserSessions(id); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if err := h.userRepo.DeleteAndTransfer(id, currentUserID); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "员工账号已删除，名下业务数据已转交当前管理员")
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

	if err := h.authService.RevokeUserSessions(id); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if err := h.authService.ResetPassword(id, req.NewPassword); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "password reset")
}
