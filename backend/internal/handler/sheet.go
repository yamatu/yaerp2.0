package handler

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"reflect"
	"strconv"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type sheetBroadcaster interface {
	BroadcastToSheetExceptClientID(sheetID int64, data []byte, excludeClientID string)
	BroadcastToSheetByUser(sheetID int64, excludeClientID string, payloadForUser func(userID int64) []byte)
}

type SheetHandler struct {
	sheetService *service.SheetService
	broadcaster  sheetBroadcaster
}

func NewSheetHandler(sheetService *service.SheetService, broadcaster ...sheetBroadcaster) *SheetHandler {
	var b sheetBroadcaster
	if len(broadcaster) > 0 {
		b = broadcaster[0]
	}
	return &SheetHandler{sheetService: sheetService, broadcaster: b}
}

func (h *SheetHandler) broadcastSheetReload(c *gin.Context, sheetIDs ...int64) {
	if h.broadcaster == nil {
		return
	}

	excludeClientID := c.GetHeader("X-Client-Id")
	if excludeClientID == "" {
		return
	}
	userID := c.GetInt64("user_id")
	seen := make(map[int64]struct{}, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		if sheetID <= 0 {
			continue
		}
		if _, ok := seen[sheetID]; ok {
			continue
		}
		seen[sheetID] = struct{}{}

		payload, err := json.Marshal(gin.H{
			"type":    "sheet_reload",
			"sheetId": sheetID,
			"userId":  userID,
		})
		if err != nil {
			log.Printf("failed to marshal sheet reload payload for sheet %d: %v", sheetID, err)
			continue
		}
		h.broadcaster.BroadcastToSheetExceptClientID(sheetID, payload, excludeClientID)
	}
}

func (h *SheetHandler) broadcastSheetSync(c *gin.Context, sheetIDs ...int64) {
	if h.broadcaster == nil {
		return
	}

	excludeClientID := c.GetHeader("X-Client-Id")
	if excludeClientID == "" {
		return
	}
	userID := c.GetInt64("user_id")
	seen := make(map[int64]struct{}, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		if sheetID <= 0 {
			continue
		}
		if _, ok := seen[sheetID]; ok {
			continue
		}
		seen[sheetID] = struct{}{}

		payload, err := json.Marshal(gin.H{
			"type":    "sheet_sync",
			"sheetId": sheetID,
			"userId":  userID,
		})
		if err != nil {
			log.Printf("failed to marshal sheet sync payload for sheet %d: %v", sheetID, err)
			continue
		}
		h.broadcaster.BroadcastToSheetExceptClientID(sheetID, payload, excludeClientID)
	}
}

func (h *SheetHandler) broadcastProtectionUpdated(c *gin.Context, sheetIDs ...int64) {
	if h.broadcaster == nil {
		return
	}
	excludeClientID := c.GetHeader("X-Client-Id")
	userID := c.GetInt64("user_id")
	seen := make(map[int64]struct{}, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		if sheetID <= 0 {
			continue
		}
		if _, exists := seen[sheetID]; exists {
			continue
		}
		seen[sheetID] = struct{}{}
		payload, err := json.Marshal(gin.H{
			"type":    "protection_updated",
			"sheetId": sheetID,
			"userId":  userID,
		})
		if err != nil {
			continue
		}
		h.broadcaster.BroadcastToSheetExceptClientID(sheetID, payload, excludeClientID)
	}
}

