package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/xuri/excelize/v2"

	"yaerp/internal/model"
)

// A "hide formula" protection lets a user see a formula's result but not the
// formula itself. The formula never reaches such a user: the server strips it
// from every payload and, because that user's editor can no longer compute it,
// recalculates the result whenever the user saves (see
// recomputeHiddenFormulaResults).

// readSheetProtections decodes only the protection fields of a sheet config.
// Unlike parseSheetConfigProtection it does not materialise the worksheet
// snapshot, which matters for sheets with thousands of rows.
func readSheetProtections(config json.RawMessage) (protectionMaps, map[string]bool, error) {
	protections := protectionMaps{
		Rows:    map[string]protectionOwner{},
		Columns: map[string]protectionOwner{},
		Cells:   map[string]protectionOwner{},
	}
	legacyLocks := map[string]bool{}
	if len(config) == 0 {
		return protections, legacyLocks, nil
	}
	var meta struct {
		Protections json.RawMessage `json:"protections"`
		LockedCells json.RawMessage `json:"lockedCells"`
	}
	if err := json.Unmarshal(config, &meta); err != nil {
		return protections, legacyLocks, fmt.Errorf("parse sheet config: %w", err)
	}
	if hasRawJSONContent(meta.Protections) {
		_ = json.Unmarshal(meta.Protections, &protections)
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
	if hasRawJSONContent(meta.LockedCells) {
		_ = json.Unmarshal(meta.LockedCells, &legacyLocks)
	}
	return protections, legacyLocks, nil
}

func protectionInfoHidesFormula(info protectionOwner, userID int64, departmentIDs map[int64]struct{}) bool {
	return info.HideFormula && info.OwnerID != 0 && info.OwnerID != userID && !protectionAllowsViewHidden(info, userID, departmentIDs)
}

func protectionHidesFormula(protections protectionMaps, rowIndex int, columnKey string, userID int64, isAdmin bool, departmentIDs map[int64]struct{}) bool {
	if isAdmin {
		return false
	}
	return protectionInfoHidesFormula(protections.Cells[fmt.Sprintf("%d:%s", rowIndex, columnKey)], userID, departmentIDs) ||
		protectionInfoHidesFormula(protections.Rows[strconv.Itoa(rowIndex)], userID, departmentIDs) ||
		protectionInfoHidesFormula(protections.Columns[columnKey], userID, departmentIDs)
}

func hasHiddenFormulaProtection(protections protectionMaps) bool {
	for _, items := range []map[string]protectionOwner{protections.Rows, protections.Columns, protections.Cells} {
		for _, info := range items {
			if info.HideFormula {
				return true
			}
		}
	}
	return false
}

// hidesFormulaFromUser reports whether any formula on the sheet is hidden from
// the user, so the cheap paths can skip the cell scan entirely.
func hidesFormulaFromUser(protections protectionMaps, userID int64, departmentIDs map[int64]struct{}) bool {
	for _, items := range []map[string]protectionOwner{protections.Rows, protections.Columns, protections.Cells} {
		for _, info := range items {
			if protectionInfoHidesFormula(info, userID, departmentIDs) {
				return true
			}
		}
	}
	return false
}

func cellFormulaText(cell map[string]interface{}) string {
	if formula, ok := cell["f"].(string); ok && strings.HasPrefix(formula, "=") {
		return formula
	}
	return ""
}

// expandSharedFormulaMembers resolves `si`-only members into explicit formulas
// so that stripping a group owner does not break the members a user may see.
func expandSharedFormulaMembers(cellData map[string]interface{}) {
	type owner struct {
		row, column int
		formula     string
	}
	owners := map[string]owner{}
	hasMembers := false
	for rowKey, rowValue := range cellData {
		row, err := strconv.Atoi(rowKey)
		rowCells, ok := rowValue.(map[string]interface{})
		if err != nil || !ok {
			continue
		}
		for columnKey, value := range rowCells {
			column, err := strconv.Atoi(columnKey)
			cell, ok := value.(map[string]interface{})
			if err != nil || !ok {
				continue
			}
			shared, _ := cell["si"].(string)
			if shared == "" {
				continue
			}
			formula := cellFormulaText(cell)
			if formula == "" {
				hasMembers = true
				continue
			}
			current, exists := owners[shared]
			if !exists || row < current.row || (row == current.row && column < current.column) {
				owners[shared] = owner{row: row, column: column, formula: formula}
			}
		}
	}
	if !hasMembers {
		return
	}
	for rowKey, rowValue := range cellData {
		row, err := strconv.Atoi(rowKey)
		rowCells, ok := rowValue.(map[string]interface{})
		if err != nil || !ok {
			continue
		}
		for columnKey, value := range rowCells {
			column, err := strconv.Atoi(columnKey)
			cell, ok := value.(map[string]interface{})
			if err != nil || !ok {
				continue
			}
			shared, _ := cell["si"].(string)
			if shared == "" || cellFormulaText(cell) != "" {
				continue
			}
			if source, exists := owners[shared]; exists {
				cell["f"] = moveFormulaRelativeRefs(source.formula, column-source.column, row-source.row)
				delete(cell, "si")
			}
		}
	}
}

func stripCellFormula(cell map[string]interface{}) {
	delete(cell, "f")
	delete(cell, "si")
	if _, ok := cell["v"]; !ok {
		cell["v"] = ""
	}
}

// realtimeCellFilter shares the sheet lookups of one broadcast between all of
// its recipients, instead of loading and parsing the sheet once per user.
type realtimeCellFilter struct {
	service *SheetService
	sheetID int64
	changes []model.CellUpdate

	loaded       bool
	loadErr      error
	protections  protectionMaps
	storedValues map[string]json.RawMessage // "row:col" -> stored result
}

// RealtimeCellFilter returns a function producing the changes a given user may
// receive. Use one filter per broadcast.
func (s *SheetService) RealtimeCellFilter(sheetID int64, changes []model.CellUpdate) func(userID int64) ([]model.CellUpdate, error) {
	filter := &realtimeCellFilter{service: s, sheetID: sheetID, changes: changes}
	return filter.forUser
}

func (f *realtimeCellFilter) load() error {
	if f.loaded {
		return f.loadErr
	}
	f.loaded = true
	sheet, err := f.service.sheetRepo.GetSheet(f.sheetID)
	if err != nil {
		f.loadErr = err
		return err
	}
	if f.protections, _, err = readSheetProtections(sheet.Config); err != nil {
		f.loadErr = err
		return err
	}
	if !hasHiddenFormulaProtection(f.protections) {
		return nil
	}
	columnKeys, err := parseColumnKeys(sheet.Columns)
	if err != nil {
		f.loadErr = err
		return err
	}
	columnIndexes := make(map[string]int, len(columnKeys))
	for index, key := range columnKeys {
		columnIndexes[key] = index
	}
	cells, err := decodeRawCellData(sheet.Config)
	if err != nil {
		f.loadErr = err
		return err
	}
	f.storedValues = make(map[string]json.RawMessage, len(f.changes))
	for _, change := range f.changes {
		key := fmt.Sprintf("%d:%s", change.Row, change.Col)
		column, ok := columnIndexes[change.Col]
		if !ok {
			continue
		}
		raw := cells[strconv.Itoa(change.Row+1)][strconv.Itoa(column)]
		fields, ok := decodeCellValueFields(raw)
		if !ok || len(fields.V) == 0 || bytes.Equal(fields.V, []byte("null")) {
			f.storedValues[key] = json.RawMessage(`""`)
			continue
		}
		f.storedValues[key] = fields.V
	}
	return nil
}

func (f *realtimeCellFilter) forUser(userID int64) ([]model.CellUpdate, error) {
	if len(f.changes) == 0 {
		return nil, nil
	}
	if err := f.load(); err != nil {
		return nil, err
	}
	s := f.service
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
		return filterRealtimeCellChanges(f.sheetID, userID, f.changes, true, protectionMaps{}, nil, nil), nil
	}
	matrix, err := s.permService.GetPermissionMatrix(f.sheetID, userID)
	if err != nil {
		return nil, err
	}
	if matrix == nil || !matrix.Sheet.CanView {
		return nil, nil
	}
	departmentIDs, err := s.permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, err
	}
	departmentSet := int64Set(departmentIDs)
	filtered := filterRealtimeCellChanges(f.sheetID, userID, f.changes, false, f.protections, matrix, departmentSet)
	if f.storedValues == nil || !hidesFormulaFromUser(f.protections, userID, departmentSet) {
		return filtered, nil
	}
	for index := range filtered {
		change := &filtered[index]
		if isHiddenPlaceholderValue(change.Value) || !protectionHidesFormula(f.protections, change.Row, change.Col, userID, false, departmentSet) {
			continue
		}
		if stored, ok := f.storedValues[fmt.Sprintf("%d:%s", change.Row, change.Col)]; ok {
			change.Value = stored
		} else {
			change.Value = json.RawMessage(`""`)
		}
	}
	return filtered, nil
}

