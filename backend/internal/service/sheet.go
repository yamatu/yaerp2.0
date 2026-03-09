package service

import (
	"encoding/json"
	"fmt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type SheetService struct {
	sheetRepo *repo.SheetRepo
}

func NewSheetService(sheetRepo *repo.SheetRepo) *SheetService {
	return &SheetService{sheetRepo: sheetRepo}
}

// Workbook operations

func (s *SheetService) CreateWorkbook(workbook *model.Workbook) error {
	return s.sheetRepo.CreateWorkbook(workbook)
}

func (s *SheetService) GetWorkbook(id int64) (*model.Workbook, error) {
	wb, err := s.sheetRepo.GetWorkbook(id)
	if err != nil {
		return nil, err
	}
	sheets, err := s.sheetRepo.GetSheetsByWorkbook(id)
	if err != nil {
		return nil, err
	}
	wb.Sheets = sheets
	return wb, nil
}

func (s *SheetService) ListWorkbooks(userID int64) ([]model.Workbook, int64, error) {
	return s.sheetRepo.ListWorkbooks(userID, 1, 100)
}

func (s *SheetService) UpdateWorkbook(workbook *model.Workbook) error {
	return s.sheetRepo.UpdateWorkbook(workbook)
}

func (s *SheetService) DeleteWorkbook(id int64) error {
	return s.sheetRepo.DeleteWorkbook(id)
}

// Sheet operations

func (s *SheetService) CreateSheet(sheet *model.Sheet) error {
	return s.sheetRepo.CreateSheet(sheet)
}

func (s *SheetService) UpdateSheet(sheet *model.Sheet) error {
	return s.sheetRepo.UpdateSheet(sheet)
}

func (s *SheetService) GetSheet(id int64) (*model.Sheet, error) {
	return s.sheetRepo.GetSheet(id)
}

func (s *SheetService) DeleteSheet(id int64) error {
	return s.sheetRepo.DeleteSheet(id)
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

func (s *SheetService) IsCellLocked(sheetID int64, rowIndex int, colKey string) (bool, error) {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return false, err
	}

	if len(sheet.Config) == 0 {
		return false, nil
	}

	var config struct {
		LockedCells map[string]bool `json:"lockedCells"`
	}
	if err := json.Unmarshal(sheet.Config, &config); err != nil {
		return false, nil
	}

	if len(config.LockedCells) == 0 {
		return false, nil
	}

	return config.LockedCells[fmt.Sprintf("%d:%s", rowIndex, colKey)], nil
}
