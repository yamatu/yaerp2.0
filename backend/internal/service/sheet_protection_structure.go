package service

import (
	"fmt"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

// Protections are addressed by position: a data row index and a column key,
// and the editor keeps column keys positional as well. When rows or columns
// are inserted, removed or moved in the editor, the protections therefore have
// to be moved with them, or a mask ends up covering another row and exposes the
// data it used to hide.

const maxStructureOpsPerSave = 500

func validateStructureOps(ops []model.SheetStructureOp) error {
	if len(ops) > maxStructureOpsPerSave {
		return fmt.Errorf("%w: 单次保存的行列结构操作过多，请分批操作", ErrProtectionDenied)
	}
	for _, op := range ops {
		if op.Axis != "row" && op.Axis != "column" {
			return fmt.Errorf("%w: 无效的行列结构操作", ErrProtectionDenied)
		}
		if op.Start < 0 || op.Count <= 0 {
			return fmt.Errorf("%w: 无效的行列结构操作范围", ErrProtectionDenied)
		}
		switch op.Kind {
		case "insert", "remove":
		case "move":
			if op.Target < 0 || (op.Target > op.Start && op.Target < op.Start+op.Count) {
				return fmt.Errorf("%w: 无效的行列移动操作", ErrProtectionDenied)
			}
		default:
			return fmt.Errorf("%w: 无效的行列结构操作", ErrProtectionDenied)
		}
	}
	return nil
}

// mapStructureIndex returns where a worksheet index ends up after op, or false
// when the op removes it.
func mapStructureIndex(op model.SheetStructureOp, index int) (int, bool) {
	start, count := op.Start, op.Count
	switch op.Kind {
	case "insert":
		if index >= start {
			return index + count, true
		}
		return index, true
	case "remove":
		if index < start {
			return index, true
		}
		if index < start+count {
			return 0, false
		}
		return index - count, true
	case "move":
		target := op.Target
		if index >= start && index < start+count {
			if target > start {
				return target - count + (index - start), true
			}
			return target + (index - start), true
		}
		if target > start {
			if index >= start+count && index < target {
				return index - count, true
			}
			return index, true
		}
		if index >= target && index < start {
			return index + count, true
		}
		return index, true
	}
	return index, true
}

type structurePosition struct {
	row    int // worksheet row, -1 for a whole column
	column int // column index, -1 for a whole row
}

func describeProtectedPosition(op model.SheetStructureOp, index int) string {
	if op.Axis == "row" {
		return fmt.Sprintf("第 %d 行", index+1)
	}
	return fmt.Sprintf("%s 列", columnIndexToLetters(index))
}

// applyStructureOpsToPositions moves every position through ops and fails as
// soon as an op deletes a protected row, column or cell.
func applyStructureOpsToPositions(positions []structurePosition, ops []model.SheetStructureOp) error {
	for _, op := range ops {
		for index := range positions {
			position := &positions[index]
			current := position.row
			if op.Axis == "column" {
				current = position.column
			}
			if current < 0 {
				continue
			}
			next, kept := mapStructureIndex(op, current)
			if !kept {
				return fmt.Errorf("%w: %s包含保护或遮罩区域，不能删除。请先解除对应保护再删除", ErrProtectionDenied, describeProtectedPosition(op, current))
			}
			if op.Axis == "row" {
				position.row = next
			} else {
				position.column = next
			}
		}
	}
	return nil
}

func columnKeyAt(columns []string, index int) string {
	if index >= 0 && index < len(columns) && columns[index] != "" {
		return columns[index]
	}
	return fmt.Sprintf("col_%d", index+1)
}

type cellProtectionKey struct {
	row    int
	column string
}

func parseCellProtectionKey(key string) (cellProtectionKey, bool) {
	parts := strings.SplitN(key, ":", 2)
	if len(parts) != 2 {
		return cellProtectionKey{}, false
	}
	row, err := strconv.Atoi(parts[0])
	if err != nil {
		return cellProtectionKey{}, false
	}
	return cellProtectionKey{row: row, column: parts[1]}, true
}

// remapProtectionsForStructureOps returns the protections and legacy locks
// after ops. Row keys are data rows (worksheet row - 1).
func remapProtectionsForStructureOps(protections protectionMaps, legacyLocks map[string]bool, currentColumns, nextColumns []string, ops []model.SheetStructureOp) (protectionMaps, map[string]bool, error) {
	columnIndexes := make(map[string]int, len(currentColumns))
	for index, key := range currentColumns {
		if _, exists := columnIndexes[key]; !exists {
			columnIndexes[key] = index
		}
	}

	type entry struct {
		kind     string
		original string
		column   string // unresolved column key, kept as is
		position int
	}
	entries := make([]entry, 0, len(protections.Rows)+len(protections.Columns)+len(protections.Cells)+len(legacyLocks))
	positions := make([]structurePosition, 0, cap(entries))
	add := func(kind, original, unresolvedColumn string, position structurePosition) {
		entries = append(entries, entry{kind: kind, original: original, column: unresolvedColumn, position: len(positions)})
		positions = append(positions, position)
	}
	columnPosition := func(key string) (int, string) {
		if index, ok := columnIndexes[key]; ok {
			return index, ""
		}
		return -1, key
	}

	for key := range protections.Rows {
		row, err := strconv.Atoi(key)
		if err != nil {
			continue
		}
		add("row", key, "", structurePosition{row: row + 1, column: -1})
	}
	for key := range protections.Columns {
		column, unresolved := columnPosition(key)
		add("column", key, unresolved, structurePosition{row: -1, column: column})
	}
	for key := range protections.Cells {
		parsed, ok := parseCellProtectionKey(key)
		if !ok {
			continue
		}
		column, unresolved := columnPosition(parsed.column)
		add("cell", key, unresolved, structurePosition{row: parsed.row + 1, column: column})
	}
	for key, locked := range legacyLocks {
		parsed, ok := parseCellProtectionKey(key)
		if !locked || !ok {
			continue
		}
		column, unresolved := columnPosition(parsed.column)
		add("legacy", key, unresolved, structurePosition{row: parsed.row + 1, column: column})
	}

	if err := applyStructureOpsToPositions(positions, ops); err != nil {
		return protectionMaps{}, nil, err
	}

	next := protectionMaps{
		Rows:    make(map[string]protectionOwner, len(protections.Rows)),
		Columns: make(map[string]protectionOwner, len(protections.Columns)),
		Cells:   make(map[string]protectionOwner, len(protections.Cells)),
	}
	nextLegacy := make(map[string]bool, len(legacyLocks))
	resolveColumn := func(item entry, position structurePosition) string {
		if item.column != "" {
			return item.column
		}
		return columnKeyAt(nextColumns, position.column)
	}
	for _, item := range entries {
		position := positions[item.position]
		if (item.kind == "row" || item.kind == "cell" || item.kind == "legacy") && position.row < 1 {
			return protectionMaps{}, nil, fmt.Errorf("%w: 不能把受保护的行移动到表头", ErrProtectionDenied)
		}
		switch item.kind {
		case "row":
			next.Rows[strconv.Itoa(position.row-1)] = protections.Rows[item.original]
		case "column":
			next.Columns[resolveColumn(item, position)] = protections.Columns[item.original]
		case "cell":
			next.Cells[fmt.Sprintf("%d:%s", position.row-1, resolveColumn(item, position))] = protections.Cells[item.original]
		case "legacy":
			nextLegacy[fmt.Sprintf("%d:%s", position.row-1, resolveColumn(item, position))] = true
		}
	}
	// Untouched entries that could not be parsed are carried over verbatim.
	for key, info := range protections.Rows {
		if _, err := strconv.Atoi(key); err != nil {
			next.Rows[key] = info
		}
	}
	for key, info := range protections.Cells {
		if _, ok := parseCellProtectionKey(key); !ok {
			next.Cells[key] = info
		}
	}
	return next, nextLegacy, nil
}

// protectedRowSpan reports whether any row or cell protection (or legacy lock)
// sits on one of the data rows [start, end].
func protectionCoversDataRows(protections protectionMaps, legacyLocks map[string]bool, start, end int) bool {
	for key := range protections.Rows {
		if row, err := strconv.Atoi(key); err == nil && row >= start && row <= end {
			return true
		}
	}
	for key := range protections.Cells {
		if parsed, ok := parseCellProtectionKey(key); ok && parsed.row >= start && parsed.row <= end {
			return true
		}
	}
	for key, locked := range legacyLocks {
		if parsed, ok := parseCellProtectionKey(key); locked && ok && parsed.row >= start && parsed.row <= end {
			return true
		}
	}
	return false
}
