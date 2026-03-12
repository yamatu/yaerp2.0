package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

var ErrWorkbookAccessDenied = errors.New("workbook access denied")
var ErrWorkbookDeletionDenied = errors.New("workbook deletion denied")
var ErrProtectionDenied = errors.New("protection denied")
var ErrSheetPermissionDenied = errors.New("sheet permission denied")
var ErrSheetExportDenied = errors.New("sheet export denied")
var ErrSheetLocked = errors.New("sheet is locked")
var ErrSheetArchived = errors.New("sheet is archived")
var ErrSheetStateDenied = errors.New("sheet state change denied")

type protectionOwner struct {
	OwnerID     int64  `json:"ownerId"`
	OwnerName   string `json:"ownerName"`
	ProtectedAt string `json:"protectedAt"`
}

type protectionMaps struct {
	Rows    map[string]protectionOwner `json:"rows,omitempty"`
	Columns map[string]protectionOwner `json:"columns,omitempty"`
	Cells   map[string]protectionOwner `json:"cells,omitempty"`
}

type SheetService struct {
	sheetRepo   *repo.SheetRepo
	permService *PermissionService
}

func NewSheetService(sheetRepo *repo.SheetRepo, permService *PermissionService) *SheetService {
	return &SheetService{sheetRepo: sheetRepo, permService: permService}
}

// Workbook operations

func (s *SheetService) CreateWorkbookForUser(userID int64, workbook *model.Workbook) error {
	if workbook.FolderID != nil {
		canWriteFolder, err := s.permService.CanWriteFolder(*workbook.FolderID, userID)
		if err != nil {
			return err
		}
		if !canWriteFolder {
			return ErrFolderManageDenied
		}
	}

	return s.sheetRepo.CreateWorkbook(workbook)
}

func (s *SheetService) GetWorkbook(id int64, userID int64) (*model.Workbook, error) {
	wb, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	if err := applyWorkbookLifecycleState(wb); err != nil {
		return nil, err
	}
	if err := s.ensureWorkbookVisible(wb, userID); err != nil {
		return nil, err
	}
	sheets, err := s.sheetRepo.GetSheetsByWorkbook(id)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleStates(sheets); err != nil {
		return nil, err
	}

	canManageWorkbook, err := s.CanManageWorkbook(userID, wb)
	if err != nil {
		return nil, err
	}
	if canManageWorkbook {
		wb.Sheets = sheets
		return wb, nil
	}

	canViewWorkbook, err := s.permService.CanViewWorkbook(wb, userID)
	if err != nil {
		return nil, err
	}
	if !canViewWorkbook {
		return nil, ErrWorkbookAccessDenied
	}
	if len(sheets) == 0 {
		wb.Sheets = []model.Sheet{}
		return wb, nil
	}

	visibleSheets := make([]model.Sheet, 0, len(sheets))
	for _, sheet := range sheets {
		matrix, err := s.permService.GetPermissionMatrix(sheet.ID, userID)
		if err != nil {
			return nil, fmt.Errorf("check sheet %d permission: %w", sheet.ID, err)
		}
		if matrix.Sheet.CanView {
			visibleSheets = append(visibleSheets, sheet)
		}
	}

	if len(visibleSheets) == 0 {
		return nil, ErrWorkbookAccessDenied
	}

	wb.Sheets = visibleSheets
	return wb, nil
}

func (s *SheetService) ListWorkbooks(userID int64, page, size int) ([]model.Workbook, int64, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, 0, err
	}

	if isAdmin {
		workbooks, total, err := s.sheetRepo.ListWorkbooks(nil, page, size)
		if err != nil {
			return nil, 0, err
		}
		if err := applyWorkbookLifecycleStates(workbooks); err != nil {
			return nil, 0, err
		}
		return workbooks, total, nil
	}

	allWorkbooks, _, err := s.sheetRepo.ListWorkbooks(nil, 1, 10000)
	if err != nil {
		return nil, 0, err
	}
	if err := applyWorkbookLifecycleStates(allWorkbooks); err != nil {
		return nil, 0, err
	}

	accessible := make([]model.Workbook, 0, len(allWorkbooks))
	for _, workbook := range allWorkbooks {
		canView, err := s.permService.CanViewWorkbook(&workbook, userID)
		if err != nil {
			return nil, 0, err
		}
		if canView {
			accessible = append(accessible, workbook)
		}
	}

	total := int64(len(accessible))
	start := (page - 1) * size
	if start >= len(accessible) {
		return []model.Workbook{}, total, nil
	}
	end := start + size
	if end > len(accessible) {
		end = len(accessible)
	}

	return accessible[start:end], total, nil
}

