package service

import (
	"bytes"
	"encoding/json"
	"fmt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

// getSearchWorkbook checks the same workbook/sheet visibility as the editor,
// without fetching or masking the large cell/style snapshots. Every content
// result is subsequently filtered with the request's resolved permission matrix.
func (s *AIService) getSearchWorkbook(userID, workbookID int64, scope *AccessScope) (*model.Workbook, error) {
	workbook, err := scope.Workbook(workbookID)
	if err != nil {
		return nil, err
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return nil, err
	}
	if err := s.sheetService.ensureWorkbookVisibleScoped(workbook, userID, scope); err != nil {
		return nil, err
	}
	sheets, err := s.sheetRepo.GetSearchSheets(workbookID)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleStates(sheets); err != nil {
		return nil, err
	}
	if scope.cache.workbookSheets == nil {
		scope.cache.workbookSheets = make(map[int64][]model.Sheet)
	}
	scope.cache.workbookSheets[workbookID] = sheets
	allowed, err := scope.CanViewWorkbook(workbook, userID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrWorkbookAccessDenied
	}
	visible := make([]model.Sheet, 0, len(sheets))
	for _, sheet := range sheets {
		if sheet.IsHidden {
			continue
		}
		matrix, err := scope.PermissionMatrix(sheet.ID, userID)
		if err != nil {
			return nil, err
		}
		if !matrix.Sheet.CanView {
			continue
		}
		sheet.AccessLevel = "read"
		if matrix.Sheet.CanEdit {
			sheet.AccessLevel = "write"
		}
		visible = append(visible, sheet)
	}
	if len(visible) == 0 && len(sheets) > 0 {
		return nil, ErrWorkbookAccessDenied
	}
	copy := *workbook
	copy.Sheets = visible
	copy.CanManage, err = scope.CanManageWorkbook(workbook, userID)
	return &copy, err
}

func marshalAgentWorkbookContext(workbook *model.Workbook, sheetIDs []int64) (string, error) {
	selected := make(map[int64]bool, len(sheetIDs))
	for _, id := range sheetIDs {
		selected[id] = true
	}
	sheets := make([]map[string]any, 0, len(workbook.Sheets))
	for _, sheet := range workbook.Sheets {
		if len(selected) > 0 && !selected[sheet.ID] {
			continue
		}
		columns, err := parseSheetColumns(sheet.Columns)
		if err != nil {
			return "", err
		}
		sheets = append(sheets, map[string]any{
			"sheet_id": sheet.ID, "sheet_name": sheet.Name, "columns": columns,
			"access_level": sheet.AccessLevel,
		})
	}
	if len(sheets) == 0 {
		return "", fmt.Errorf("选中的工作簿没有可读取的工作表")
	}
	payload, err := json.Marshal(map[string]any{
		"workbook": map[string]any{"id": workbook.ID, "name": workbook.Name},
		"sheets":   sheets, "content_loaded": false,
	})
	return string(payload), err
}

const sheetSearchCandidatePageSize = 80
const sheetSearchCandidateBudget = 2000

type visibleSearchPage struct {
	Rows      []aiPreviewRow
	HasMore   bool // search was stopped, not an exact count of visible hits
	NextRow   int  // based only on a visible result, never a hidden cell's position
	BudgetHit bool
}

// scanVisibleSearchRows is shared by the cross-workbook and single-sheet tools.
// The callbacks make pagination/hidden-only pages testable without a database.
// A page of redacted candidates must NOT end the search: continue by row cursor.
func scanVisibleSearchRows(
	startRow, limit int,
	fetch func(startRow, size int) ([]repo.SheetContentRow, error),
	accept func(row repo.SheetContentRow) (*aiPreviewRow, error),
) (visibleSearchPage, error) {
	result := visibleSearchPage{Rows: make([]aiPreviewRow, 0, limit)}
	cursor, examined := startRow, 0
	for examined < sheetSearchCandidateBudget {
		size := minInt(sheetSearchCandidatePageSize, sheetSearchCandidateBudget-examined)
		page, err := fetch(cursor, size)
		if err != nil {
			return result, err
		}
		if len(page) == 0 {
			return result, nil
		}
		for _, candidate := range page {
			examined++
			row, err := accept(candidate)
			if err != nil {
				return result, err
			}
			if row == nil {
				continue
			}
			if len(result.Rows) == limit {
				result.HasMore = true
				return result, nil
			}
			result.Rows = append(result.Rows, *row)
			result.NextRow = row.Row + 1
		}
		nextCursor := page[len(page)-1].Row + 1
		if nextCursor <= cursor {
			return result, fmt.Errorf("sheet search cursor did not advance")
		}
		cursor = nextCursor
		if len(page) < size {
			return result, nil
		}
	}
	result.BudgetHit, result.HasMore = true, true
	return result, nil
}

func (s *AIService) searchVisibleSheetRows(userID int64, sheet *model.Sheet, columns []sheetColumnPayload,
	keywords []string, mode string, columnFilter map[string]struct{}, startRow, limit int, scope *AccessScope,
) (visibleSearchPage, error) {
	filter, err := s.buildSheetCellFilterScoped(userID, sheet, scope)
	if err != nil {
		return visibleSearchPage{}, err
	}
	orderedKeys := make([]string, len(columns))
	for i, column := range columns {
		orderedKeys[i] = column.Key
	}
	keys := make([]string, 0, len(columnFilter))
	for key := range columnFilter {
		keys = append(keys, key)
	}
	return scanVisibleSearchRows(startRow, limit, func(cursor, size int) ([]repo.SheetContentRow, error) {
		return s.sheetRepo.SearchSheetContent(repo.SheetContentQuery{
			SheetID: sheet.ID, OrderedColumnKeys: orderedKeys, ColumnKeys: keys,
			Keywords: keywords, MatchAll: normalizeSearchMode(mode) == "all", StartRow: cursor, Limit: size,
		})
	}, func(candidate repo.SheetContentRow) (*aiPreviewRow, error) {
		var data map[string]interface{}
		decoder := json.NewDecoder(bytes.NewReader(candidate.Data))
		decoder.UseNumber()
		if err := decoder.Decode(&data); err != nil {
			return nil, err
		}
		visible, err := s.visibleRowData(userID, sheet.ID, candidate.Row, data, filter)
		if err != nil {
			return nil, err
		}
		// Recheck after redaction: SQL candidates must never expose hidden hits.
		if !rowDataMayContainKeywords(restrictDataToColumns(visible, columnFilter), keywords, mode) {
			return nil, nil
		}
		return &aiPreviewRow{Row: candidate.Row, SourceRow: candidate.SourceRow,
			DisplayRow: candidate.Row + 2, Data: visible}, nil
	})
}
