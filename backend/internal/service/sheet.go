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
var ErrProtectionDenied = errors.New("protection denied")

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

func (s *SheetService) CreateWorkbook(workbook *model.Workbook) error {
	return s.sheetRepo.CreateWorkbook(workbook)
}

func (s *SheetService) GetWorkbook(id int64, userID int64) (*model.Workbook, error) {
	wb, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	sheets, err := s.sheetRepo.GetSheetsByWorkbook(id)
	if err != nil {
		return nil, err
	}

	canManageWorkbook, err := s.canManageWorkbook(userID, wb)
	if err != nil {
		return nil, err
	}
	if canManageWorkbook {
		wb.Sheets = sheets
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
		return s.sheetRepo.ListWorkbooks(nil, page, size)
	}

	allWorkbooks, _, err := s.sheetRepo.ListWorkbooks(nil, 1, 10000)
	if err != nil {
		return nil, 0, err
	}

	accessible := make([]model.Workbook, 0, len(allWorkbooks))
	for _, workbook := range allWorkbooks {
		if workbook.OwnerID == userID {
			accessible = append(accessible, workbook)
			continue
		}

		sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
		if err != nil {
			return nil, 0, err
		}

		for _, sheet := range sheets {
			matrix, err := s.permService.GetPermissionMatrix(sheet.ID, userID)
			if err != nil {
				return nil, 0, err
			}
			if matrix.Sheet.CanView {
				accessible = append(accessible, workbook)
				break
			}
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

func (s *SheetService) UpdateWorkbook(workbook *model.Workbook) error {
	return s.sheetRepo.UpdateWorkbook(workbook)
}

func (s *SheetService) DeleteWorkbook(id int64) error {
	return s.sheetRepo.DeleteWorkbook(id)
}

// Sheet operations

func (s *SheetService) CreateSheetForUser(userID int64, sheet *model.Sheet) error {
	wb, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return err
	}

	canManageWorkbook, err := s.canManageWorkbook(userID, wb)
	if err != nil {
		return err
	}
	if !canManageWorkbook {
		return ErrWorkbookAccessDenied
	}

	nextSortOrder, err := s.sheetRepo.GetNextSheetSortOrder(sheet.WorkbookID)
	if err != nil {
		return err
	}
	sheet.SortOrder = nextSortOrder

	return s.sheetRepo.CreateSheet(sheet)
}

func (s *SheetService) UpdateSheetForUser(userID int64, existing, sheet *model.Sheet) error {
	if err := s.ensureProtectedCellsUnchanged(userID, existing, sheet); err != nil {
		return err
	}
	return s.sheetRepo.UpdateSheet(sheet)
}

func (s *SheetService) GetSheet(id int64) (*model.Sheet, error) {
	return s.sheetRepo.GetSheet(id)
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

	for _, change := range changes {
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

func (s *SheetService) InsertRow(sheetID int64, rowIndex int) error {
	return s.sheetRepo.InsertRow(sheetID, rowIndex)
}

func (s *SheetService) DeleteRow(sheetID int64, rowIndex int) error {
	return s.sheetRepo.DeleteRow(sheetID, rowIndex)
}

func (s *SheetService) GetProtectionSnapshot(sheetID int64) (*model.ProtectionSnapshot, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
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

	payload, protections, legacyLocks, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, nil, err
	}

	mapRef, key, info, err := resolveProtectionTarget(req.Scope, req.RowIndex, req.ColumnKey, protections)
	if err != nil {
		return nil, nil, err
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, nil, err
	}

	if req.Action == "lock" {
		if info.OwnerID != 0 && info.OwnerID != userID && !isAdmin {
			return nil, nil, fmt.Errorf("%w: 此保护已由 %s 添加", ErrProtectionDenied, info.OwnerName)
		}
		(*mapRef)[key] = protectionOwner{
			OwnerID:     userID,
			OwnerName:   username,
			ProtectedAt: time.Now().Format(time.RFC3339),
		}
	} else {
		if info.OwnerID != 0 && info.OwnerID != userID && !isAdmin {
			return nil, nil, fmt.Errorf("%w: 仅管理员或保护创建者可以解除保护", ErrProtectionDenied)
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
	}

	if !hasAnyProtection(protections) {
		delete(payload, "protections")
	} else {
		payload["protections"] = protections
	}

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

	return updatedSheet, snapshot, nil
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

	worksheetRowIndex := rowIndex + 1
	if rowIndex < 0 {
		worksheetRowIndex = rowIndex
	}

	rowCandidates := []int{worksheetRowIndex}
	if worksheetRowIndex > 0 {
		rowCandidates = append(rowCandidates, worksheetRowIndex-1)
	}

	for _, candidate := range rowCandidates {
		checks := []struct {
			scope string
			info  protectionOwner
		}{
			{scope: "cell", info: protections.Cells[fmt.Sprintf("%d:%s", candidate, colKey)]},
			{scope: "row", info: protections.Rows[fmt.Sprintf("%d", candidate)]},
			{scope: "column", info: protections.Columns[colKey]},
		}

		for _, check := range checks {
			if check.info.OwnerID == 0 || check.info.OwnerID == userID {
				continue
			}
			return true, buildProtectionMessage(check.scope, check.info.OwnerName, worksheetRowIndex, colKey), nil
		}
	}

	legacyKey := fmt.Sprintf("%d:%s", worksheetRowIndex, colKey)
	if legacyLocks[legacyKey] {
		return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, worksheetRowIndex+1), nil
	}
	if worksheetRowIndex > 0 {
		legacyKey = fmt.Sprintf("%d:%s", worksheetRowIndex-1, colKey)
		if legacyLocks[legacyKey] {
			return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, worksheetRowIndex+1), nil
		}
	}

	return false, "", nil
}

func (s *SheetService) canManageWorkbook(userID int64, workbook *model.Workbook) (bool, error) {
	if workbook.OwnerID == userID {
		return true, nil
	}

	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return false, fmt.Errorf("check admin role: %w", err)
	}

	return isAdmin, nil
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
		return fmt.Sprintf("第 %d 行已由 %s 添加保护", rowIndex+1, ownerName)
	case "column":
		return fmt.Sprintf("列 %s 已由 %s 添加保护", colKey, ownerName)
	default:
		return fmt.Sprintf("单元格 %s%d 已由 %s 添加保护", colKey, rowIndex+1, ownerName)
	}
}