func (s *SheetService) UpdateWorkbookForUser(userID int64, workbook *model.Workbook) error {
	existing, err := s.sheetRepo.GetWorkbook(workbook.ID)
	if err != nil {
		return err
	}
	if err := applyWorkbookLifecycleState(existing); err != nil {
		return err
	}

	canManageWorkbook, err := s.CanManageWorkbook(userID, existing)
	if err != nil {
		return err
	}
	if !canManageWorkbook {
		return ErrWorkbookAccessDenied
	}
	if err := s.ensureWorkbookVisible(existing, userID); err != nil {
		return err
	}

	if workbook.Name == "" {
		workbook.Name = existing.Name
	}
	if workbook.Description == nil {
		workbook.Description = existing.Description
	}
	if len(workbook.Metadata) == 0 {
		workbook.Metadata = existing.Metadata
	}
	workbook.OwnerID = existing.OwnerID
	workbook.FolderID = existing.FolderID
	workbook.IsTemplate = existing.IsTemplate
	workbook.Status = existing.Status

	return s.sheetRepo.UpdateWorkbook(workbook)
}

func (s *SheetService) DeleteWorkbookForUser(userID, id int64) error {
	workbook, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return err
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return err
	}

	canManageWorkbook, err := s.CanManageWorkbook(userID, workbook)
	if err != nil {
		return err
	}
	if !canManageWorkbook {
		return ErrWorkbookAccessDenied
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		if workbook.IsLocked || workbook.IsHidden {
			return fmt.Errorf("%w: 当前工作簿已被管理员锁定或隐藏，仅管理员可以删除", ErrWorkbookDeletionDenied)
		}
		if workbookIsAssigned(workbook) {
			return fmt.Errorf("%w: 任务工作簿仅管理员可以删除", ErrWorkbookDeletionDenied)
		}

		sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
		if err != nil {
			return err
		}
		if err := applySheetLifecycleStates(sheets); err != nil {
			return err
		}
		for _, sheet := range sheets {
			if sheet.IsLocked || sheet.IsArchived {
				return fmt.Errorf("%w: 包含已锁定或已归档的工作表，仅管理员可以删除", ErrWorkbookDeletionDenied)
			}
		}
	}

	return s.sheetRepo.DeleteWorkbook(id)
}

func (s *SheetService) UpdateWorkbookState(userID, id int64, username, action string) (*model.Workbook, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		return nil, fmt.Errorf("%w: only admins can change workbook state", ErrWorkbookAccessDenied)
	}

	workbook, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	payload, state, err := parseWorkbookLifecycleState(workbook.Metadata)
	if err != nil {
		return nil, err
	}

	actor := &sheetStateUser{ID: userID, Name: username, At: time.Now().Format(time.RFC3339)}
	switch action {
	case "lock":
		state.Locked = actor
	case "unlock":
		state.Locked = nil
	case "hide":
		state.Hidden = actor
	case "unhide":
		state.Hidden = nil
	default:
		return nil, fmt.Errorf("unsupported workbook state action")
	}

	if state.Locked == nil && state.Hidden == nil {
		delete(payload, "workbookState")
	} else {
		payload["workbookState"] = state
	}

	nextMetadata, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal workbook state metadata: %w", err)
	}

	workbook.Metadata = nextMetadata
	if err := s.sheetRepo.UpdateWorkbook(workbook); err != nil {
		return nil, err
	}

	updated, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	if err := applyWorkbookLifecycleState(updated); err != nil {
		return nil, err
	}
	return updated, nil
}

func (s *SheetService) UpdateWorkbookStates(userID int64, workbookIDs []int64, username, action string) ([]model.Workbook, error) {
	updated := make([]model.Workbook, 0, len(workbookIDs))
	seen := make(map[int64]struct{}, len(workbookIDs))

	for _, workbookID := range workbookIDs {
		if workbookID == 0 {
			continue
		}
		if _, ok := seen[workbookID]; ok {
			continue
		}
		seen[workbookID] = struct{}{}

		workbook, err := s.UpdateWorkbookState(userID, workbookID, username, action)
		if err != nil {
			return nil, err
		}
		updated = append(updated, *workbook)
	}

	return updated, nil
}

// Sheet operations