func (h *SheetHandler) broadcastSheetCellChanges(c *gin.Context, sheetIDs []int64, changes []model.CellUpdate) {
	if h.broadcaster == nil || len(changes) == 0 {
		return
	}

	excludeClientID := c.GetHeader("X-Client-Id")
	if excludeClientID == "" {
		return
	}
	userID := c.GetInt64("user_id")
	seen := make(map[int64]struct{}, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		if sheetID <= 0 {
			continue
		}
		if _, ok := seen[sheetID]; ok {
			continue
		}
		seen[sheetID] = struct{}{}

		targetChanges := make([]model.CellUpdate, 0, len(changes))
		for _, change := range changes {
			if change.Row < 0 || strings.TrimSpace(change.Col) == "" {
				continue
			}
			targetChange := change
			targetChange.SheetID = sheetID
			targetChanges = append(targetChanges, targetChange)
		}
		if len(targetChanges) == 0 {
			continue
		}
		h.broadcaster.BroadcastToSheetByUser(sheetID, excludeClientID, func(recipientUserID int64) []byte {
			filteredChanges, err := h.sheetService.RealtimeCellChangesForUser(sheetID, recipientUserID, targetChanges)
			if err != nil {
				log.Printf("failed to build realtime sheet changes for sheet %d user %d: %v", sheetID, recipientUserID, err)
				return nil
			}
			if len(filteredChanges) == 0 {
				return nil
			}
			payload, err := json.Marshal(gin.H{
				"type":    "batch_update",
				"sheetId": sheetID,
				"userId":  userID,
				"changes": filteredChanges,
			})
			if err != nil {
				log.Printf("failed to marshal realtime sheet changes for sheet %d user %d: %v", sheetID, recipientUserID, err)
				return nil
			}
			return payload
		})
	}
}

func sheetChanged(existing, next *model.Sheet) bool {
	return existing.Name != next.Name ||
		existing.SortOrder != next.SortOrder ||
		!jsonRawEqual(existing.Columns, next.Columns) ||
		!jsonRawEqual(existing.Frozen, next.Frozen) ||
		!jsonRawEqual(existing.Config, next.Config)
}

func sheetStructureChanged(existing, next *model.Sheet) bool {
	return existing.Name != next.Name ||
		existing.SortOrder != next.SortOrder ||
		!jsonRawEqual(existing.Columns, next.Columns) ||
		!jsonRawEqual(existing.Frozen, next.Frozen)
}

func jsonRawEqual(left, right json.RawMessage) bool {
	if bytes.Equal(left, right) {
		return true
	}

	var leftValue any
	var rightValue any
	if err := json.Unmarshal(left, &leftValue); err != nil {
		return false
	}
	if err := json.Unmarshal(right, &rightValue); err != nil {
		return false
	}
	return reflect.DeepEqual(leftValue, rightValue)
}

func (h *SheetHandler) ListWorkbooks(c *gin.Context) {
	userID := c.GetInt64("user_id")
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "1000"))
	if page < 1 {
		page = 1
	}
	if size < 1 {
		size = 1000
	}
	workbooks, _, err := h.sheetService.ListWorkbooks(userID, page, size)
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
		FolderID:    req.FolderID,
		IsTemplate:  req.IsTemplate,
	}
	if err := h.sheetService.CreateWorkbookForUser(userID, wb); err != nil {
		if errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to create workbooks in this folder")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, wb)
}

func (h *SheetHandler) DuplicateWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	workbookID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	clone, err := h.sheetService.DuplicateWorkbookForUser(userID, workbookID)
	if err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) || errors.Is(err, service.ErrFolderManageDenied) {
			response.Forbidden(c, "you do not have permission to duplicate this workbook")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, clone)
}

func (h *SheetHandler) GetWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}
	wb, err := h.sheetService.GetWorkbook(id, userID)
	if err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, "you do not have permission to access this workbook")
			return
		}
		response.NotFound(c, err.Error())
		return
	}
	response.OK(c, wb)
}

func (h *SheetHandler) UpdateWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
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
	if err := h.sheetService.UpdateWorkbookForUser(userID, wb); err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, "you do not have permission to manage this workbook")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "workbook updated")
}

func (h *SheetHandler) UpdateWorkbookState(c *gin.Context) {
	userID := c.GetInt64("user_id")
	username := c.GetString("username")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	var req model.UpdateWorkbookStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	updated, err := h.sheetService.UpdateWorkbookState(userID, id, username, req.Action)
	if err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, updated)
}

