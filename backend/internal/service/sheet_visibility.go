package service

import (
	"encoding/json"
	"fmt"
	"strconv"

	"yaerp/internal/model"
)

const hiddenCellPlaceholder = "••••"

func protectionHidesCell(protections protectionMaps, rowIndex int, columnKey string, userID int64, isAdmin bool) bool {
	if isAdmin {
		return false
	}
	checks := []protectionOwner{
		protections.Cells[fmt.Sprintf("%d:%s", rowIndex, columnKey)],
		protections.Rows[strconv.Itoa(rowIndex)],
		protections.Columns[columnKey],
	}
	for _, info := range checks {
		if !info.Hidden || info.OwnerID == 0 || info.OwnerID == userID || protectionAllowsUser(info, userID) {
			continue
		}
		return true
	}
	return false
}

func protectionCoversHiddenCell(protections protectionMaps, rowIndex int, columnKey string) bool {
	return protections.Cells[fmt.Sprintf("%d:%s", rowIndex, columnKey)].Hidden ||
		protections.Rows[strconv.Itoa(rowIndex)].Hidden ||
		protections.Columns[columnKey].Hidden
}

func (s *SheetService) GetSheetForUser(sheetID, userID int64) (*model.Sheet, error) {
	sheet, err := s.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	return s.maskSheetForUser(sheet, userID)
}

func (s *SheetService) GetSheetDataForUser(sheetID, userID int64) ([]model.Row, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	rows, err := s.sheetRepo.GetRows(sheetID)
	if err != nil {
		return nil, err
	}
	return s.maskRowsForUser(sheet, rows, userID)
}

func (s *SheetService) maskSheetForUser(sheet *model.Sheet, userID int64) (*model.Sheet, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
		return sheet, nil
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, err
	}
	if !hasHiddenProtection(protections) {
		return sheet, nil
	}
	columnKeys, err := parseColumnKeys(sheet.Columns)
	if err != nil {
		return nil, err
	}
	maskedConfig, err := maskUniverSheetConfig(sheet.Config, columnKeys, protections, userID, false)
	if err != nil {
		return nil, err
	}
	copySheet := *sheet
	copySheet.Config = maskedConfig
	return &copySheet, nil
}

func (s *SheetService) maskRowsForUser(sheet *model.Sheet, rows []model.Row, userID int64) ([]model.Row, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
		return rows, nil
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, err
	}
	if !hasHiddenProtection(protections) {
		return rows, nil
	}
	masked := make([]model.Row, len(rows))
	copy(masked, rows)
	for index := range masked {
		data := map[string]json.RawMessage{}
		if len(masked[index].Data) > 0 {
			if err := json.Unmarshal(masked[index].Data, &data); err != nil {
				return nil, fmt.Errorf("parse sheet row %d: %w", masked[index].RowIndex, err)
			}
		}
		changed := false
		for columnKey := range data {
			if protectionHidesCell(protections, masked[index].RowIndex, columnKey, userID, false) {
				data[columnKey] = json.RawMessage(strconv.Quote(hiddenCellPlaceholder))
				changed = true
			}
		}
		if changed {
			encoded, err := json.Marshal(data)
			if err != nil {
				return nil, err
			}
			masked[index].Data = encoded
		}
	}
	return masked, nil
}

func maskUniverSheetConfig(config json.RawMessage, columnKeys []string, protections protectionMaps, userID int64, isAdmin bool) (json.RawMessage, error) {
	if isAdmin || !hasHiddenProtection(protections) || len(config) == 0 {
		return config, nil
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, err
	}
	sheetData, ok := payload["univerSheetData"].(map[string]interface{})
	if !ok {
		return config, nil
	}
	cellData, ok := sheetData["cellData"].(map[string]interface{})
	if !ok {
		return config, nil
	}
	for worksheetRowKey, rowValue := range cellData {
		worksheetRow, err := strconv.Atoi(worksheetRowKey)
		if err != nil || worksheetRow <= 0 {
			continue
		}
		rowCells, ok := rowValue.(map[string]interface{})
		if !ok {
			continue
		}
		dataRowIndex := worksheetRow - 1
		for columnIndexKey, cellValue := range rowCells {
			columnIndex, err := strconv.Atoi(columnIndexKey)
			if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) {
				continue
			}
			if !protectionHidesCell(protections, dataRowIndex, columnKeys[columnIndex], userID, false) {
				continue
			}
			maskedCell := map[string]interface{}{"v": hiddenCellPlaceholder, "t": 1}
			if original, ok := cellValue.(map[string]interface{}); ok {
				if style, exists := original["s"]; exists {
					maskedCell["s"] = style
				}
			}
			rowCells[columnIndexKey] = maskedCell
		}
	}
	return json.Marshal(payload)
}