func (s *SheetService) CreateSheetForUser(userID int64, sheet *model.Sheet) error {
	wb, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return err
	}
	if err := applyWorkbookLifecycleState(wb); err != nil {
		return err
	}

	canManageWorkbook, err := s.CanManageWorkbook(userID, wb)
	if err != nil {
		return err
	}
	if !canManageWorkbook {
		return ErrWorkbookAccessDenied
	}
	if err := s.ensureWorkbookVisible(wb, userID); err != nil {
		return err
	}
	if wb.IsLocked {
		isAdmin, err := s.permService.IsAdmin(userID)
		if err != nil {
			return err
		}
		if !isAdmin {
			return fmt.Errorf("%w: 当前工作簿已锁定，仅管理员可以新增工作表", ErrWorkbookAccessDenied)
		}
	}

	nextSortOrder, err := s.sheetRepo.GetNextSheetSortOrder(sheet.WorkbookID)
	if err != nil {
		return err
	}
	sheet.SortOrder = nextSortOrder

	return s.sheetRepo.CreateSheet(sheet)
}

func (s *SheetService) UpdateSheetForUser(userID int64, existing, sheet *model.Sheet) error {
	if err := applySheetLifecycleState(existing); err != nil {
		return err
	}
	if err := s.ensureSheetModificationAllowed(existing, userID); err != nil {
		return err
	}
	if err := s.ensureEditableCellsAuthorized(userID, existing, sheet); err != nil {
		return err
	}
	if err := s.ensureProtectedCellsUnchanged(userID, existing, sheet); err != nil {
		return err
	}

	mergedConfig, err := mergeProtectionState(existing.Config, sheet.Config)
	if err != nil {
		return err
	}
	sheet.Config = mergedConfig

	return s.sheetRepo.UpdateSheet(sheet)
}

func (s *SheetService) GetSheet(id int64) (*model.Sheet, error) {
	sheet, err := s.sheetRepo.GetSheet(id)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, err
	}
	return sheet, nil
}

func (s *SheetService) DeleteSheet(id int64) error {
	return s.sheetRepo.DeleteSheet(id)
}

func (s *SheetService) AssignWorkbookToUsers(workbookID, adminUserID int64, userIDs []int64) error {
	template, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return err
	}

	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return err
	}

	rowMap := make(map[int64][]model.Row, len(sheets))
	for _, sheet := range sheets {
		rows, err := s.sheetRepo.GetRows(sheet.ID)
		if err != nil {
			return fmt.Errorf("load rows for sheet %d: %w", sheet.ID, err)
		}
		rowMap[sheet.ID] = rows
	}

	for _, userID := range userIDs {
		clone := &model.Workbook{
			Name:        template.Name,
			Description: template.Description,
			OwnerID:     userID,
			Metadata: json.RawMessage(fmt.Sprintf(`{"source_workbook_id":%d,"assigned_by":%d,"assigned_at":%q}`,
				workbookID,
				adminUserID,
				time.Now().Format(time.RFC3339),
			)),
			IsTemplate: false,
			Status:     1,
		}
		if err := s.sheetRepo.CreateWorkbook(clone); err != nil {
			return fmt.Errorf("create assigned workbook for user %d: %w", userID, err)
		}

		for _, sheet := range sheets {
			clonedSheet := &model.Sheet{
				WorkbookID: clone.ID,
				Name:       sheet.Name,
				SortOrder:  sheet.SortOrder,
				Columns:    sheet.Columns,
				Frozen:     sheet.Frozen,
				Config:     sheet.Config,
			}
			if err := s.sheetRepo.CreateSheet(clonedSheet); err != nil {
				return fmt.Errorf("create assigned sheet %s for user %d: %w", sheet.Name, userID, err)
			}

			for _, row := range rowMap[sheet.ID] {
				if err := s.sheetRepo.UpsertRow(clonedSheet.ID, row.RowIndex, row.Data, adminUserID); err != nil {
					return fmt.Errorf("copy row %d for user %d: %w", row.RowIndex, userID, err)
				}
			}
		}
	}

	return nil
}

// Data operations

func (s *SheetService) GetSheetData(sheetID int64) ([]model.Row, error) {
	return s.sheetRepo.GetRows(sheetID)
}