func (h *SheetHandler) UpdateWorkbookStates(c *gin.Context) {
	userID := c.GetInt64("user_id")
	username := c.GetString("username")

	var req model.BatchUpdateWorkbookStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	updated, err := h.sheetService.UpdateWorkbookStates(userID, req.WorkbookIDs, username, req.Action)
	if err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, updated)
}

func (h *SheetHandler) DeleteWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}
	if err := h.sheetService.DeleteWorkbookForUser(userID, id); err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) || errors.Is(err, service.ErrWorkbookDeletionDenied) {
			response.Forbidden(c, "you do not have permission to manage this workbook")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "workbook deleted")
}

func (h *SheetHandler) CreateSheet(c *gin.Context) {
	userID := c.GetInt64("user_id")
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
	if err := h.sheetService.CreateSheetForUser(userID, sheet); err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, "you do not have permission to manage this workbook")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, sheet)
}

func (h *SheetHandler) DuplicateSheet(c *gin.Context) {
	userID := c.GetInt64("user_id")
	sheetID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	clone, err := h.sheetService.DuplicateSheetForUser(userID, sheetID)
	if err != nil {
		if errors.Is(err, service.ErrWorkbookAccessDenied) {
			response.Forbidden(c, "you do not have permission to duplicate this sheet")
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, clone)
}

func (h *SheetHandler) GetSheet(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	sheet, err := h.sheetService.GetSheetForUser(id, c.GetInt64("user_id"))
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}

	response.OK(c, sheet)
}