func isHiddenPlaceholderValue(value json.RawMessage) bool {
	text, ok := rawString(value)
	return ok && text == hiddenCellPlaceholder
}

// Server side recalculation ------------------------------------------------

var formulaSheetReferencePattern = regexp.MustCompile(`'((?:[^']|'')+)'!|([A-Za-z_\p{Han}][\w.\p{Han}]*)!`)

func referencedFormulaSheets(formula string) []string {
	matches := formulaSheetReferencePattern.FindAllStringSubmatch(formula, -1)
	names := make([]string, 0, len(matches))
	for _, match := range matches {
		name := match[2]
		if match[1] != "" {
			name = strings.ReplaceAll(match[1], "''", "'")
		}
		names = append(names, name)
	}
	return names
}

type hiddenFormulaCell struct {
	row, column int
	formula     string
}

type recomputedFormulaResult struct {
	config json.RawMessage
	// values carries the new results, for the saving user's own editor.
	values []model.CellUpdate
	// formulas carries the same cells with their formula, for broadcasting:
	// the realtime filter turns them back into results for restricted users.
	formulas []model.CellUpdate
}

// foreignSheetLoader returns the cell data of another sheet of the workbook by
// name, or nil when there is none.
type foreignSheetLoader func(name string) map[string]map[string]json.RawMessage