func (s *SheetService) UpdateCells(userID int64, changes []model.CellUpdate) error {
	if len(changes) == 0 {
		return nil
	}

	sheets := make(map[int64]*model.Sheet)
	for _, change := range changes {
		sheet, ok := sheets[change.SheetID]
		if !ok {
			loadedSheet, err := s.sheetRepo.GetSheet(change.SheetID)
			if err != nil {
				return fmt.Errorf("failed to get sheet: %w", err)
			}
			if err := applySheetLifecycleState(loadedSheet); err != nil {
				return err
			}
			if err := s.ensureSheetModificationAllowed(loadedSheet, userID); err != nil {
				return err
			}
			sheets[change.SheetID] = loadedSheet
			sheet = loadedSheet
		}
		_ = sheet

		// Get existing row data or start fresh
		existingRows, err := s.sheetRepo.GetRows(change.SheetID)
		if err != nil {
			return fmt.Errorf("failed to get rows: %w", err)
		}

		var rowData map[string]interface{}
		for _, r := range existingRows {
			if r.RowIndex == change.Row {
				if err := json.Unmarshal(r.Data, &rowData); err != nil {
					rowData = make(map[string]interface{})
				}
				break
			}
		}
		if rowData == nil {
			rowData = make(map[string]interface{})
		}

		// Update the cell value
		var val interface{}
		if err := json.Unmarshal(change.Value, &val); err != nil {
			val = string(change.Value)
		}
		rowData[change.Col] = val

		data, err := json.Marshal(rowData)
		if err != nil {
			return fmt.Errorf("failed to marshal row data: %w", err)
		}

		if err := s.sheetRepo.UpsertRow(change.SheetID, change.Row, data, userID); err != nil {
			return fmt.Errorf("failed to upsert row: %w", err)
		}
	}

	return nil
}

func (s *SheetService) InsertRow(userID, sheetID int64, rowIndex int) error {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return err
	}
	if err := s.ensureSheetModificationAllowed(sheet, userID); err != nil {
		return err
	}

	nextConfig, err := shiftProtectionRowsInConfig(sheet.Config, rowIndex, true)
	if err != nil {
		return err
	}

	return s.sheetRepo.InsertRowWithConfig(sheetID, rowIndex, nextConfig)
}

func (s *SheetService) DeleteRow(userID, sheetID int64, rowIndex int) error {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return err
	}
	if err := s.ensureSheetModificationAllowed(sheet, userID); err != nil {
		return err
	}

	nextConfig, err := shiftProtectionRowsInConfig(sheet.Config, rowIndex, false)
	if err != nil {
		return err
	}

	return s.sheetRepo.DeleteRowWithConfig(sheetID, rowIndex, nextConfig)
}

func (s *SheetService) GetProtectionSnapshot(sheetID int64) (*model.ProtectionSnapshot, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, err
	}

	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, err
	}

	snapshot := &model.ProtectionSnapshot{
		Rows:    flattenProtectionMap("row", protections.Rows),
		Columns: flattenProtectionMap("column", protections.Columns),
		Cells:   flattenProtectionMap("cell", protections.Cells),
	}
	return snapshot, nil
}

func (s *SheetService) UpdateProtection(sheetID, userID int64, username string, req *model.UpdateProtectionRequest) (*model.Sheet, *model.ProtectionSnapshot, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, nil, err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, nil, err
	}
	if err := s.ensureSheetModificationAllowed(sheet, userID); err != nil {
		return nil, nil, err
	}

	payload, protections, legacyLocks, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, nil, err
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, nil, err
	}

	if err := applyProtectionRequest(&protections, payload, legacyLocks, req, userID, username, isAdmin); err != nil {
		return nil, nil, err
	}
	finalizeProtectionPayload(payload, protections, legacyLocks)

	nextConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal protection config: %w", err)
	}

	sheet.Config = nextConfig
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, nil, err
	}

	snapshot := &model.ProtectionSnapshot{
		Rows:    flattenProtectionMap("row", protections.Rows),
		Columns: flattenProtectionMap("column", protections.Columns),
		Cells:   flattenProtectionMap("cell", protections.Cells),
	}

	updatedSheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, nil, err
	}
	if err := applySheetLifecycleState(updatedSheet); err != nil {
		return nil, nil, err
	}

	return updatedSheet, snapshot, nil
}

func (s *SheetService) UpdateProtectionBatch(sheetID, userID int64, username string, items []model.UpdateProtectionRequest) (*model.Sheet, *model.ProtectionSnapshot, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, nil, err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, nil, err
	}
	if err := s.ensureSheetModificationAllowed(sheet, userID); err != nil {
		return nil, nil, err
	}

	payload, protections, legacyLocks, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, nil, err
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, nil, err
	}

	for i := range items {
		if err := applyProtectionRequest(&protections, payload, legacyLocks, &items[i], userID, username, isAdmin); err != nil {
			return nil, nil, err
		}
	}
	finalizeProtectionPayload(payload, protections, legacyLocks)

	nextConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, nil, fmt.Errorf("marshal protection config: %w", err)
	}

	sheet.Config = nextConfig
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, nil, err
	}

	snapshot := &model.ProtectionSnapshot{
		Rows:    flattenProtectionMap("row", protections.Rows),
		Columns: flattenProtectionMap("column", protections.Columns),
		Cells:   flattenProtectionMap("cell", protections.Cells),
	}

	updatedSheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, nil, err
	}
	if err := applySheetLifecycleState(updatedSheet); err != nil {
		return nil, nil, err
	}

	return updatedSheet, snapshot, nil
}