func (s *SheetService) restoreHiddenCellsForUser(userID int64, existingConfig, nextConfig, columns json.RawMessage) (json.RawMessage, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin || len(nextConfig) == 0 {
		return nextConfig, nil
	}
	_, protections, _, err := parseSheetConfigProtection(existingConfig)
	if err != nil {
		return nil, err
	}
	if !hasHiddenProtection(protections) {
		return nextConfig, nil
	}
	columnKeys, err := parseColumnKeys(columns)
	if err != nil {
		return nil, err
	}
	var existingPayload map[string]interface{}
	var nextPayload map[string]interface{}
	if err := json.Unmarshal(existingConfig, &existingPayload); err != nil {
		return nil, err
	}
	if err := json.Unmarshal(nextConfig, &nextPayload); err != nil {
		return nil, err
	}
	existingCells := nestedCellData(existingPayload)
	nextCells := nestedCellData(nextPayload)
	if nextCells == nil {
		return nextConfig, nil
	}
	for worksheetRowKey, existingRowValue := range existingCells {
		worksheetRow, err := strconv.Atoi(worksheetRowKey)
		if err != nil || worksheetRow <= 0 {
			continue
		}
		existingRow, ok := existingRowValue.(map[string]interface{})
		if !ok {
			continue
		}
		nextRow, _ := nextCells[worksheetRowKey].(map[string]interface{})
		if nextRow == nil {
			nextRow = map[string]interface{}{}
			nextCells[worksheetRowKey] = nextRow
		}
		dataRowIndex := worksheetRow - 1
		for columnIndexKey, original := range existingRow {
			columnIndex, err := strconv.Atoi(columnIndexKey)
			if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) || !protectionHidesCell(protections, dataRowIndex, columnKeys[columnIndex], userID, false) {
				continue
			}
			nextRow[columnIndexKey] = original
		}
	}
	for worksheetRowKey, nextRowValue := range nextCells {
		worksheetRow, err := strconv.Atoi(worksheetRowKey)
		if err != nil || worksheetRow <= 0 {
			continue
		}
		nextRow, ok := nextRowValue.(map[string]interface{})
		if !ok {
			continue
		}
		dataRowIndex := worksheetRow - 1
		for columnIndexKey := range nextRow {
			columnIndex, err := strconv.Atoi(columnIndexKey)
			if err != nil || columnIndex < 0 || columnIndex >= len(columnKeys) || !protectionHidesCell(protections, dataRowIndex, columnKeys[columnIndex], userID, false) {
				continue
			}
			if existingRow, ok := existingCells[worksheetRowKey].(map[string]interface{}); ok {
				if original, exists := existingRow[columnIndexKey]; exists {
					nextRow[columnIndexKey] = original
					continue
				}
			}
			delete(nextRow, columnIndexKey)
		}
	}
	return json.Marshal(nextPayload)
}

func nestedCellData(payload map[string]interface{}) map[string]interface{} {
	sheetData, _ := payload["univerSheetData"].(map[string]interface{})
	cellData, _ := sheetData["cellData"].(map[string]interface{})
	return cellData
}

func hasHiddenProtection(protections protectionMaps) bool {
	for _, items := range []map[string]protectionOwner{protections.Rows, protections.Columns, protections.Cells} {
		for _, info := range items {
			if info.Hidden {
				return true
			}
		}
	}
	return false
}

func (s *SheetService) CellChangesTouchHiddenProtection(sheetID int64, changes []model.CellUpdate) (bool, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return false, err
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return false, err
	}
	for _, change := range changes {
		if protectionCoversHiddenCell(protections, change.Row, change.Col) {
			return true, nil
		}
	}
	return false, nil
}

func (s *SheetService) CellHasHiddenProtection(sheetID int64, rowIndex int, columnKey string) (bool, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return false, err
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return false, err
	}
	return protectionCoversHiddenCell(protections, rowIndex, columnKey), nil
}
