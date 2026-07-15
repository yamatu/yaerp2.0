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
	OwnerID                 int64   `json:"ownerId"`
	OwnerName               string  `json:"ownerName"`
	ReadonlyUserIDs         []int64 `json:"readonlyUserIds,omitempty"`
	ReadonlyDepartmentIDs   []int64 `json:"readonlyDepartmentIds,omitempty"`
	EditableUserIDs         []int64 `json:"editableUserIds,omitempty"`
	EditableDepartmentIDs   []int64 `json:"editableDepartmentIds,omitempty"`
	ViewHiddenUserIDs       []int64 `json:"viewHiddenUserIds,omitempty"`
	ViewHiddenDepartmentIDs []int64 `json:"viewHiddenDepartmentIds,omitempty"`
	Hidden                  bool    `json:"hidden,omitempty"`
	ProtectedAt             string  `json:"protectedAt"`
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
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
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
		if sheet.IsHidden {
			continue
		}
		if canManageWorkbook {
			masked, err := s.maskSheetForUser(&sheet, userID)
			if err != nil {
				return nil, err
			}
			visibleSheets = append(visibleSheets, *masked)
			continue
		}
		matrix, err := s.permService.GetPermissionMatrix(sheet.ID, userID)
		if err != nil {
			return nil, fmt.Errorf("check sheet %d permission: %w", sheet.ID, err)
		}
		if matrix.Sheet.CanView {
			masked, err := s.maskSheetForUser(&sheet, userID)
			if err != nil {
				return nil, err
			}
			visibleSheets = append(visibleSheets, *masked)
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
			if err := ensureProtectionOwnership(sheet.Config, userID, "删除工作簿"); err != nil {
				return fmt.Errorf("%w: 工作表「%s」包含其他人设置的保护或隐藏区域", ErrWorkbookDeletionDenied, sheet.Name)
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

	workbook, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	canManage, err := s.permService.CanManageWorkbook(workbook, userID)
	if err != nil {
		return nil, err
	}
	if action == "publish" || action == "unpublish" {
		if !canManage {
			return nil, fmt.Errorf("%w: only the owner or an admin can change public access", ErrWorkbookAccessDenied)
		}
	} else if !isAdmin {
		return nil, fmt.Errorf("%w: only admins can change workbook state", ErrWorkbookAccessDenied)
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
	case "publish":
		state.Public = actor
	case "unpublish":
		state.Public = nil
	default:
		return nil, fmt.Errorf("unsupported workbook state action")
	}

	if state.Locked == nil && state.Hidden == nil && state.Public == nil {
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
	if err := s.ensureProtectedStructureMutationAllowed(userID, existing, sheet); err != nil {
		return err
	}
	restoredConfig, err := s.restoreHiddenCellsForUser(existing.ID, userID, existing.Config, sheet.Config, existing.Columns)
	if err != nil {
		return err
	}
	sheet.Config = restoredConfig
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
	removedColumns, err := removedColumnKeys(existing.Columns, sheet.Columns)
	if err != nil {
		return err
	}
	if len(removedColumns) > 0 {
		mergedConfig, err = removeColumnProtectionState(mergedConfig, removedColumns)
		if err != nil {
			return err
		}
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

func (s *SheetService) SyncAssignedSheetGroup(sheetID int64) ([]int64, error) {
	sourceSheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}

	sourceWorkbook, err := s.sheetRepo.GetWorkbook(sourceSheet.WorkbookID)
	if err != nil {
		return nil, err
	}

	sourceWorkbookID := assignmentSourceWorkbookID(sourceWorkbook)
	workbooks, err := s.sheetRepo.ListWorkbooksInAssignmentGroup(sourceWorkbookID)
	if err != nil {
		return nil, err
	}
	if len(workbooks) <= 1 {
		return nil, nil
	}

	affectedSheetIDs := make([]int64, 0, len(workbooks)-1)
	for _, workbook := range workbooks {
		if workbook.ID == sourceSheet.WorkbookID {
			continue
		}

		sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
		if err != nil {
			return nil, err
		}

		targetSheet := findAssignedGroupSheet(sourceSheet, sheets)
		if targetSheet == nil {
			continue
		}

		targetSheet.Name = sourceSheet.Name
		targetSheet.SortOrder = sourceSheet.SortOrder
		targetSheet.Columns = sourceSheet.Columns
		targetSheet.Frozen = sourceSheet.Frozen
		config, err := mergeAssignedSheetConfig(sourceSheet.Config, targetSheet.Config)
		if err != nil {
			return nil, err
		}
		targetSheet.Config = config
		if err := s.sheetRepo.UpdateSheet(targetSheet); err != nil {
			return nil, err
		}

		affectedSheetIDs = append(affectedSheetIDs, targetSheet.ID)
	}

	return affectedSheetIDs, nil
}

func assignmentSourceWorkbookID(workbook *model.Workbook) int64 {
	if workbook == nil {
		return 0
	}
	if len(workbook.Metadata) == 0 {
		return workbook.ID
	}

	var metadata map[string]interface{}
	if err := json.Unmarshal(workbook.Metadata, &metadata); err != nil {
		return workbook.ID
	}

	switch value := metadata["source_workbook_id"].(type) {
	case float64:
		if value > 0 {
			return int64(value)
		}
	case string:
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil && parsed > 0 {
			return parsed
		}
	}

	return workbook.ID
}

func mergeAssignedSheetConfig(sourceConfig, targetConfig json.RawMessage) (json.RawMessage, error) {
	sourcePayload := make(map[string]interface{})
	if len(sourceConfig) > 0 {
		if err := json.Unmarshal(sourceConfig, &sourcePayload); err != nil {
			return nil, fmt.Errorf("parse source assigned sheet config: %w", err)
		}
	}

	if len(targetConfig) == 0 {
		return json.Marshal(sourcePayload)
	}

	var targetPayload map[string]interface{}
	if err := json.Unmarshal(targetConfig, &targetPayload); err != nil {
		return nil, fmt.Errorf("parse target assigned sheet config: %w", err)
	}

	if sheetState, ok := targetPayload["sheetState"]; ok {
		sourcePayload["sheetState"] = sheetState
	} else {
		delete(sourcePayload, "sheetState")
	}

	return json.Marshal(sourcePayload)
}

func findAssignedGroupSheet(sourceSheet *model.Sheet, candidates []model.Sheet) *model.Sheet {
	for i := range candidates {
		if candidates[i].SortOrder == sourceSheet.SortOrder {
			return &candidates[i]
		}
	}

	for i := range candidates {
		if candidates[i].Name == sourceSheet.Name {
			return &candidates[i]
		}
	}

	return nil
}

func (s *SheetService) DeleteSheetForUser(userID, id int64) error {
	sheet, err := s.sheetRepo.GetSheet(id)
	if err != nil {
		return err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return err
	}
	if err := s.ensureSheetModificationAllowed(sheet, userID); err != nil {
		return err
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		if err := ensureProtectionOwnership(sheet.Config, userID, "删除工作表"); err != nil {
			return err
		}
	}
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

func (s *SheetService) ValidateCellChangesForUser(userID, sheetID int64, changes []model.CellUpdate) error {
	if len(changes) == 0 {
		return nil
	}
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
	accessCache, err := newSheetCellAccessCache(s.permService, userID, sheetID, sheet.Config, true)
	if err != nil {
		return err
	}
	for _, change := range changes {
		if change.Row < 0 || strings.TrimSpace(change.Col) == "" {
			return fmt.Errorf("invalid cell target")
		}
		worksheetRow := change.Row + 1
		if !accessCache.allowsCell(change.Col, worksheetRow, "write") {
			return fmt.Errorf("%w: no write permission for %s%d", ErrSheetPermissionDenied, change.Col, change.Row+2)
		}
		if protected, reason := accessCache.checkProtection(change.Col, worksheetRow, userID); protected {
			return fmt.Errorf("%w: %s", ErrProtectionDenied, reason)
		}
	}
	return nil
}

func (s *SheetService) UpdateCells(userID int64, changes []model.CellUpdate) error {
	if len(changes) == 0 {
		return nil
	}

	sheets := make(map[int64]*model.Sheet)
	accessCaches := make(map[int64]*sheetCellAccessCache)
	for _, change := range changes {
		if change.Row < 0 || strings.TrimSpace(change.Col) == "" {
			return fmt.Errorf("invalid cell target")
		}
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
			accessCache, err := newSheetCellAccessCache(s.permService, userID, change.SheetID, loadedSheet.Config, true)
			if err != nil {
				return err
			}
			accessCaches[change.SheetID] = accessCache
		}
		_ = sheet
		accessCache := accessCaches[change.SheetID]
		worksheetRow := change.Row + 1
		if !accessCache.allowsCell(change.Col, worksheetRow, "write") {
			return fmt.Errorf("%w: no write permission for %s%d", ErrSheetPermissionDenied, change.Col, change.Row+2)
		}
		if protected, reason := accessCache.checkProtection(change.Col, worksheetRow, userID); protected {
			return fmt.Errorf("%w: %s", ErrProtectionDenied, reason)
		}

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
	if err := s.ensureRowDeletionAllowed(userID, sheet, rowIndex); err != nil {
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
	if req.Action == "lock" {
		if err := s.permService.ValidateEditableUsers(protectionRequestUserIDs(*req)); err != nil {
			return nil, nil, fmt.Errorf("%w: %v", ErrProtectionDenied, err)
		}
		if err := s.permService.ValidateDepartments(protectionRequestDepartmentIDs(*req)); err != nil {
			return nil, nil, fmt.Errorf("%w: %v", ErrProtectionDenied, err)
		}
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
	updatedSheet, err = s.maskSheetForUser(updatedSheet, userID)
	if err != nil {
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

	whitelistUserIDs := make([]int64, 0)
	whitelistDepartmentIDs := make([]int64, 0)
	seenWhitelistUserIDs := make(map[int64]struct{})
	seenWhitelistDepartmentIDs := make(map[int64]struct{})
	for index := range items {
		if items[index].Action != "lock" {
			continue
		}
		for _, userID := range protectionRequestUserIDs(items[index]) {
			if _, exists := seenWhitelistUserIDs[userID]; exists {
				continue
			}
			seenWhitelistUserIDs[userID] = struct{}{}
			whitelistUserIDs = append(whitelistUserIDs, userID)
		}
		for _, departmentID := range protectionRequestDepartmentIDs(items[index]) {
			if _, exists := seenWhitelistDepartmentIDs[departmentID]; exists {
				continue
			}
			seenWhitelistDepartmentIDs[departmentID] = struct{}{}
			whitelistDepartmentIDs = append(whitelistDepartmentIDs, departmentID)
		}
	}
	if err := s.permService.ValidateEditableUsers(whitelistUserIDs); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrProtectionDenied, err)
	}
	if err := s.permService.ValidateDepartments(whitelistDepartmentIDs); err != nil {
		return nil, nil, fmt.Errorf("%w: %v", ErrProtectionDenied, err)
	}

	for index := range items {
		if err := applyProtectionRequest(&protections, payload, legacyLocks, &items[index], userID, username, isAdmin); err != nil {
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
	updatedSheet, err = s.maskSheetForUser(updatedSheet, userID)
	if err != nil {
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
	case "hide":
		state.Hidden = actor
	case "unhide":
		state.Hidden = nil
	default:
		return nil, fmt.Errorf("unsupported sheet state action")
	}

	if state.Locked == nil && state.Archived == nil && state.Hidden == nil {
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
	departmentIDs, err := s.permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return false, "", err
	}
	departmentSet := int64Set(departmentIDs)

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
		if check.info.OwnerID == 0 || check.info.OwnerID == userID || protectionAllowsUser(check.info, userID, departmentSet) {
			continue
		}
		return true, buildProtectionMessage(check.scope, check.info.OwnerName, rowIndex, colKey), nil
	}
	if strings.TrimSpace(colKey) == "" {
		for protectedColumn, info := range protections.Columns {
			if info.OwnerID == 0 || info.OwnerID == userID || protectionAllowsUser(info, userID, departmentSet) {
				continue
			}
			return true, buildProtectionMessage("column", info.OwnerName, rowIndex, protectedColumn), nil
		}
		rowPrefix := fmt.Sprintf("%d:", rowIndex)
		for key, info := range protections.Cells {
			if !strings.HasPrefix(key, rowPrefix) || info.OwnerID == 0 || info.OwnerID == userID || protectionAllowsUser(info, userID, departmentSet) {
				continue
			}
			protectedColumn := strings.TrimPrefix(key, rowPrefix)
			return true, buildProtectionMessage("cell", info.OwnerName, rowIndex, protectedColumn), nil
		}
		for key, locked := range legacyLocks {
			if locked && strings.HasPrefix(key, rowPrefix) {
				return true, fmt.Sprintf("第 %d 行包含受保护的单元格", rowIndex+2), nil
			}
		}
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

func normalizeProtectionEditableUsers(userIDs []int64, ownerID int64) []int64 {
	if len(userIDs) == 0 {
		return nil
	}

	seen := map[int64]bool{}
	result := make([]int64, 0, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 || userID == ownerID || seen[userID] {
			continue
		}
		seen[userID] = true
		result = append(result, userID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

type normalizedProtectionAccess struct {
	ReadonlyUserIDs         []int64
	ReadonlyDepartmentIDs   []int64
	EditableUserIDs         []int64
	EditableDepartmentIDs   []int64
	ViewHiddenUserIDs       []int64
	ViewHiddenDepartmentIDs []int64
}

func protectionRequestUserIDs(req model.UpdateProtectionRequest) []int64 {
	result := make([]int64, 0, len(req.ReadonlyUserIDs)+len(req.EditableUserIDs)+len(req.ViewHiddenUserIDs))
	result = append(result, req.ReadonlyUserIDs...)
	result = append(result, req.EditableUserIDs...)
	result = append(result, req.ViewHiddenUserIDs...)
	return result
}

func protectionRequestDepartmentIDs(req model.UpdateProtectionRequest) []int64 {
	result := make([]int64, 0, len(req.ReadonlyDepartmentIDs)+len(req.EditableDepartmentIDs)+len(req.ViewHiddenDepartmentIDs))
	result = append(result, req.ReadonlyDepartmentIDs...)
	result = append(result, req.EditableDepartmentIDs...)
	result = append(result, req.ViewHiddenDepartmentIDs...)
	return result
}

func normalizeProtectionAccess(req *model.UpdateProtectionRequest, ownerID int64) normalizedProtectionAccess {
	editableUserIDs := normalizeProtectionEditableUsers(req.EditableUserIDs, ownerID)
	viewHiddenUserIDs := excludeProtectionIDs(
		normalizeProtectionEditableUsers(req.ViewHiddenUserIDs, ownerID),
		editableUserIDs,
	)
	readonlyUserIDs := excludeProtectionIDs(
		normalizeProtectionEditableUsers(req.ReadonlyUserIDs, ownerID),
		editableUserIDs,
		viewHiddenUserIDs,
	)

	editableDepartmentIDs := normalizeProtectionEditableUsers(req.EditableDepartmentIDs, 0)
	viewHiddenDepartmentIDs := excludeProtectionIDs(
		normalizeProtectionEditableUsers(req.ViewHiddenDepartmentIDs, 0),
		editableDepartmentIDs,
	)
	readonlyDepartmentIDs := excludeProtectionIDs(
		normalizeProtectionEditableUsers(req.ReadonlyDepartmentIDs, 0),
		editableDepartmentIDs,
		viewHiddenDepartmentIDs,
	)

	return normalizedProtectionAccess{
		ReadonlyUserIDs:         readonlyUserIDs,
		ReadonlyDepartmentIDs:   readonlyDepartmentIDs,
		EditableUserIDs:         editableUserIDs,
		EditableDepartmentIDs:   editableDepartmentIDs,
		ViewHiddenUserIDs:       viewHiddenUserIDs,
		ViewHiddenDepartmentIDs: viewHiddenDepartmentIDs,
	}
}

func excludeProtectionIDs(values []int64, excluded ...[]int64) []int64 {
	blocked := make(map[int64]struct{})
	for _, list := range excluded {
		for _, value := range list {
			blocked[value] = struct{}{}
		}
	}
	result := make([]int64, 0, len(values))
	for _, value := range values {
		if _, exists := blocked[value]; exists {
			continue
		}
		result = append(result, value)
	}
	return result
}

func protectionListAllows(userIDs []int64, departmentIDs []int64, userID int64, userDepartmentIDs map[int64]struct{}) bool {
	for _, listedUserID := range userIDs {
		if listedUserID == userID {
			return true
		}
	}
	for _, departmentID := range departmentIDs {
		if _, exists := userDepartmentIDs[departmentID]; exists {
			return true
		}
	}
	return false
}

func protectionAllowsUser(info protectionOwner, userID int64, departmentIDs map[int64]struct{}) bool {
	return protectionListAllows(info.EditableUserIDs, info.EditableDepartmentIDs, userID, departmentIDs)
}

func protectionAllowsViewHidden(info protectionOwner, userID int64, departmentIDs map[int64]struct{}) bool {
	return protectionAllowsUser(info, userID, departmentIDs) ||
		protectionListAllows(info.ViewHiddenUserIDs, info.ViewHiddenDepartmentIDs, userID, departmentIDs)
}

func int64Set(values []int64) map[int64]struct{} {
	result := make(map[int64]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
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
		ownerID := userID
		ownerName := username
		protectedAt := time.Now().Format(time.RFC3339)
		if info.OwnerID != 0 {
			ownerID = info.OwnerID
			ownerName = info.OwnerName
			protectedAt = info.ProtectedAt
			if protectedAt == "" {
				protectedAt = time.Now().Format(time.RFC3339)
			}
		}
		access := normalizeProtectionAccess(req, ownerID)
		(*mapRef)[key] = protectionOwner{
			OwnerID:                 ownerID,
			OwnerName:               ownerName,
			ReadonlyUserIDs:         access.ReadonlyUserIDs,
			ReadonlyDepartmentIDs:   access.ReadonlyDepartmentIDs,
			EditableUserIDs:         access.EditableUserIDs,
			EditableDepartmentIDs:   access.EditableDepartmentIDs,
			ViewHiddenUserIDs:       access.ViewHiddenUserIDs,
			ViewHiddenDepartmentIDs: access.ViewHiddenDepartmentIDs,
			Hidden:                  resolveProtectionHidden(req.Hidden, info.Hidden),
			ProtectedAt:             protectedAt,
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

func resolveProtectionHidden(requested *bool, current bool) bool {
	if requested == nil {
		return current
	}
	return *requested
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
			Scope:                   scope,
			Key:                     key,
			OwnerID:                 info.OwnerID,
			OwnerName:               info.OwnerName,
			ReadonlyUserIDs:         append([]int64(nil), info.ReadonlyUserIDs...),
			ReadonlyDepartmentIDs:   append([]int64(nil), info.ReadonlyDepartmentIDs...),
			EditableUserIDs:         append([]int64(nil), info.EditableUserIDs...),
			EditableDepartmentIDs:   append([]int64(nil), info.EditableDepartmentIDs...),
			ViewHiddenUserIDs:       append([]int64(nil), info.ViewHiddenUserIDs...),
			ViewHiddenDepartmentIDs: append([]int64(nil), info.ViewHiddenDepartmentIDs...),
			Hidden:                  info.Hidden,
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

func ensureProtectionOwnership(config json.RawMessage, userID int64, action string) error {
	_, protections, legacyLocks, err := parseSheetConfigProtection(config)
	if err != nil {
		return err
	}
	for _, items := range []map[string]protectionOwner{protections.Rows, protections.Columns, protections.Cells} {
		for _, info := range items {
			if info.OwnerID > 0 && info.OwnerID == userID {
				continue
			}
			return fmt.Errorf("%w: %s前请先由保护创建者解除保护或隐藏设置", ErrProtectionDenied, action)
		}
	}
	for _, locked := range legacyLocks {
		if locked {
			return fmt.Errorf("%w: %s前请先解除旧版单元格保护", ErrProtectionDenied, action)
		}
	}
	return nil
}

func (s *SheetService) ensureRowDeletionAllowed(userID int64, sheet *model.Sheet, rowIndex int) error {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}

	matrix, err := s.permService.GetPermissionMatrix(sheet.ID, userID)
	if err != nil {
		return err
	}
	columnKeys, err := parseColumnKeys(sheet.Columns)
	if err != nil {
		return err
	}
	columnSet := make(map[string]struct{}, len(columnKeys))
	for _, columnKey := range columnKeys {
		if columnKey != "" {
			columnSet[columnKey] = struct{}{}
		}
	}
	if matrix != nil {
		for _, layer := range permissionMatrixScopedLayers(matrix) {
			for columnKey := range layer.Columns {
				if columnKey != "" {
					columnSet[columnKey] = struct{}{}
				}
			}
			rowPrefix := fmt.Sprintf("%d:", rowIndex)
			for key := range layer.Cells {
				if strings.HasPrefix(key, rowPrefix) {
					columnSet[strings.TrimPrefix(key, rowPrefix)] = struct{}{}
				}
			}
		}
	}
	if len(columnSet) == 0 {
		if !permissionMatrixAllowsCell(matrix, "", rowIndex, "write") {
			return fmt.Errorf("%w: 第 %d 行包含无权删除的数据", ErrSheetPermissionDenied, rowIndex+2)
		}
	} else {
		for columnKey := range columnSet {
			if !permissionMatrixAllowsCell(matrix, columnKey, rowIndex, "write") {
				return fmt.Errorf("%w: 第 %d 行的列 %s 包含无权删除或不可见的数据", ErrSheetPermissionDenied, rowIndex+2, columnKey)
			}
		}
	}

	_, protections, legacyLocks, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return err
	}
	affected := make([]protectionOwner, 0, len(protections.Columns)+1)
	if info, exists := protections.Rows[strconv.Itoa(rowIndex)]; exists {
		affected = append(affected, info)
	}
	for _, info := range protections.Columns {
		affected = append(affected, info)
	}
	rowPrefix := fmt.Sprintf("%d:", rowIndex)
	for key, info := range protections.Cells {
		if strings.HasPrefix(key, rowPrefix) {
			affected = append(affected, info)
		}
	}
	for _, info := range affected {
		if info.OwnerID > 0 && info.OwnerID == userID {
			continue
		}
		return fmt.Errorf("%w: 第 %d 行包含其他人设置的保护或隐藏区域，不能删除", ErrProtectionDenied, rowIndex+2)
	}
	for key, locked := range legacyLocks {
		if locked && strings.HasPrefix(key, rowPrefix) {
			return fmt.Errorf("%w: 第 %d 行包含受保护的单元格，不能删除", ErrProtectionDenied, rowIndex+2)
		}
	}
	return nil
}

func (s *SheetService) EnsureRowDeletionAllowed(userID, sheetID int64, rowIndex int) error {
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
	return s.ensureRowDeletionAllowed(userID, sheet, rowIndex)
}

func (s *SheetService) ensureProtectedStructureMutationAllowed(userID int64, existing, next *model.Sheet) error {
	currentColumns, err := parseColumnKeys(existing.Columns)
	if err != nil {
		return err
	}
	nextColumns, err := parseColumnKeys(next.Columns)
	if err != nil {
		return err
	}
	columnLayoutChanged := columnLayoutRequiresStructureGate(currentColumns, nextColumns)
	currentRows, currentColumnCount := univerSheetDimensions(existing.Config)
	nextRows, nextColumnCount := univerSheetDimensions(next.Config)
	rowCountReduced := currentRows > 0 && nextRows < currentRows
	columnCountReduced := currentColumnCount > 0 && nextColumnCount < currentColumnCount
	if !columnLayoutChanged && !rowCountReduced && !columnCountReduced {
		return nil
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		matrix, err := s.permService.GetPermissionMatrix(existing.ID, userID)
		if err != nil {
			return err
		}
		if !permissionMatrixAllowsStructureMutation(matrix) {
			return fmt.Errorf("%w: 当前账号存在不可见或只读区域，不能删除、移动行列或调整表格结构", ErrSheetPermissionDenied)
		}
	}

	_, protections, legacyLocks, err := parseSheetConfigProtection(existing.Config)
	if err != nil {
		return err
	}
	if !hasAnyProtection(protections) && len(legacyLocks) == 0 {
		return nil
	}
	if rowCountReduced && (len(protections.Rows) > 0 || len(protections.Cells) > 0 || len(legacyLocks) > 0) {
		return fmt.Errorf("%w: 工作表包含行或单元格保护，请先解除对应保护再通过整表操作删除行", ErrProtectionDenied)
	}
	if columnCountReduced {
		removedColumns := removedColumnKeysFromLists(currentColumns, nextColumns)
		if len(removedColumns) == 0 && (len(protections.Columns) > 0 || len(protections.Cells) > 0 || len(legacyLocks) > 0) {
			return fmt.Errorf("%w: 无法确认被删除列的保护范围，已阻止本次结构变更", ErrProtectionDenied)
		}
	}
	if isAdmin {
		return nil
	}
	return ensureProtectionOwnership(existing.Config, userID, "调整工作表结构")
}

func permissionMatrixAllowsStructureMutation(matrix *model.PermissionMatrix) bool {
	if matrix == nil || !matrix.Sheet.CanEdit {
		return false
	}
	if matrix.DefaultPermission != "" && !permissionSatisfies(matrix.DefaultPermission, "write") {
		return false
	}
	for _, items := range permissionMatrixMaps(matrix) {
		for _, permission := range items {
			if !permissionSatisfies(permission, "write") {
				return false
			}
		}
	}
	return true
}

func columnLayoutRequiresStructureGate(current, next []string) bool {
	if len(current) == len(next) {
		equal := true
		for index := range current {
			if current[index] != next[index] {
				equal = false
				break
			}
		}
		if equal {
			return false
		}
	}
	if len(next) >= len(current) {
		prefix := true
		for index := range current {
			if current[index] != next[index] {
				prefix = false
				break
			}
		}
		if prefix {
			return false
		}
	}
	return true
}

func univerSheetDimensions(config json.RawMessage) (int, int) {
	if len(config) == 0 {
		return 0, 0
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(config, &payload); err != nil {
		return 0, 0
	}
	sheetData, _ := payload["univerSheetData"].(map[string]interface{})
	if sheetData == nil {
		return 0, 0
	}
	rowCount := numericDimension(sheetData["rowCount"])
	columnCount := numericDimension(sheetData["columnCount"])
	if cellData, ok := sheetData["cellData"].(map[string]interface{}); ok {
		for rowKey, rowValue := range cellData {
			if rowIndex, err := strconv.Atoi(rowKey); err == nil && rowIndex+1 > rowCount {
				rowCount = rowIndex + 1
			}
			if row, ok := rowValue.(map[string]interface{}); ok {
				for columnKey := range row {
					if columnIndex, err := strconv.Atoi(columnKey); err == nil && columnIndex+1 > columnCount {
						columnCount = columnIndex + 1
					}
				}
			}
		}
	}
	return rowCount, columnCount
}

func numericDimension(value interface{}) int {
	switch typed := value.(type) {
	case float64:
		return int(typed)
	case int:
		return typed
	case json.Number:
		parsed, _ := strconv.Atoi(typed.String())
		return parsed
	default:
		return 0
	}
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
	departmentIDs, err := s.permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return false, "", err
	}
	departmentSet := int64Set(departmentIDs)

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
		if check.info.OwnerID == 0 || check.info.OwnerID == userID || protectionAllowsUser(check.info, userID, departmentSet) {
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

func removedColumnKeys(currentRaw, nextRaw json.RawMessage) (map[string]struct{}, error) {
	current, err := parseColumnKeys(currentRaw)
	if err != nil {
		return nil, err
	}
	next, err := parseColumnKeys(nextRaw)
	if err != nil {
		return nil, err
	}
	return removedColumnKeysFromLists(current, next), nil
}

func removedColumnKeysFromLists(current, next []string) map[string]struct{} {
	nextSet := make(map[string]struct{}, len(next))
	for _, columnKey := range next {
		nextSet[columnKey] = struct{}{}
	}
	removed := make(map[string]struct{})
	for _, columnKey := range current {
		if _, exists := nextSet[columnKey]; !exists {
			removed[columnKey] = struct{}{}
		}
	}
	return removed
}

func removeColumnProtectionState(config json.RawMessage, removedColumns map[string]struct{}) (json.RawMessage, error) {
	if len(removedColumns) == 0 {
		return config, nil
	}
	payload, protections, legacyLocks, err := parseSheetConfigProtection(config)
	if err != nil {
		return nil, err
	}
	for columnKey := range removedColumns {
		delete(protections.Columns, columnKey)
	}
	for key := range protections.Cells {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) == 2 {
			if _, removed := removedColumns[parts[1]]; removed {
				delete(protections.Cells, key)
			}
		}
	}
	for key := range legacyLocks {
		parts := strings.SplitN(key, ":", 2)
		if len(parts) == 2 {
			if _, removed := removedColumns[parts[1]]; removed {
				delete(legacyLocks, key)
			}
		}
	}
	finalizeProtectionPayload(payload, protections, legacyLocks)
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal pruned protection config: %w", err)
	}
	return encoded, nil
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
