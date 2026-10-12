package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"

	"yaerp/internal/model"
)

// Cell changes travel as (row index, column key, value). That addressing is
// only meaningful while every participant agrees on the row/column layout: as
// soon as rows or cells are inserted or deleted, an index based update, merge
// or revert lands one row off and a row ends up with another row's value or
// formula. Two rules keep index based collaboration safe:
//
//  1. Every structural change bumps config.structureRevision. A save that was
//     built against an older revision is rejected (the client reloads) instead
//     of being applied to rows that have moved in the meantime.
//  2. A save that itself changes the structure is taken as one consistent
//     snapshot: the per-cell "keep the server value for cells the client did
//     not list" merge is skipped, because it compares cells by position.

// ErrSheetStructureConflict reports a save based on an outdated row/column layout.
var ErrSheetStructureConflict = errors.New("sheet structure changed by another editor")

const sheetStructureRevisionKey = "structureRevision"

// SheetSaveOptions describes how a client snapshot relates to the server state.
type SheetSaveOptions struct {
	// StructureChanged is set when rows, columns or cell ranges were inserted,
	// deleted or moved since the client's last successful save.
	StructureChanged bool
	// BaseStructureRevision is the structure revision the client edited. Nil
	// for clients that do not track it (no conflict detection).
	BaseStructureRevision *int64
}

// SheetStructureRevision reads the structure revision stored in a sheet config.
func SheetStructureRevision(config json.RawMessage) int64 {
	if len(config) == 0 {
		return 0
	}
	var payload struct {
		Revision json.Number `json:"structureRevision"`
	}
	decoder := json.NewDecoder(bytes.NewReader(config))
	decoder.UseNumber()
	if err := decoder.Decode(&payload); err != nil {
		return 0
	}
	revision, err := payload.Revision.Int64()
	if err != nil || revision < 0 {
		return 0
	}
	return revision
}

// WithSheetStructureRevision stores revision in config. The client echoes the
// config it loaded, so the server always overwrites the value with its own.
func WithSheetStructureRevision(config json.RawMessage, revision int64) (json.RawMessage, error) {
	if SheetStructureRevision(config) == revision && (revision != 0 || !bytes.Contains(config, []byte(sheetStructureRevisionKey))) {
		return config, nil
	}
	payload := map[string]json.RawMessage{}
	if len(config) > 0 {
		if err := json.Unmarshal(config, &payload); err != nil {
			return nil, fmt.Errorf("parse sheet config: %w", err)
		}
		if payload == nil {
			payload = map[string]json.RawMessage{}
		}
	}
	payload[sheetStructureRevisionKey] = json.RawMessage(strconv.FormatInt(revision, 10))
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal sheet config: %w", err)
	}
	return encoded, nil
}

func snapshotRowCount(config json.RawMessage) int {
	var payload struct {
		Sheet struct {
			RowCount int `json:"rowCount"`
		} `json:"univerSheetData"`
	}
	if err := json.Unmarshal(config, &payload); err != nil {
		return 0
	}
	return payload.Sheet.RowCount
}

func rawCellValue(raw json.RawMessage) []byte {
	fields, ok := decodeCellValueFields(raw)
	if !ok {
		return nil
	}
	if len(fields.F) > 0 && !bytes.Equal(fields.F, []byte("null")) && !bytes.Equal(fields.F, []byte(`""`)) {
		return fields.F
	}
	if bytes.Equal(fields.V, []byte("null")) || bytes.Equal(fields.V, []byte(`""`)) {
		return nil
	}
	return fields.V
}

func isEmptyRawValue(raw []byte) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) || bytes.Equal(trimmed, []byte(`""`))
}

// sameShiftedValue reports whether current is previous after moving delta rows:
// the same value, or the same formula with its references following the move.
func sameShiftedValue(previous, current []byte, delta int) bool {
	if bytes.Equal(previous, current) {
		return true
	}
	oldFormula, ok := rawString(previous)
	if !ok || len(oldFormula) == 0 || oldFormula[0] != '=' {
		return false
	}
	newFormula, ok := rawString(current)
	if !ok {
		return false
	}
	return moveFormulaRelativeRefs(oldFormula, 0, delta) == newFormula
}