func (s *SheetService) UpdateSheetState(sheetID, userID int64, username, action string) (*model.Sheet, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		return nil, fmt.Errorf("%w: only admins can change locked/archive state", ErrSheetStateDenied)
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	payload, state, err := parseSheetLifecycleState(sheet.Config)
	if err != nil {
		return nil, err
	}

	actor := &sheetStateUser{ID: userID, Name: username, At: time.Now().Format(time.RFC3339)}
	switch action {
	case "lock":
		state.Locked = actor
	case "unlock":
		state.Locked = nil
	case "archive":
		state.Archived = actor
	case "unarchive":
		state.Archived = nil
	default:
		return nil, fmt.Errorf("unsupported sheet state action")
	}

	if state.Locked == nil && state.Archived == nil {
		delete(payload, "sheetState")
	} else {
		payload["sheetState"] = state
	}

	nextConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal sheet state config: %w", err)
	}

	sheet.Config = nextConfig
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return nil, err
	}

	updatedSheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleState(updatedSheet); err != nil {
		return nil, err
	}

	return updatedSheet, nil
}

func (s *SheetService) CheckProtection(sheetID int64, rowIndex int, colKey string, userID int64) (bool, string, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return false, "", err
	}
	if isAdmin {
		return false, "", nil
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return false, "", err
	}

	_, protections, legacyLocks, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return false, "", err
	}

	checks := []struct {
		scope string
		info  protectionOwner
	}{
		{scope: "cell", info: protections.Cells[fmt.Sprintf("%d:%s", rowIndex, colKey)]},
		{scope: "row", info: protections.Rows[fmt.Sprintf("%d", rowIndex)]},
		{scope: "column", info: protections.Columns[colKey]},
	}

	for _, check := range checks {
		if check.info.OwnerID == 0 || check.info.OwnerID == userID {
			continue
		}
		return true, buildProtectionMessage(check.scope, check.info.OwnerName, rowIndex, colKey), nil
	}

	legacyKey := fmt.Sprintf("%d:%s", rowIndex, colKey)
	if legacyLocks[legacyKey] {
		return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, rowIndex+2), nil
	}

	return false, "", nil
}

func (s *SheetService) CanManageWorkbook(userID int64, workbook *model.Workbook) (bool, error) {
	canManage, err := s.permService.CanManageWorkbook(workbook, userID)
	if err != nil {
		return false, fmt.Errorf("check workbook manage permission: %w", err)
	}

	return canManage, nil
}

func parseSheetConfigProtection(config json.RawMessage) (map[string]interface{}, protectionMaps, map[string]bool, error) {
	payload := make(map[string]interface{})
	if len(config) > 0 {
		if err := json.Unmarshal(config, &payload); err != nil {
			return nil, protectionMaps{}, nil, fmt.Errorf("parse sheet config: %w", err)
		}
	}

	protections := protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{},
		Cells:   map[string]protectionOwner{},
	}
	if raw, ok := payload["protections"]; ok {
		buf, _ := json.Marshal(raw)
		_ = json.Unmarshal(buf, &protections)
		if protections.Rows == nil {
			protections.Rows = map[string]protectionOwner{}
		}
		if protections.Columns == nil {
			protections.Columns = map[string]protectionOwner{}
		}
		if protections.Cells == nil {
			protections.Cells = map[string]protectionOwner{}
		}
	}

	legacyLocks := map[string]bool{}
	if raw, ok := payload["lockedCells"]; ok {
		buf, _ := json.Marshal(raw)
		_ = json.Unmarshal(buf, &legacyLocks)
	}

	return payload, protections, legacyLocks, nil
}

func resolveProtectionTarget(scope string, rowIndex *int, columnKey *string, protections protectionMaps) (*map[string]protectionOwner, string, protectionOwner, error) {
	switch scope {
	case "row":
		if rowIndex == nil {
			return nil, "", protectionOwner{}, fmt.Errorf("row_index is required for row protection")
		}
		key := fmt.Sprintf("%d", *rowIndex)
		return &protections.Rows, key, protections.Rows[key], nil
	case "column":
		if columnKey == nil || strings.TrimSpace(*columnKey) == "" {
			return nil, "", protectionOwner{}, fmt.Errorf("column_key is required for column protection")
		}
		key := strings.TrimSpace(*columnKey)
		return &protections.Columns, key, protections.Columns[key], nil
	case "cell":
		if rowIndex == nil || columnKey == nil || strings.TrimSpace(*columnKey) == "" {
			return nil, "", protectionOwner{}, fmt.Errorf("row_index and column_key are required for cell protection")
		}
		key := fmt.Sprintf("%d:%s", *rowIndex, strings.TrimSpace(*columnKey))
		return &protections.Cells, key, protections.Cells[key], nil
	default:
		return nil, "", protectionOwner{}, fmt.Errorf("unsupported protection scope")
	}
}

