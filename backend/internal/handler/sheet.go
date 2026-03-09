package handler

import (
	"encoding/json"
	"strconv"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type SheetHandler struct {
	sheetService *service.SheetService
}

func NewSheetHandler(sheetService *service.SheetService) *SheetHandler {
	return &SheetHandler{sheetService: sheetService}
}

func (h *SheetHandler) ListWorkbooks(c *gin.Context) {
	userID := c.GetInt64("user_id")
	workbooks, _, err := h.sheetService.ListWorkbooks(userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, workbooks)
}

func (h *SheetHandler) CreateWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	var req model.CreateWorkbookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	wb := &model.Workbook{
		Name:        req.Name,
		Description: &req.Description,
		OwnerID:     userID,
		IsTemplate:  req.IsTemplate,
	}
	if err := h.sheetService.CreateWorkbook(wb); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, wb)
}

func (h *SheetHandler) GetWorkbook(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}
	wb, err := h.sheetService.GetWorkbook(id)
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}
	response.OK(c, wb)
}

func (h *SheetHandler) UpdateWorkbook(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	var req model.UpdateWorkbookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	wb := &model.Workbook{ID: id}
	if req.Name != nil {
		wb.Name = *req.Name
	}
	if req.Description != nil {
		wb.Description = req.Description
	}
	if err := h.sheetService.UpdateWorkbook(wb); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "workbook updated")
}

func (h *SheetHandler) DeleteWorkbook(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}
	if err := h.sheetService.DeleteWorkbook(id); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "workbook deleted")
}

func (h *SheetHandler) CreateSheet(c *gin.Context) {
	workbookID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	var req model.CreateSheetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	cols := req.Columns
	if cols == nil {
		cols = json.RawMessage("[]")
	}

	sheet := &model.Sheet{
		WorkbookID: workbookID,
		Name:       req.Name,
		Columns:    cols,
	}
	if err := h.sheetService.CreateSheet(sheet); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, sheet)
}

func (h *SheetHandler) UpdateSheet(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	var req model.UpdateSheetRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	existing, err := h.sheetService.GetSheet(id)
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}

	sheet := &model.Sheet{
		ID:         id,
		WorkbookID: existing.WorkbookID,
		Name:       existing.Name,
		SortOrder:  existing.SortOrder,
		Columns:    existing.Columns,
		Frozen:     existing.Frozen,
		Config:     existing.Config,
	}
	if req.Name != nil {
		sheet.Name = *req.Name
	}
	if req.Columns != nil {
		sheet.Columns = *req.Columns
	}
	if req.SortOrder != nil {
		sheet.SortOrder = *req.SortOrder
	}
	if req.Frozen != nil {
		sheet.Frozen = *req.Frozen
	}
	if req.Config != nil {
		sheet.Config = *req.Config
	}
	if err := h.sheetService.UpdateSheet(sheet); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "sheet updated")
}

func (h *SheetHandler) DeleteSheet(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	if err := h.sheetService.DeleteSheet(id); err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "sheet deleted")
}

func (h *SheetHandler) GetSheetData(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	rows, err := h.sheetService.GetSheetData(id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, rows)
}
