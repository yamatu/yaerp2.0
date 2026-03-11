package handler

import (
	"errors"
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type FolderHandler struct {
	folderService *service.FolderService
}

func NewFolderHandler(folderService *service.FolderService) *FolderHandler {
	return &FolderHandler{folderService: folderService}
}

func (h *FolderHandler) CreateFolder(c *gin.Context) {
	userID := c.GetInt64("user_id")

	var req model.CreateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	folder := &model.Folder{
		Name:     req.Name,
		ParentID: req.ParentID,
		OwnerID:  userID,
	}

	if err := h.folderService.CreateForUser(userID, folder); err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to create folders here")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, folder)
}

func (h *FolderHandler) ListContents(c *gin.Context) {
	userID := c.GetInt64("user_id")

	var parentID *int64
	if pidStr := c.Query("parent_id"); pidStr != "" {
		pid, err := strconv.ParseInt(pidStr, 10, 64)
		if err != nil {
			response.BadRequest(c, "invalid parent_id")
			return
		}
		parentID = &pid
	}

	contents, err := h.folderService.ListContents(parentID, userID)
	if err != nil {
		if errors.Is(err, service.ErrFolderAccessDenied) {
			response.Forbidden(c, "you do not have permission to view this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, contents)
}

func (h *FolderHandler) UpdateFolder(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	var req model.UpdateFolderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	folder, err := h.folderService.Get(id)
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}

	if req.Name != nil {
		folder.Name = *req.Name
	}

	if err := h.folderService.UpdateForUser(userID, folder); err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to manage this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "folder updated")
}

func (h *FolderHandler) DeleteFolder(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	if err := h.folderService.DeleteForUser(userID, id); err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to manage this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "folder deleted")
}

func (h *FolderHandler) MoveWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	var req model.MoveWorkbookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.folderService.MoveWorkbookForUser(userID, id, req.FolderID); err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) || errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to move this workbook")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "workbook moved")
}

func (h *FolderHandler) SetVisibility(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	var req model.SetFolderVisibilityRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.folderService.SetVisibility(id, req.Visibility); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "visibility updated")
}

func (h *FolderHandler) GetBreadcrumb(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	path, err := h.folderService.GetBreadcrumbForUser(userID, id)
	if err != nil {
		if errors.Is(err, service.ErrFolderAccessDenied) {
			response.Forbidden(c, "you do not have permission to view this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, path)
}

func (h *FolderHandler) GetShares(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	shares, err := h.folderService.GetSharesForUser(userID, id)
	if err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to manage this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, shares)
}

func (h *FolderHandler) GetShareableUsers(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	users, err := h.folderService.ListShareableUsersForUser(userID, id)
	if err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to manage this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, users)
}

func (h *FolderHandler) SetShares(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid folder id")
		return
	}

	var req model.SetFolderSharesRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.folderService.SetSharesForUser(userID, id, req.Shares); err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to manage this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "folder shares updated")
}

func (h *FolderHandler) ListSharedFolders(c *gin.Context) {
	userID := c.GetInt64("user_id")
	folders, err := h.folderService.ListDirectlySharedForUser(userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, folders)
}