func applyProtectionRequest(protections *protectionMaps, payload map[string]interface{}, legacyLocks map[string]bool, req *model.UpdateProtectionRequest, userID int64, username string, isAdmin bool) error {
	mapRef, key, info, err := resolveProtectionTarget(req.Scope, req.RowIndex, req.ColumnKey, *protections)
	if err != nil {
		return err
	}

	if req.Action == "lock" {
		if info.OwnerID != 0 && info.OwnerID != userID && !isAdmin {
			return fmt.Errorf("%w: 此保护已由 %s 添加", ErrProtectionDenied, info.OwnerName)
		}
		(*mapRef)[key] = protectionOwner{
			OwnerID:     userID,
			OwnerName:   username,
			ProtectedAt: time.Now().Format(time.RFC3339),
		}
		return nil
	}

	if info.OwnerID != 0 && info.OwnerID != userID && !isAdmin {
		return fmt.Errorf("%w: 仅管理员或保护创建者可以解除保护", ErrProtectionDenied)
	}
	delete(*mapRef, key)
	if req.Scope == "cell" && legacyLocks[key] {
		delete(legacyLocks, key)
		if len(legacyLocks) == 0 {
			delete(payload, "lockedCells")
		} else {
			payload["lockedCells"] = legacyLocks
		}
	}

	return nil
}

func finalizeProtectionPayload(payload map[string]interface{}, protections protectionMaps, legacyLocks map[string]bool) {
	if !hasAnyProtection(protections) {
		delete(payload, "protections")
	} else {
		payload["protections"] = protections
	}

	if len(legacyLocks) == 0 {
		delete(payload, "lockedCells")
	} else {
		payload["lockedCells"] = legacyLocks
	}
}

func flattenProtectionMap(scope string, items map[string]protectionOwner) []model.ProtectionInfo {
	result := make([]model.ProtectionInfo, 0, len(items))
	for key, info := range items {
		if info.OwnerID == 0 {
			continue
		}

		entry := model.ProtectionInfo{
			Scope:     scope,
			Key:       key,
			OwnerID:   info.OwnerID,
			OwnerName: info.OwnerName,
		}
		if parsedTime, err := time.Parse(time.RFC3339, info.ProtectedAt); err == nil {
			entry.ProtectedAt = parsedTime
		}

		switch scope {
		case "row":
			if row, err := strconv.Atoi(key); err == nil {
				entry.RowIndex = &row
			}
		case "column":
			column := key
			entry.ColumnKey = &column
		case "cell":
			parts := strings.SplitN(key, ":", 2)
			if len(parts) == 2 {
				if row, err := strconv.Atoi(parts[0]); err == nil {
					entry.RowIndex = &row
				}
				column := parts[1]
				entry.ColumnKey = &column
			}
		}

		result = append(result, entry)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].ProtectedAt.Equal(result[j].ProtectedAt) {
			return result[i].Key < result[j].Key
		}
		return result[i].ProtectedAt.After(result[j].ProtectedAt)
	})

	return result
}

func hasAnyProtection(protections protectionMaps) bool {
	return len(protections.Rows) > 0 || len(protections.Columns) > 0 || len(protections.Cells) > 0
}

func buildProtectionMessage(scope, ownerName string, rowIndex int, colKey string) string {
	switch scope {
	case "row":
		return fmt.Sprintf("第 %d 行已由 %s 添加保护", rowIndex+2, ownerName)
	case "column":
		return fmt.Sprintf("列 %s 已由 %s 添加保护", colKey, ownerName)
	default:
		return fmt.Sprintf("单元格 %s%d 已由 %s 添加保护", colKey, rowIndex+2, ownerName)
	}
}