func excelizeSheetName(name string) string {
	cleaned := strings.Map(func(r rune) rune {
		if strings.ContainsRune(`[]:*?/\`, r) {
			return '_'
		}
		return r
	}, strings.Trim(name, "'"))
	if runes := []rune(cleaned); len(runes) > 31 {
		cleaned = string(runes[:31])
	}
	if strings.TrimSpace(cleaned) == "" {
		return "Sheet1"
	}
	return cleaned
}

func setExcelizeCellFromUniver(file *excelize.File, sheet string, row, column int, raw json.RawMessage) {
	var cell struct {
		V json.RawMessage `json:"v"`
		T int             `json:"t"`
	}
	if err := json.Unmarshal(raw, &cell); err != nil || len(cell.V) == 0 || bytes.Equal(cell.V, []byte("null")) {
		return
	}
	ref, err := excelize.CoordinatesToCellName(column+1, row+1)
	if err != nil {
		return
	}
	var value interface{}
	if err := json.Unmarshal(cell.V, &value); err != nil {
		return
	}
	switch typed := value.(type) {
	case float64:
		_ = file.SetCellValue(sheet, ref, typed)
	case bool:
		_ = file.SetCellBool(sheet, ref, typed)
	case string:
		if cell.T == 2 {
			if number, err := strconv.ParseFloat(strings.TrimSpace(typed), 64); err == nil {
				_ = file.SetCellValue(sheet, ref, number)
				return
			}
		}
		if typed != "" {
			_ = file.SetCellStr(sheet, ref, typed)
		}
	}
}

// recomputeHiddenFormulaResults recalculates the formulas hidden from userID,
// whose cached results that user's editor cannot refresh. Visible formulas are
// taken at their cached value: the user's own editor computed them.
func recomputeHiddenFormulaResults(config json.RawMessage, sheetName string, columnKeys []string, protections protectionMaps, userID int64, departmentIDs map[int64]struct{}, loadForeign foreignSheetLoader) (*recomputedFormulaResult, error) {
	if len(config) == 0 || !hidesFormulaFromUser(protections, userID, departmentIDs) {
		return nil, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, err
	}
	var sheetData map[string]json.RawMessage
	if err := json.Unmarshal(payload["univerSheetData"], &sheetData); err != nil || sheetData == nil {
		return nil, nil
	}
	var cells map[string]map[string]json.RawMessage
	if err := json.Unmarshal(sheetData["cellData"], &cells); err != nil || cells == nil {
		return nil, nil
	}

	type sharedOwner struct {
		row, column int
		formula     string
	}
	owners := map[string]sharedOwner{}
	type parsedCell struct {
		F  string `json:"f"`
		SI string `json:"si"`
	}
	parsed := make(map[[2]int]parsedCell)
	for rowKey, rowCells := range cells {
		row, err := strconv.Atoi(rowKey)
		if err != nil || row < 0 {
			continue
		}
		for columnKey, raw := range rowCells {
			column, err := strconv.Atoi(columnKey)
			if err != nil || column < 0 || !bytes.Contains(raw, []byte(`"f"`)) && !bytes.Contains(raw, []byte(`"si"`)) {
				continue
			}
			var cell parsedCell
			if json.Unmarshal(raw, &cell) != nil {
				continue
			}
			parsed[[2]int{row, column}] = cell
			if cell.SI != "" && strings.HasPrefix(cell.F, "=") {
				current, exists := owners[cell.SI]
				if !exists || row < current.row || (row == current.row && column < current.column) {
					owners[cell.SI] = sharedOwner{row: row, column: column, formula: cell.F}
				}
			}
		}
	}

	hidden := make([]hiddenFormulaCell, 0)
	for position, cell := range parsed {
		row, column := position[0], position[1]
		if row < 1 || column >= len(columnKeys) || !protectionHidesFormula(protections, row-1, columnKeys[column], userID, false, departmentIDs) {
			continue
		}
		formula := cell.F
		if !strings.HasPrefix(formula, "=") && cell.SI != "" {
			if source, ok := owners[cell.SI]; ok {
				formula = moveFormulaRelativeRefs(source.formula, column-source.column, row-source.row)
			}
		}
		if strings.HasPrefix(formula, "=") {
			hidden = append(hidden, hiddenFormulaCell{row: row, column: column, formula: formula})
		}
	}
	if len(hidden) == 0 {
		return nil, nil
	}

	file := excelize.NewFile()
	defer file.Close()
	ownSheet := excelizeSheetName(sheetName)
	if ownSheet != "Sheet1" {
		if err := file.SetSheetName("Sheet1", ownSheet); err != nil {
			ownSheet = "Sheet1"
		}
	}
	hiddenAt := make(map[[2]int]string, len(hidden))
	for _, cell := range hidden {
		hiddenAt[[2]int{cell.row, cell.column}] = cell.formula
	}
	for rowKey, rowCells := range cells {
		row, err := strconv.Atoi(rowKey)
		if err != nil || row < 0 {
			continue
		}
		for columnKey, raw := range rowCells {
			column, err := strconv.Atoi(columnKey)
			if err != nil || column < 0 {
				continue
			}
			if formula, isHidden := hiddenAt[[2]int{row, column}]; isHidden {
				if ref, err := excelize.CoordinatesToCellName(column+1, row+1); err == nil {
					_ = file.SetCellFormula(ownSheet, ref, strings.TrimPrefix(formula, "="))
				}
				continue
			}
			setExcelizeCellFromUniver(file, ownSheet, row, column, raw)
		}
	}

	if loadForeign != nil {
		loaded := map[string]bool{ownSheet: true}
		for _, cell := range hidden {
			for _, name := range referencedFormulaSheets(cell.formula) {
				target := excelizeSheetName(name)
				if loaded[target] {
					continue
				}
				loaded[target] = true
				foreignCells := loadForeign(name)
				if foreignCells == nil {
					continue
				}
				if _, err := file.NewSheet(target); err != nil {
					continue
				}
				for rowKey, rowCells := range foreignCells {
					row, err := strconv.Atoi(rowKey)
					if err != nil || row < 0 {
						continue
					}
					for columnKey, raw := range rowCells {
						if column, err := strconv.Atoi(columnKey); err == nil && column >= 0 {
							setExcelizeCellFromUniver(file, target, row, column, raw)
						}
					}
				}
			}
		}
	}

	result := &recomputedFormulaResult{}
	changed := false
	for _, cell := range hidden {
		ref, err := excelize.CoordinatesToCellName(cell.column+1, cell.row+1)
		if err != nil {
			continue
		}
		value, err := file.CalcCellValue(ownSheet, ref, excelize.Options{RawCellValue: true})
		if err != nil {
			continue
		}
		var nextValue interface{} = value
		cellType := 1
		if number, err := strconv.ParseFloat(value, 64); err == nil && value != "" {
			nextValue = number
			cellType = 2
		}
		rowKey, columnKey := strconv.Itoa(cell.row), strconv.Itoa(cell.column)
		var current map[string]json.RawMessage
		if err := json.Unmarshal(cells[rowKey][columnKey], &current); err != nil || current == nil {
			continue
		}
		encodedValue, _ := json.Marshal(nextValue)
		if bytes.Equal(bytes.TrimSpace(current["v"]), encodedValue) {
			continue
		}
		current["v"] = encodedValue
		current["t"] = json.RawMessage(strconv.Itoa(cellType))
		updated, err := json.Marshal(current)
		if err != nil {
			continue
		}
		cells[rowKey][columnKey] = updated
		changed = true
		encodedFormula, _ := json.Marshal(cell.formula)
		result.values = append(result.values, model.CellUpdate{Row: cell.row - 1, Col: columnKeys[cell.column], Value: encodedValue})
		result.formulas = append(result.formulas, model.CellUpdate{Row: cell.row - 1, Col: columnKeys[cell.column], Value: encodedFormula})
	}
	if !changed {
		return nil, nil
	}
	encodedCells, err := json.Marshal(cells)
	if err != nil {
		return nil, err
	}
	sheetData["cellData"] = encodedCells
	encodedSheet, err := json.Marshal(sheetData)
	if err != nil {
		return nil, err
	}
	payload["univerSheetData"] = encodedSheet
	if result.config, err = json.Marshal(payload); err != nil {
		return nil, err
	}
	return result, nil
}

// DropHiddenFormulaChanges removes changes a user made to cells whose formula
// is hidden from them. The server restores those cells, so the edits must not
// be broadcast either: another editor would write them over the formula.
func (s *SheetService) DropHiddenFormulaChanges(userID int64, sheet *model.Sheet, changes []model.CellUpdate) ([]model.CellUpdate, error) {
	if len(changes) == 0 || sheet == nil {
		return changes, nil
	}
	protections, _, err := readSheetProtections(sheet.Config)
	if err != nil || !hasHiddenFormulaProtection(protections) {
		return changes, err
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil || isAdmin {
		return changes, err
	}
	departmentIDs, err := s.permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, err
	}
	departmentSet := int64Set(departmentIDs)
	kept := changes[:0:0]
	for _, change := range changes {
		if protectionHidesFormula(protections, change.Row, change.Col, userID, false, departmentSet) {
			continue
		}
		kept = append(kept, change)
	}
	return kept, nil
}