func (h *SheetHandler) UpdateSheet(c *gin.Context) {
	userID := c.GetInt64("user_id")
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
	if err := h.sheetService.ValidateCellChangesForUser(userID, id, req.CellChanges); err != nil {
		if errors.Is(err, service.ErrProtectionDenied) || errors.Is(err, service.ErrSheetPermissionDenied) ||
			errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) || errors.Is(err, service.ErrSheetStateDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	cellResult, err := h.sheetService.PrepareSheetCellChanges(userID, existing, sheet, req.CellChanges, "web")
	if err != nil {
		if errors.Is(err, service.ErrProtectionDenied) || errors.Is(err, service.ErrSheetPermissionDenied) ||
			errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) || errors.Is(err, service.ErrSheetStateDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		if errors.Is(err, service.ErrAutomationInvalid) {
			response.BadRequest(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	req.CellChanges = cellResult.AppliedChanges
	if !sheetChanged(existing, sheet) {
		response.OK(c, cellResult)
		return
	}
	if err := h.sheetService.UpdateSheetForUser(userID, existing, sheet); err != nil {
		if errors.Is(err, service.ErrProtectionDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		if errors.Is(err, service.ErrSheetPermissionDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		if errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	affectedSheetIDs := []int64{id}
	syncedSheetIDs, syncErr := h.sheetService.SyncAssignedSheetGroup(userID, id)
	if syncErr != nil {
		log.Printf("failed to sync assigned sheet group for sheet %d: %v", id, syncErr)
	} else {
		affectedSheetIDs = append(affectedSheetIDs, syncedSheetIDs...)
	}
	if len(req.CellChanges) > 0 && !sheetStructureChanged(existing, sheet) {
		h.sheetService.NotifyCellChanges(userID, req.CellChanges, "web")
		h.broadcastSheetCellChanges(c, affectedSheetIDs, req.CellChanges)
	} else if sheetStructureChanged(existing, sheet) {
		h.broadcastSheetReload(c, affectedSheetIDs...)
	}
	response.OK(c, cellResult)
}

func (h *SheetHandler) DeleteSheet(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	if err := h.sheetService.DeleteSheetForUser(userID, id); err != nil {
		if errors.Is(err, service.ErrProtectionDenied) || errors.Is(err, service.ErrSheetPermissionDenied) ||
			errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) || errors.Is(err, service.ErrSheetStateDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	response.OKMsg(c, "sheet deleted")
}

func (h *SheetHandler) AssignWorkbook(c *gin.Context) {
	adminUserID := c.GetInt64("user_id")
	workbookID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	var req model.AssignWorkbookRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	if err := h.sheetService.AssignWorkbookToUsers(workbookID, adminUserID, req.UserIDs); err != nil {
		response.Error(c, http.StatusInternalServerError, err.Error())
		return
	}

	response.OKMsg(c, "workbook assigned")
}

func (h *SheetHandler) GetProtections(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	snapshot, err := h.sheetService.GetProtectionSnapshot(id, c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, snapshot)
}

func (h *SheetHandler) UpdateProtection(c *gin.Context) {
	userID := c.GetInt64("user_id")
	username := c.GetString("username")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	var req model.UpdateProtectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	updatedSheet, snapshot, err := h.sheetService.UpdateProtection(id, userID, username, &req)
	if err != nil {
		if errors.Is(err, service.ErrProtectionDenied) || errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	affectedSheetIDs := []int64{id}
	syncedSheetIDs, syncErr := h.sheetService.SyncAssignedSheetGroup(userID, id)
	if syncErr != nil {
		log.Printf("failed to sync assigned protections for sheet %d: %v", id, syncErr)
	} else {
		affectedSheetIDs = append(affectedSheetIDs, syncedSheetIDs...)
	}
	h.broadcastProtectionUpdated(c, affectedSheetIDs...)
	h.broadcastSheetSync(c, affectedSheetIDs...)

	response.OK(c, gin.H{
		"sheet":       updatedSheet,
		"protections": snapshot,
	})
}

func (h *SheetHandler) UpdateProtectionBatch(c *gin.Context) {
	userID := c.GetInt64("user_id")
	username := c.GetString("username")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	var req model.BatchUpdateProtectionRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	updatedSheet, snapshot, err := h.sheetService.UpdateProtectionBatch(id, userID, username, req.Items)
	if err != nil {
		if errors.Is(err, service.ErrProtectionDenied) || errors.Is(err, service.ErrSheetLocked) || errors.Is(err, service.ErrSheetArchived) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	affectedSheetIDs := []int64{id}
	syncedSheetIDs, syncErr := h.sheetService.SyncAssignedSheetGroup(userID, id)
	if syncErr != nil {
		log.Printf("failed to sync assigned protection batch for sheet %d: %v", id, syncErr)
	} else {
		affectedSheetIDs = append(affectedSheetIDs, syncedSheetIDs...)
	}
	h.broadcastProtectionUpdated(c, affectedSheetIDs...)
	h.broadcastSheetSync(c, affectedSheetIDs...)

	response.OK(c, gin.H{
		"sheet":       updatedSheet,
		"protections": snapshot,
	})
}

func (h *SheetHandler) UpdateSheetState(c *gin.Context) {
	userID := c.GetInt64("user_id")
	username := c.GetString("username")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	var req model.UpdateSheetStateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	updatedSheet, err := h.sheetService.UpdateSheetState(id, userID, username, req.Action)
	if err != nil {
		if errors.Is(err, service.ErrSheetStateDenied) {
			response.Forbidden(c, err.Error())
			return
		}
		response.ServerError(c, err.Error())
		return
	}
	h.broadcastSheetReload(c, id)

	response.OK(c, updatedSheet)
}

func (h *SheetHandler) GetSheetData(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}
	rows, err := h.sheetService.GetSheetDataForUser(id, c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, rows)
}

func (h *SheetHandler) ExportSheet(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	exportFile, err := h.sheetService.BuildSheetExportFile(userID, id, c.Query("filename"))
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSheetExportDenied), errors.Is(err, service.ErrWorkbookAccessDenied):
			response.Forbidden(c, err.Error())
		default:
			response.ServerError(c, err.Error())
		}
		return
	}

	setExportDownloadHeaders(c, exportFile.Filename, exportFile.ContentType, len(exportFile.Data))
	c.Data(http.StatusOK, exportFile.ContentType, exportFile.Data)
}

func (h *SheetHandler) ExportSheetPDF(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid sheet id")
		return
	}

	options, err := service.ParsePDFExportOptions(c.Query("paper_size"), c.Query("orientation"), c.Query("fit_to_width"))
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	exportFile, err := h.sheetService.BuildSheetPDFFile(userID, id, c.Query("filename"), options)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSheetExportDenied), errors.Is(err, service.ErrWorkbookAccessDenied):
			response.Forbidden(c, err.Error())
		default:
			response.ServerError(c, err.Error())
		}
		return
	}

	setExportDownloadHeaders(c, exportFile.Filename, exportFile.ContentType, len(exportFile.Data))
	c.Data(http.StatusOK, exportFile.ContentType, exportFile.Data)
}

func (h *SheetHandler) ExportWorkbook(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	sheetIDs, err := parseSheetIDQuery(c)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	exportFile, err := h.sheetService.BuildWorkbookExportFile(userID, id, sheetIDs, c.Query("filename"))
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSheetExportDenied), errors.Is(err, service.ErrWorkbookAccessDenied):
			response.Forbidden(c, err.Error())
		default:
			response.ServerError(c, err.Error())
		}
		return
	}

	setExportDownloadHeaders(c, exportFile.Filename, exportFile.ContentType, len(exportFile.Data))
	c.Data(http.StatusOK, exportFile.ContentType, exportFile.Data)
}