func (s *SheetService) ensureProtectedCellsUnchanged(userID int64, existing, next *model.Sheet) error {
	accessCache, err := newSheetCellAccessCache(s.permService, userID, existing.ID, existing.Config, true)
	if err != nil {
		return err
	}
	if accessCache.isAdmin {
		return nil
	}

	currentCells := extractUniverCellData(existing.Config)
	nextCells := extractUniverCellData(next.Config)
	if len(currentCells) == 0 && len(nextCells) == 0 {
		return nil
	}

	columnKeys, err := parseColumnKeys(next.Columns)
	if err != nil {
		return err
	}
	if len(columnKeys) == 0 {
		columnKeys, err = parseColumnKeys(existing.Columns)
		if err != nil {
			return err
		}
	}

	keys := make(map[string]struct{}, len(currentCells)+len(nextCells))
	for key := range currentCells {
		keys[key] = struct{}{}
	}
	for key := range nextCells {
		keys[key] = struct{}{}
	}

	for key := range keys {
		if currentCells[key] == nextCells[key] {
			continue
		}

		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			continue
		}
		worksheetRow, err := strconv.Atoi(parts[0])
		if err != nil || worksheetRow < 0 {
			continue
		}
		columnIndex, err := strconv.Atoi(parts[1])
		if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) {
			continue
		}

		protected, reason := accessCache.checkProtection(columnKeys[columnIndex], worksheetRow, userID)
		if protected {
			return fmt.Errorf("%w: %s", ErrProtectionDenied, reason)
		}
	}

	return nil
}

func (s *SheetService) ensureEditableCellsAuthorized(userID int64, existing, next *model.Sheet) error {
	accessCache, err := newSheetCellAccessCache(s.permService, userID, existing.ID, existing.Config, false)
	if err != nil {
		return err
	}
	if accessCache.isAdmin {
		return nil
	}

	currentCells := extractUniverCellData(existing.Config)
	nextCells := extractUniverCellData(next.Config)
	if len(currentCells) == 0 && len(nextCells) == 0 {
		return nil
	}

	columnKeys, err := parseColumnKeys(next.Columns)
	if err != nil {
		return err
	}
	if len(columnKeys) == 0 {
		columnKeys, err = parseColumnKeys(existing.Columns)
		if err != nil {
			return err
		}
	}

	keys := make(map[string]struct{}, len(currentCells)+len(nextCells))
	for key := range currentCells {
		keys[key] = struct{}{}
	}
	for key := range nextCells {
		keys[key] = struct{}{}
	}

	for key := range keys {
		if currentCells[key] == nextCells[key] {
			continue
		}

		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			continue
		}
		worksheetRow, err := strconv.Atoi(parts[0])
		if err != nil || worksheetRow < 0 {
			continue
		}
		columnIndex, err := strconv.Atoi(parts[1])
		if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) {
			continue
		}

		columnKey := columnKeys[columnIndex]
		allowed := accessCache.allowsCell(columnKey, worksheetRow, "write")
		if !allowed {
			return fmt.Errorf("%w: no write permission for %s%d", ErrSheetPermissionDenied, columnKey, worksheetRow+1)
		}
	}

	return nil
}

func (s *SheetService) checkProtectionByWorksheetRow(config json.RawMessage, worksheetRowIndex int, colKey string, userID int64) (bool, string, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return false, "", err
	}
	if isAdmin {
		return false, "", nil
	}

	_, protections, legacyLocks, err := parseSheetConfigProtection(config)
	if err != nil {
		return false, "", err
	}

	dataRowIndex := worksheetRowIndex - 1
	if dataRowIndex < -1 {
		return false, "", nil
	}

	checks := []struct {
		scope string
		info  protectionOwner
	}{
		{scope: "cell", info: protections.Cells[fmt.Sprintf("%d:%s", dataRowIndex, colKey)]},
		{scope: "row", info: protections.Rows[fmt.Sprintf("%d", dataRowIndex)]},
		{scope: "column", info: protections.Columns[colKey]},
	}

	for _, check := range checks {
		if check.info.OwnerID == 0 || check.info.OwnerID == userID {
			continue
		}
		return true, buildProtectionMessage(check.scope, check.info.OwnerName, dataRowIndex, colKey), nil
	}

	legacyKey := fmt.Sprintf("%d:%s", dataRowIndex, colKey)
	if legacyLocks[legacyKey] {
		return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, dataRowIndex+2), nil
	}

	return false, "", nil
}

