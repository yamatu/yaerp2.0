package handler

import (
	"fmt"
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type CellHandler struct {
	sheetService *service.SheetService
	permService  *service.PermissionService
}

func NewCellHandler(sheetService *service.SheetService, permService *service.PermissionService) *CellHandler {
	return &CellHandler{sheetService: sheetService, permService: permService}
}

func (h *CellHandler) BatchUpdate(c *gin.Context) {
	userID := c.GetInt64("user_id")

	var req model.BatchUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	isAdmin, err := h.permService.IsAdmin(userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	for _, change := range req.Changes {
		allowed, err := h.permService.CheckCellPermission(change.SheetID, userID, change.Col, change.Row, "write")
		if err != nil {
			response.ServerError(c, err.Error())
			return
		}
		if !allowed {
			response.Forbidden(c, fmt.Sprintf("no write permission for %s%d", change.Col, change.Row+1))
			return
		}

		if !isAdmin {
			protected, reason, err := h.sheetService.CheckProtection(change.SheetID, change.Row, change.Col, userID)
			if err != nil {
				response.ServerError(c, err.Error())
				return
			}
			if protected {
				response.Forbidden(c, reason)
				return
			}
		}
	}

	if err := h.sheetService.UpdateCells(userID, req.Changes); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "cells updated")
}

func (h *CellHandler) InsertRow(c *gin.Context) {
	userID := c.GetInt64("user_id")
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	var body struct {
		AfterRow int `json:"after_row"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	allowed, err := h.permService.CheckCellPermission(sheetID, userID, "", body.AfterRow, "write")
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if !allowed {
		response.Forbidden(c, "no permission to insert rows")
		return
	}

	protected, reason, err := h.sheetService.CheckProtection(sheetID, body.AfterRow, "", userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if protected {
		response.Forbidden(c, reason)
		return
	}

	if err := h.sheetService.InsertRow(sheetID, body.AfterRow); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "row inserted")
}

func (h *CellHandler) DeleteRow(c *gin.Context) {
	userID := c.GetInt64("user_id")
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	rowIndex, err := strconv.Atoi(c.Param("index"))
	if err != nil {
		response.BadRequest(c, "invalid row index")
		return
	}

	allowed, err := h.permService.CheckCellPermission(sheetID, userID, "", rowIndex, "write")
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if !allowed {
		response.Forbidden(c, "no permission to delete rows")
		return
	}

	protected, reason, err := h.sheetService.CheckProtection(sheetID, rowIndex, "", userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if protected {
		response.Forbidden(c, reason)
		return
	}

	if err := h.sheetService.DeleteRow(sheetID, rowIndex); err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKMsg(c, "row deleted")
}