// splitShiftedCellChanges separates the cells of a structural save that merely
// moved with an inserted/deleted row from the cells the user really edited.
// Moved cells must not be treated as edits (an approval rule would "revert"
// them to the value of the row that used to live at that index).
func splitShiftedCellChanges(existingConfig, nextConfig, columns json.RawMessage, changes []model.CellUpdate) (edits, moved []model.CellUpdate) {
	delta := snapshotRowCount(nextConfig) - snapshotRowCount(existingConfig)
	if delta == 0 || len(changes) == 0 {
		return changes, nil
	}
	existingCells, err := decodeRawCellData(existingConfig)
	if err != nil || existingCells == nil {
		return changes, nil
	}
	nextCells, err := decodeRawCellData(nextConfig)
	if err != nil || nextCells == nil {
		return changes, nil
	}
	columnKeys, err := parseColumnKeys(columns)
	if err != nil {
		return changes, nil
	}
	columnIndexes := make(map[string]int, len(columnKeys))
	for index, key := range columnKeys {
		columnIndexes[key] = index
	}
	valueAt := func(cells map[string]map[string]json.RawMessage, worksheetRow int, columnKey string) []byte {
		if worksheetRow < 0 {
			return nil
		}
		return rawCellValue(cells[strconv.Itoa(worksheetRow)][columnKey])
	}
	edits = make([]model.CellUpdate, 0, len(changes))
	for _, change := range changes {
		columnIndex, exists := columnIndexes[change.Col]
		if !exists || change.Row < 0 {
			edits = append(edits, change)
			continue
		}
		columnKey := strconv.Itoa(columnIndex)
		worksheetRow := change.Row + 1
		next := valueAt(nextCells, worksheetRow, columnKey)
		// The cell came from the row that sat `delta` rows away before the shift.
		if !isEmptyRawValue(next) && sameShiftedValue(valueAt(existingCells, worksheetRow-delta, columnKey), next, delta) {
			moved = append(moved, change)
			continue
		}
		// The cell is now empty because its old content moved on (a new blank
		// row), or because its row was deleted.
		if isEmptyRawValue(next) {
			old := valueAt(existingCells, worksheetRow, columnKey)
			if delta < 0 || isEmptyRawValue(old) || sameShiftedValue(old, valueAt(nextCells, worksheetRow+delta, columnKey), delta) {
				moved = append(moved, change)
				continue
			}
		}
		edits = append(edits, change)
	}
	return edits, moved
}

// PrepareSheetCellChangesWithOptions is PrepareSheetCellChanges for clients
// that report structural changes and the structure revision they edited.
func (s *SheetService) PrepareSheetCellChangesWithOptions(userID int64, existing, next *model.Sheet, changes []model.CellUpdate, source string, options SheetSaveOptions) (*model.CellUpdateResult, error) {
	if existing == nil || next == nil {
		return &model.CellUpdateResult{AppliedChanges: changes}, nil
	}
	currentRevision := SheetStructureRevision(existing.Config)
	if options.BaseStructureRevision != nil && *options.BaseStructureRevision != currentRevision {
		return nil, ErrSheetStructureConflict
	}
	if !options.StructureChanged {
		result, err := s.PrepareSheetCellChanges(userID, existing, next, changes, source)
		if err != nil {
			return nil, err
		}
		next.Config, err = WithSheetStructureRevision(next.Config, currentRevision)
		if err != nil {
			return nil, err
		}
		return result, nil
	}

	result := &model.CellUpdateResult{AppliedChanges: changes}
	if len(changes) > 0 {
		collapsed, err := collapseCellChanges(changes)
		if err != nil {
			return nil, err
		}
		result = &model.CellUpdateResult{AppliedChanges: collapsed}
		edits, moved := splitShiftedCellChanges(existing.Config, next.Config, next.Columns, collapsed)
		if s.cellApprovalInterceptor != nil && len(edits) > 0 {
			intercepted, err := s.cellApprovalInterceptor(userID, edits, source)
			if err != nil {
				return nil, err
			}
			if intercepted != nil {
				result = intercepted
				result.AppliedChanges = append(result.AppliedChanges, moved...)
			}
		}
		if len(result.RevertedChanges) > 0 {
			next.Config, err = restoreWorksheetCellValues(existing.Config, next.Config, next.Columns, result.RevertedChanges)
			if err != nil {
				return nil, err
			}
		}
	}
	// No positional merge here: the snapshot is the only consistent description
	// of the new layout.
	var err error
	next.Config, err = WithSheetStructureRevision(next.Config, currentRevision+1)
	if err != nil {
		return nil, err
	}
	return result, nil
}

// bumpSheetStructureRevision is used by server side structural edits.
func bumpSheetStructureRevision(config json.RawMessage) (json.RawMessage, error) {
	return WithSheetStructureRevision(config, SheetStructureRevision(config)+1)
}