func extractUniverCellData(config json.RawMessage) map[string]string {
	result := make(map[string]string)
	if len(config) == 0 {
		return result
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(config, &payload); err != nil {
		return result
	}

	rawSheet, ok := payload["univerSheetData"]
	if !ok {
		return result
	}

	sheetData, ok := rawSheet.(map[string]interface{})
	if !ok {
		return result
	}

	rawCellData, ok := sheetData["cellData"].(map[string]interface{})
	if !ok {
		return result
	}

	for rowKey, rowValue := range rawCellData {
		rowMap, ok := rowValue.(map[string]interface{})
		if !ok {
			continue
		}
		for colKey, cellValue := range rowMap {
			encoded, _ := json.Marshal(cellValue)
			result[rowKey+":"+colKey] = string(encoded)
		}
	}

	return result
}

func parseColumnKeys(raw json.RawMessage) ([]string, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var columns []struct {
		Key string `json:"key"`
	}
	if err := json.Unmarshal(raw, &columns); err != nil {
		return nil, fmt.Errorf("parse sheet columns: %w", err)
	}
	keys := make([]string, 0, len(columns))
	for _, column := range columns {
		keys = append(keys, column.Key)
	}
	return keys, nil
}

func mergeProtectionState(existingConfig, nextConfig json.RawMessage) (json.RawMessage, error) {
	nextPayload, _, _, err := parseSheetConfigProtection(nextConfig)
	if err != nil {
		return nil, err
	}

	_, existingProtections, existingLegacyLocks, err := parseSheetConfigProtection(existingConfig)
	if err != nil {
		return nil, err
	}

	if hasAnyProtection(existingProtections) {
		nextPayload["protections"] = existingProtections
	} else {
		delete(nextPayload, "protections")
	}

	if len(existingLegacyLocks) > 0 {
		nextPayload["lockedCells"] = existingLegacyLocks
	} else {
		delete(nextPayload, "lockedCells")
	}

	mergedConfig, err := json.Marshal(nextPayload)
	if err != nil {
		return nil, fmt.Errorf("marshal merged protection config: %w", err)
	}

	return mergedConfig, nil
}

func shiftProtectionRowsInConfig(config json.RawMessage, rowIndex int, insert bool) (json.RawMessage, error) {
	payload, protections, legacyLocks, err := parseSheetConfigProtection(config)
	if err != nil {
		return nil, err
	}

	anchorDataRow := rowIndex
	if insert {
		anchorDataRow = rowIndex + 1
	}
	protections.Rows = shiftRowProtectionMap(protections.Rows, anchorDataRow, insert)
	protections.Cells = shiftCellProtectionMap(protections.Cells, anchorDataRow, insert)
	legacyLocks = shiftLegacyLockMap(legacyLocks, anchorDataRow, insert)

	if hasAnyProtection(protections) {
		payload["protections"] = protections
	} else {
		delete(payload, "protections")
	}

	if len(legacyLocks) > 0 {
		payload["lockedCells"] = legacyLocks
	} else {
		delete(payload, "lockedCells")
	}

	nextConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal shifted protection config: %w", err)
	}

	return nextConfig, nil
}

func shiftRowProtectionMap(items map[string]protectionOwner, anchorWorksheetRow int, insert bool) map[string]protectionOwner {
	shifted := make(map[string]protectionOwner, len(items))
	for key, info := range items {
		row, err := strconv.Atoi(key)
		if err != nil {
			shifted[key] = info
			continue
		}

		nextRow, keep := shiftProtectedRowIndex(row, anchorWorksheetRow, insert)
		if !keep {
			continue
		}
		shifted[strconv.Itoa(nextRow)] = info
	}

	return shifted
}

func shiftCellProtectionMap(items map[string]protectionOwner, anchorWorksheetRow int, insert bool) map[string]protectionOwner {
	shifted := make(map[string]protectionOwner, len(items))
	for key, info := range items {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			shifted[key] = info
			continue
		}

		row, err := strconv.Atoi(parts[0])
		if err != nil {
			shifted[key] = info
			continue
		}

		nextRow, keep := shiftProtectedRowIndex(row, anchorWorksheetRow, insert)
		if !keep {
			continue
		}
		shifted[fmt.Sprintf("%d:%s", nextRow, parts[1])] = info
	}

	return shifted
}

func shiftLegacyLockMap(items map[string]bool, anchorWorksheetRow int, insert bool) map[string]bool {
	shifted := make(map[string]bool, len(items))
	for key, locked := range items {
		if !locked {
			continue
		}

		parts := strings.SplitN(key, ":", 2)
		if len(parts) != 2 {
			shifted[key] = true
			continue
		}

		row, err := strconv.Atoi(parts[0])
		if err != nil {
			shifted[key] = true
			continue
		}

		nextRow, keep := shiftProtectedRowIndex(row, anchorWorksheetRow, insert)
		if !keep {
			continue
		}
		shifted[fmt.Sprintf("%d:%s", nextRow, parts[1])] = true
	}

	return shifted
}

func shiftProtectedRowIndex(row, anchorWorksheetRow int, insert bool) (int, bool) {
	if insert {
		if row > anchorWorksheetRow {
			return row + 1, true
		}
		return row, true
	}

	if row == anchorWorksheetRow {
		return 0, false
	}
	if row > anchorWorksheetRow {
		return row - 1, true
	}
	return row, true
}