func (s *SheetService) ensureProtectedCellsUnchanged(userID int64, existing, next *model.Sheet) error {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
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
		if err != nil || worksheetRow <= 0 {
			continue
		}
		columnIndex, err := strconv.Atoi(parts[1])
		if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) {
			continue
		}

		protected, reason, err := s.checkProtectionByWorksheetRow(existing.Config, worksheetRow, columnKeys[columnIndex], userID)
		if err != nil {
			return err
		}
		if protected {
			return fmt.Errorf("%w: %s", ErrProtectionDenied, reason)
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

	rowCandidates := []int{worksheetRowIndex}
	if worksheetRowIndex > 0 {
		rowCandidates = append(rowCandidates, worksheetRowIndex-1)
	}

	for _, candidate := range rowCandidates {
		checks := []struct {
			scope string
			info  protectionOwner
		}{
			{scope: "cell", info: protections.Cells[fmt.Sprintf("%d:%s", candidate, colKey)]},
			{scope: "row", info: protections.Rows[fmt.Sprintf("%d", candidate)]},
			{scope: "column", info: protections.Columns[colKey]},
		}

		for _, check := range checks {
			if check.info.OwnerID == 0 || check.info.OwnerID == userID {
				continue
			}
			return true, buildProtectionMessage(check.scope, check.info.OwnerName, worksheetRowIndex, colKey), nil
		}
	}

	legacyKey := fmt.Sprintf("%d:%s", worksheetRowIndex, colKey)
	if legacyLocks[legacyKey] {
		return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, worksheetRowIndex+1), nil
	}
	if worksheetRowIndex > 0 {
		legacyKey = fmt.Sprintf("%d:%s", worksheetRowIndex-1, colKey)
		if legacyLocks[legacyKey] {
			return true, fmt.Sprintf("单元格 %s%d 已被保护", colKey, worksheetRowIndex+1), nil
		}
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
