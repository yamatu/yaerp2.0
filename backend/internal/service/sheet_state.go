package service

import (
	"encoding/json"
	"fmt"
	"time"

	"yaerp/internal/model"
)

type sheetStateUser struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	At   string `json:"at"`
}

type sheetLifecycleState struct {
	Locked   *sheetStateUser `json:"locked,omitempty"`
	Archived *sheetStateUser `json:"archived,omitempty"`
}

type workbookLifecycleState struct {
	Locked *sheetStateUser `json:"locked,omitempty"`
	Hidden *sheetStateUser `json:"hidden,omitempty"`
}

func parseSheetLifecycleState(config json.RawMessage) (map[string]interface{}, sheetLifecycleState, error) {
	payload := make(map[string]interface{})
	if len(config) > 0 {
		if err := json.Unmarshal(config, &payload); err != nil {
			return nil, sheetLifecycleState{}, fmt.Errorf("parse sheet state config: %w", err)
		}
	}

	state := sheetLifecycleState{}
	if raw, ok := payload["sheetState"]; ok {
		buf, _ := json.Marshal(raw)
		if err := json.Unmarshal(buf, &state); err != nil {
			return nil, sheetLifecycleState{}, fmt.Errorf("parse sheet lifecycle state: %w", err)
		}
	}

	return payload, state, nil
}

func applySheetLifecycleState(sheet *model.Sheet) error {
	_, state, err := parseSheetLifecycleState(sheet.Config)
	if err != nil {
		return err
	}

	sheet.IsLocked = state.Locked != nil
	sheet.IsArchived = state.Archived != nil
	sheet.LockedByID = nil
	sheet.LockedByName = nil
	sheet.LockedAt = nil
	sheet.ArchivedByID = nil
	sheet.ArchivedByName = nil
	sheet.ArchivedAt = nil

	if state.Locked != nil {
		sheet.LockedByID = &state.Locked.ID
		sheet.LockedByName = &state.Locked.Name
		if parsed, err := time.Parse(time.RFC3339, state.Locked.At); err == nil {
			sheet.LockedAt = &parsed
		}
	}

	if state.Archived != nil {
		sheet.ArchivedByID = &state.Archived.ID
		sheet.ArchivedByName = &state.Archived.Name
		if parsed, err := time.Parse(time.RFC3339, state.Archived.At); err == nil {
			sheet.ArchivedAt = &parsed
		}
	}

	return nil
}

func applySheetLifecycleStates(sheets []model.Sheet) error {
	for i := range sheets {
		if err := applySheetLifecycleState(&sheets[i]); err != nil {
			return err
		}
	}
	return nil
}

func parseWorkbookLifecycleState(metadata json.RawMessage) (map[string]interface{}, workbookLifecycleState, error) {
	payload := make(map[string]interface{})
	if len(metadata) > 0 {
		if err := json.Unmarshal(metadata, &payload); err != nil {
			return nil, workbookLifecycleState{}, fmt.Errorf("parse workbook state metadata: %w", err)
		}
	}

	state := workbookLifecycleState{}
	if raw, ok := payload["workbookState"]; ok {
		buf, _ := json.Marshal(raw)
		if err := json.Unmarshal(buf, &state); err != nil {
			return nil, workbookLifecycleState{}, fmt.Errorf("parse workbook lifecycle state: %w", err)
		}
	}

	return payload, state, nil
}

func applyWorkbookLifecycleState(workbook *model.Workbook) error {
	_, state, err := parseWorkbookLifecycleState(workbook.Metadata)
	if err != nil {
		return err
	}

	workbook.IsLocked = state.Locked != nil
	workbook.IsHidden = state.Hidden != nil
	workbook.LockedByID = nil
	workbook.LockedByName = nil
	workbook.LockedAt = nil
	workbook.HiddenByID = nil
	workbook.HiddenByName = nil
	workbook.HiddenAt = nil

	if state.Locked != nil {
		workbook.LockedByID = &state.Locked.ID
		workbook.LockedByName = &state.Locked.Name
		if parsed, err := time.Parse(time.RFC3339, state.Locked.At); err == nil {
			workbook.LockedAt = &parsed
		}
	}

	if state.Hidden != nil {
		workbook.HiddenByID = &state.Hidden.ID
		workbook.HiddenByName = &state.Hidden.Name
		if parsed, err := time.Parse(time.RFC3339, state.Hidden.At); err == nil {
			workbook.HiddenAt = &parsed
		}
	}

	return nil
}

func applyWorkbookLifecycleStates(workbooks []model.Workbook) error {
	for i := range workbooks {
		if err := applyWorkbookLifecycleState(&workbooks[i]); err != nil {
			return err
		}
	}
	return nil
}

func workbookIsAssigned(workbook *model.Workbook) bool {
	if workbook == nil || len(workbook.Metadata) == 0 {
		return false
	}

	var metadata map[string]interface{}
	if err := json.Unmarshal(workbook.Metadata, &metadata); err != nil {
		return false
	}

	_, hasSource := metadata["source_workbook_id"]
	_, hasAssignedBy := metadata["assigned_by"]
	return hasSource || hasAssignedBy
}

func (s *SheetService) ensureWorkbookVisible(workbook *model.Workbook, userID int64) error {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	if workbook.IsHidden {
		return fmt.Errorf("%w: 当前工作簿已被管理员设为不可见", ErrWorkbookAccessDenied)
	}
	return nil
}

func applyWorkbookStateToPermissionMatrix(workbook *model.Workbook, matrix *model.PermissionMatrix) {
	if workbook == nil || matrix == nil {
		return
	}
	if workbook.IsHidden {
		matrix.Sheet.CanView = false
		matrix.Sheet.CanEdit = false
		matrix.Sheet.CanDelete = false
		matrix.Sheet.CanExport = false
		return
	}
	if workbook.IsLocked {
		matrix.Sheet.CanEdit = false
		matrix.Sheet.CanDelete = false
	}
}

func (s *SheetService) ensureSheetModificationAllowed(sheet *model.Sheet, userID int64) error {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if isAdmin {
		return nil
	}
	if sheet.IsArchived {
		return fmt.Errorf("%w: 当前工作表已归档，仅管理员可以修改", ErrSheetArchived)
	}
	if sheet.IsLocked {
		return fmt.Errorf("%w: 当前工作表已锁定，仅管理员可以修改", ErrSheetLocked)
	}
	return nil
}