func (h *SheetHandler) ExportWorkbookPDF(c *gin.Context) {
	userID := c.GetInt64("user_id")
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	sheetIDs, err := parseSheetIDQuery(c)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	options, err := service.ParsePDFExportOptions(c.Query("paper_size"), c.Query("orientation"), c.Query("fit_to_width"))
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	exportFile, err := h.sheetService.BuildWorkbookPDFFile(userID, id, sheetIDs, c.Query("filename"), options)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSheetExportDenied), errors.Is(err, service.ErrWorkbookAccessDenied):
			response.Forbidden(c, err.Error())
		default:
			response.ServerError(c, err.Error())
		}
		return
	}

	setExportDownloadHeaders(c, exportFile.Filename, exportFile.ContentType, len(exportFile.Data))
	c.Data(http.StatusOK, exportFile.ContentType, exportFile.Data)
}

func parseSheetIDQuery(c *gin.Context) ([]int64, error) {
	values := make([]string, 0)
	if raw := strings.TrimSpace(c.Query("sheet_ids")); raw != "" {
		values = append(values, strings.Split(raw, ",")...)
	}
	values = append(values, c.QueryArray("sheet_id")...)

	ids := make([]int64, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		id, err := strconv.ParseInt(value, 10, 64)
		if err != nil || id <= 0 {
			return nil, fmt.Errorf("invalid sheet id: %s", value)
		}
		ids = append(ids, id)
	}
	return ids, nil
}

func setExportDownloadHeaders(c *gin.Context, filename, contentType string, contentLength int) {
	escapedFilename := strings.ReplaceAll(url.QueryEscape(filename), "+", "%20")
	asciiFallback := buildASCIIFilename(filename)
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", asciiFallback, escapedFilename))
	c.Header("Content-Length", strconv.Itoa(contentLength))
	c.Header("X-Content-Type-Options", "nosniff")
}

func buildASCIIFilename(filename string) string {
	var builder strings.Builder
	for _, r := range filename {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			builder.WriteRune(r)
		case strings.ContainsRune("._-() ", r):
			builder.WriteRune(r)
		}
	}
	result := strings.TrimSpace(builder.String())
	result = strings.ReplaceAll(result, "  ", " ")
	if result == "" || strings.HasPrefix(result, ".") {
		ext := ""
		if index := strings.LastIndex(filename, "."); index >= 0 {
			ext = filename[index:]
		}
		return "download" + ext
	}
	return result
}
