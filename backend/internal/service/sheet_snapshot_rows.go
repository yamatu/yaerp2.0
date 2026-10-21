package service

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// The editor renders a sheet from the Univer snapshot stored in
// config.univerSheetData, not from the legacy rows table. A server side row
// insert/delete (AI tools, the rows API) therefore has to move the snapshot as
// well: cell rows, row metadata, merges and - the part that used to be missing
// - every formula reference that points at a moved row. Without it the rows
// table and the snapshot drift apart: the new row's values land on top of an
// existing snapshot row and `=M5*N5` keeps pointing at the row that used to be
// row 5.

// formulaRef is one A1 style cell reference inside a formula.
type formulaRef struct {
	colAbs bool
	col    string
	rowAbs bool
	row    int // 1-based
}

func (r formulaRef) String() string {
	var b strings.Builder
	if r.colAbs {
		b.WriteByte('$')
	}
	b.WriteString(r.col)
	if r.rowAbs {
		b.WriteByte('$')
	}
	b.WriteString(strconv.Itoa(r.row))
	return b.String()
}

const formulaRefError = "#REF!"

// anyFormulaSheet makes rewriteFormulaRefs treat references of every sheet alike.
const anyFormulaSheet = "*any-sheet*"

func isRefLetter(c byte) bool { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') }
func isRefDigit(c byte) bool  { return c >= '0' && c <= '9' }
func isIdentByte(c byte) bool {
	return isRefLetter(c) || isRefDigit(c) || c == '_' || c == '.' || c >= 0x80
}

// parseFormulaRef reads a cell reference starting at position i. It returns the
// reference and the index just past it.
func parseFormulaRef(formula string, i int) (formulaRef, int, bool) {
	var ref formulaRef
	j := i
	if j < len(formula) && formula[j] == '$' {
		ref.colAbs = true
		j++
	}
	start := j
	for j < len(formula) && isRefLetter(formula[j]) {
		j++
	}
	if j == start || j-start > 3 {
		return ref, i, false
	}
	ref.col = formula[start:j]
	if j < len(formula) && formula[j] == '$' {
		ref.rowAbs = true
		j++
	}
	start = j
	for j < len(formula) && isRefDigit(formula[j]) {
		j++
	}
	if j == start || j-start > 7 || formula[start] == '0' {
		return ref, i, false
	}
	row, err := strconv.Atoi(formula[start:j])
	if err != nil || row <= 0 {
		return ref, i, false
	}
	ref.row = row
	// `LOG10(`, `A1B`, `Sheet2!`... are not references.
	if j < len(formula) && (isIdentByte(formula[j]) || formula[j] == '(' || formula[j] == '!') {
		return ref, i, false
	}
	return ref, j, true
}

// rewriteFormulaRefs walks a formula and hands every same-sheet reference (a
// single cell or both ends of a range) to transform. String literals and
// references qualified with another sheet are copied verbatim. transform
// returns the replacement text.
func rewriteFormulaRefs(formula, sheetName string, transform func(start formulaRef, end *formulaRef) string) string {
	if !strings.HasPrefix(formula, "=") {
		return formula
	}
	var out strings.Builder
	out.Grow(len(formula) + 8)
	i := 0
	// otherSheet is true while the reference right after a `Sheet!` qualifier
	// belongs to another sheet.
	otherSheet := false
	for i < len(formula) {
		c := formula[i]
		switch {
		case c == '"':
			j := i + 1
			for j < len(formula) {
				if formula[j] == '"' {
					if j+1 < len(formula) && formula[j+1] == '"' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			if j < len(formula) {
				j++
			}
			out.WriteString(formula[i:j])
			i = j
			otherSheet = false
			continue
		case c == '\'':
			// Quoted sheet name: 'My Sheet'!A1 ('' escapes a quote).
			j := i + 1
			for j < len(formula) {
				if formula[j] == '\'' {
					if j+1 < len(formula) && formula[j+1] == '\'' {
						j += 2
						continue
					}
					break
				}
				j++
			}
			if j < len(formula) && j+1 < len(formula) && formula[j+1] == '!' {
				name := strings.ReplaceAll(formula[i+1:j], "''", "'")
				otherSheet = sheetName != anyFormulaSheet && !strings.EqualFold(name, sheetName)
				out.WriteString(formula[i : j+2])
				i = j + 2
				continue
			}
			if j < len(formula) {
				j++
			}
			out.WriteString(formula[i:j])
			i = j
			otherSheet = false
			continue
		}

		prevIsIdent := i > 0 && isIdentByte(formula[i-1])
		if !prevIsIdent && (c == '$' || isRefLetter(c)) {
			if ref, next, ok := parseFormulaRef(formula, i); ok {
				var end *formulaRef
				after := next
				if next < len(formula) && formula[next] == ':' {
					if second, secondNext, ok := parseFormulaRef(formula, next+1); ok {
						end = &second
						after = secondNext
					}
				}
				if otherSheet {
					out.WriteString(formula[i:after])
				} else {
					out.WriteString(transform(ref, end))
				}
				i = after
				otherSheet = false
				continue
			}
		}

		if !prevIsIdent && isIdentByte(c) {
			// An identifier: a function name, a defined name or an unquoted sheet
			// name followed by `!`.
			j := i
			for j < len(formula) && isIdentByte(formula[j]) {
				j++
			}
			if j < len(formula) && formula[j] == '!' {
				otherSheet = sheetName != anyFormulaSheet && !strings.EqualFold(formula[i:j], sheetName)
				out.WriteString(formula[i : j+1])
				i = j + 1
				continue
			}
			out.WriteString(formula[i:j])
			i = j
			otherSheet = false
			continue
		}

		out.WriteByte(c)
		if c != '$' && c != ':' {
			otherSheet = false
		}
		i++
	}
	return out.String()
}

// shiftFormulaRowsForInsert moves every reference at or below the 1-based row
// insertAt down by count rows (Excel semantics: absolute references move too).
func shiftFormulaRowsForInsert(formula, sheetName string, insertAt, count int) string {
	return rewriteFormulaRefs(formula, sheetName, func(start formulaRef, end *formulaRef) string {
		if start.row >= insertAt {
			start.row += count
		}
		if end == nil {
			return start.String()
		}
		if end.row >= insertAt {
			end.row += count
		}
		return start.String() + ":" + end.String()
	})
}

// shiftFormulaRowsForDelete removes the 1-based row deleted: references to it
// become #REF!, ranges shrink, and references below move up.
func shiftFormulaRowsForDelete(formula, sheetName string, deleted int) string {
	return rewriteFormulaRefs(formula, sheetName, func(start formulaRef, end *formulaRef) string {
		if end == nil {
			if start.row == deleted {
				return formulaRefError
			}
			if start.row > deleted {
				start.row--
			}
			return start.String()
		}
		first, last := &start, end
		if first.row > last.row {
			first, last = last, first
		}
		if first.row == deleted && last.row == deleted {
			return formulaRefError
		}
		if first.row > deleted {
			first.row--
		}
		if last.row >= deleted {
			last.row--
		}
		return start.String() + ":" + end.String()
	})
}

func columnLettersToIndex(letters string) int {
	index := 0
	for i := 0; i < len(letters); i++ {
		c := letters[i]
		if c >= 'a' && c <= 'z' {
			c -= 'a' - 'A'
		}
		index = index*26 + int(c-'A'+1)
	}
	return index - 1
}

func columnIndexToLetters(index int) string {
	if index < 0 {
		return ""
	}
	letters := ""
	for index >= 0 {
		letters = string(rune('A'+index%26)) + letters
		index = index/26 - 1
	}
	return letters
}

// moveFormulaRelativeRefs moves the relative parts of every reference, the way
// a formula changes when it is copied to another cell. It expands shared
// formula members into self-contained formulas.
func moveFormulaRelativeRefs(formula string, columnOffset, rowOffset int) string {
	move := func(ref formulaRef) (formulaRef, bool) {
		if !ref.rowAbs {
			ref.row += rowOffset
		}
		if !ref.colAbs {
			index := columnLettersToIndex(ref.col) + columnOffset
			if index < 0 {
				return ref, false
			}
			ref.col = columnIndexToLetters(index)
		}
		return ref, ref.row >= 1
	}
	// Other sheets' references are relative too, so no sheet is "foreign" here.
	return rewriteFormulaRefs(formula, anyFormulaSheet, func(start formulaRef, end *formulaRef) string {
		movedStart, ok := move(start)
		if !ok {
			return formulaRefError
		}
		if end == nil {
			return movedStart.String()
		}
		movedEnd, ok := move(*end)
		if !ok {
			return formulaRefError
		}
		return movedStart.String() + ":" + movedEnd.String()
	})
}

type snapshotCell = map[string]json.RawMessage

// opaqueCellKey marks a cell that is not a JSON object (null or a scalar) and is
// carried through untouched.
const opaqueCellKey = "*opaque*"

func rawString(raw json.RawMessage) (string, bool) {
	if len(raw) == 0 || raw[0] != '"' {
		return "", false
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return "", false
	}
	return value, true
}

// expandSharedFormulaCells turns every shared formula member (a cell that only
// carries `si`) into a self-contained formula, so a structural change cannot
// separate a member from the cell that owns the formula text.
func expandSharedFormulaCells(cells map[int]map[int]snapshotCell) {
	type owner struct {
		row, column int
		formula     string
	}
	owners := make(map[string]owner)
	hasMembers := false
	for row, columns := range cells {
		for column, cell := range columns {
			shared, ok := rawString(cell["si"])
			if !ok || shared == "" {
				continue
			}
			formula, hasFormula := rawString(cell["f"])
			if !hasFormula || !strings.HasPrefix(formula, "=") {
				hasMembers = true
				continue
			}
			current, exists := owners[shared]
			// The first cell in reading order owns the group, like in Univer.
			if !exists || row < current.row || (row == current.row && column < current.column) {
				owners[shared] = owner{row: row, column: column, formula: formula}
			}
		}
	}
	if !hasMembers {
		return
	}
	for row, columns := range cells {
		for column, cell := range columns {
			shared, ok := rawString(cell["si"])
			if !ok || shared == "" {
				continue
			}
			if formula, hasFormula := rawString(cell["f"]); hasFormula && strings.HasPrefix(formula, "=") {
				continue
			}
			source, exists := owners[shared]
			if !exists {
				continue
			}
			moved := moveFormulaRelativeRefs(source.formula, column-source.column, row-source.row)
			encoded, err := json.Marshal(moved)
			if err != nil {
				continue
			}
			cell["f"] = encoded
			delete(cell, "si")
		}
	}
}

func decodeIndexedRawMap(raw json.RawMessage) (map[int]json.RawMessage, map[string]json.RawMessage, bool) {
	if len(raw) == 0 {
		return nil, nil, false
	}
	var keyed map[string]json.RawMessage
	if err := json.Unmarshal(raw, &keyed); err != nil {
		return nil, nil, false
	}
	indexed := make(map[int]json.RawMessage, len(keyed))
	other := make(map[string]json.RawMessage)
	for key, value := range keyed {
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 {
			other[key] = value
			continue
		}
		indexed[index] = value
	}
	return indexed, other, true
}

func encodeIndexedRawMap(indexed map[int]json.RawMessage, other map[string]json.RawMessage) (json.RawMessage, error) {
	keyed := make(map[string]json.RawMessage, len(indexed)+len(other))
	for key, value := range other {
		keyed[key] = value
	}
	for index, value := range indexed {
		keyed[strconv.Itoa(index)] = value
	}
	return json.Marshal(keyed)
}

// shiftRowIndex returns the row a worksheet row moves to (keep=false: deleted).
func shiftRowIndex(row, worksheetRow int, insert bool) (int, bool) {
	if insert {
		if row >= worksheetRow {
			return row + 1, true
		}
		return row, true
	}
	if row == worksheetRow {
		return 0, false
	}
	if row > worksheetRow {
		return row - 1, true
	}
	return row, true
}

// shiftFormulaColumnsForInsert moves every reference at or right of the
// 0-based column insertAt one column to the right.
func shiftFormulaColumnsForInsert(formula, sheetName string, insertAt int) string {
	move := func(ref formulaRef) formulaRef {
		if index := columnLettersToIndex(ref.col); index >= insertAt {
			ref.col = columnIndexToLetters(index + 1)
		}
		return ref
	}
	return rewriteFormulaRefs(formula, sheetName, func(start formulaRef, end *formulaRef) string {
		if end == nil {
			return move(start).String()
		}
		return move(start).String() + ":" + move(*end).String()
	})
}

// shiftSnapshotColumnsInConfig opens an empty column at the 0-based column
// index in the Univer snapshot: cells, column metadata and merges right of it
// move one column over and formulas keep pointing at the same data. Configs
// without a snapshot are returned untouched.
func shiftSnapshotColumnsInConfig(config json.RawMessage, sheetName string, column int, header string) (json.RawMessage, error) {
	if len(config) == 0 || column < 0 {
		return config, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, fmt.Errorf("parse sheet config: %w", err)
	}
	sheetRaw, ok := payload["univerSheetData"]
	if !ok || len(sheetRaw) == 0 {
		return config, nil
	}
	var sheet map[string]json.RawMessage
	if err := json.Unmarshal(sheetRaw, &sheet); err != nil || sheet == nil {
		return config, nil
	}
	if name, ok := rawString(sheet["name"]); ok && name != "" {
		sheetName = name
	}
	shift := func(index int) int {
		if index >= column {
			return index + 1
		}
		return index
	}

	rowsRaw, otherRows, hasCells := decodeIndexedRawMap(sheet["cellData"])
	if hasCells {
		cells := make(map[int]map[int]snapshotCell, len(rowsRaw))
		passthrough := make(map[int]json.RawMessage)
		for row, raw := range rowsRaw {
			columnsRaw, otherColumns, ok := decodeIndexedRawMap(raw)
			if !ok || len(otherColumns) > 0 {
				passthrough[row] = raw
				continue
			}
			columns := make(map[int]snapshotCell, len(columnsRaw))
			for index, cellRaw := range columnsRaw {
				var cell snapshotCell
				if err := json.Unmarshal(cellRaw, &cell); err != nil || cell == nil {
					cell = snapshotCell{opaqueCellKey: cellRaw}
				}
				columns[index] = cell
			}
			cells[row] = columns
		}
		expandSharedFormulaCells(cells)
		if _, ok := cells[0]; !ok && header != "" {
			if _, opaque := passthrough[0]; !opaque {
				cells[0] = map[int]snapshotCell{}
			}
		}

		shifted := make(map[int]json.RawMessage, len(cells)+len(passthrough))
		for row, columns := range cells {
			encodedColumns := make(map[int]json.RawMessage, len(columns)+1)
			if row == 0 && header != "" {
				encodedHeader, err := json.Marshal(map[string]string{"v": header})
				if err != nil {
					return nil, err
				}
				encodedColumns[column] = encodedHeader
			}
			for index, cell := range columns {
				if raw, opaque := cell[opaqueCellKey]; opaque {
					encodedColumns[shift(index)] = raw
					continue
				}
				if formula, ok := rawString(cell["f"]); ok && strings.HasPrefix(formula, "=") {
					if next := shiftFormulaColumnsForInsert(formula, sheetName, column); next != formula {
						encoded, err := json.Marshal(next)
						if err != nil {
							return nil, fmt.Errorf("marshal shifted formula: %w", err)
						}
						cell["f"] = encoded
						delete(cell, "v")
					}
				}
				encoded, err := json.Marshal(cell)
				if err != nil {
					return nil, fmt.Errorf("marshal shifted cell: %w", err)
				}
				encodedColumns[shift(index)] = encoded
			}
			encodedRow, err := encodeIndexedRawMap(encodedColumns, nil)
			if err != nil {
				return nil, fmt.Errorf("marshal shifted row: %w", err)
			}
			shifted[row] = encodedRow
		}
		for row, raw := range passthrough {
			shifted[row] = raw
		}
		encodedCells, err := encodeIndexedRawMap(shifted, otherRows)
		if err != nil {
			return nil, fmt.Errorf("marshal shifted cell data: %w", err)
		}
		sheet["cellData"] = encodedCells
	}

	if columnData, otherColumnData, ok := decodeIndexedRawMap(sheet["columnData"]); ok {
		shifted := make(map[int]json.RawMessage, len(columnData))
		for index, raw := range columnData {
			shifted[shift(index)] = raw
		}
		encoded, err := encodeIndexedRawMap(shifted, otherColumnData)
		if err != nil {
			return nil, fmt.Errorf("marshal shifted column data: %w", err)
		}
		sheet["columnData"] = encoded
	}

	if mergeRaw, ok := sheet["mergeData"]; ok && len(mergeRaw) > 0 {
		var merges []map[string]json.RawMessage
		if err := json.Unmarshal(mergeRaw, &merges); err == nil {
			for _, merge := range merges {
				var startColumn, endColumn int
				if json.Unmarshal(merge["startColumn"], &startColumn) != nil || json.Unmarshal(merge["endColumn"], &endColumn) != nil {
					continue
				}
				merge["startColumn"] = json.RawMessage(strconv.Itoa(shift(startColumn)))
				merge["endColumn"] = json.RawMessage(strconv.Itoa(shift(endColumn)))
			}
			encoded, err := json.Marshal(merges)
			if err != nil {
				return nil, fmt.Errorf("marshal shifted merges: %w", err)
			}
			sheet["mergeData"] = encoded
		}
	}

	var columnCount int
	if json.Unmarshal(sheet["columnCount"], &columnCount) == nil && columnCount > 0 {
		sheet["columnCount"] = json.RawMessage(strconv.Itoa(columnCount + 1))
	}

	encodedSheet, err := json.Marshal(sheet)
	if err != nil {
		return nil, fmt.Errorf("marshal shifted worksheet: %w", err)
	}
	payload["univerSheetData"] = encodedSheet
	encodedConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal shifted sheet config: %w", err)
	}
	return encodedConfig, nil
}

// shiftSnapshotRowsInConfig inserts an empty worksheet row at worksheetRow
// (0-based, the header is row 0) or deletes that row from the Univer snapshot
// in config, and rewrites the formulas so they keep pointing at the same data.
// Configs without a snapshot are returned untouched.
func shiftSnapshotRowsInConfig(config json.RawMessage, sheetName string, worksheetRow int, insert bool) (json.RawMessage, error) {
	if len(config) == 0 || worksheetRow < 0 {
		return config, nil
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, fmt.Errorf("parse sheet config: %w", err)
	}
	sheetRaw, ok := payload["univerSheetData"]
	if !ok || len(sheetRaw) == 0 {
		return config, nil
	}
	var sheet map[string]json.RawMessage
	if err := json.Unmarshal(sheetRaw, &sheet); err != nil || sheet == nil {
		return config, nil
	}
	if name, ok := rawString(sheet["name"]); ok && name != "" {
		sheetName = name
	}

	// Cells: decode only the cell envelope, values stay raw JSON.
	rowsRaw, otherRows, hasCells := decodeIndexedRawMap(sheet["cellData"])
	if hasCells {
		cells := make(map[int]map[int]snapshotCell, len(rowsRaw))
		passthrough := make(map[int]json.RawMessage)
		for row, raw := range rowsRaw {
			columnsRaw, otherColumns, ok := decodeIndexedRawMap(raw)
			if !ok || len(otherColumns) > 0 {
				passthrough[row] = raw
				continue
			}
			columns := make(map[int]snapshotCell, len(columnsRaw))
			for column, cellRaw := range columnsRaw {
				var cell snapshotCell
				if err := json.Unmarshal(cellRaw, &cell); err != nil || cell == nil {
					// null or a scalar: keep it as an opaque value.
					cell = snapshotCell{opaqueCellKey: cellRaw}
				}
				columns[column] = cell
			}
			cells[row] = columns
		}
		expandSharedFormulaCells(cells)

		excelRow := worksheetRow + 1
		shifted := make(map[int]json.RawMessage, len(cells)+len(passthrough))
		rowIndexes := make([]int, 0, len(cells))
		for row := range cells {
			rowIndexes = append(rowIndexes, row)
		}
		sort.Ints(rowIndexes)
		for _, row := range rowIndexes {
			target, keep := shiftRowIndex(row, worksheetRow, insert)
			if !keep {
				continue
			}
			columns := cells[row]
			encodedColumns := make(map[int]json.RawMessage, len(columns))
			for column, cell := range columns {
				if raw, opaque := cell[opaqueCellKey]; opaque {
					encodedColumns[column] = raw
					continue
				}
				if formula, ok := rawString(cell["f"]); ok && strings.HasPrefix(formula, "=") {
					var next string
					if insert {
						next = shiftFormulaRowsForInsert(formula, sheetName, excelRow, 1)
					} else {
						next = shiftFormulaRowsForDelete(formula, sheetName, excelRow)
					}
					if next != formula {
						encoded, err := json.Marshal(next)
						if err != nil {
							return nil, fmt.Errorf("marshal shifted formula: %w", err)
						}
						cell["f"] = encoded
						// The cached result belongs to the old references.
						delete(cell, "v")
					}
				}
				encoded, err := json.Marshal(cell)
				if err != nil {
					return nil, fmt.Errorf("marshal shifted cell: %w", err)
				}
				encodedColumns[column] = encoded
			}
			encodedRow, err := encodeIndexedRawMap(encodedColumns, nil)
			if err != nil {
				return nil, fmt.Errorf("marshal shifted row: %w", err)
			}
			shifted[target] = encodedRow
		}
		for row, raw := range passthrough {
			if target, keep := shiftRowIndex(row, worksheetRow, insert); keep {
				shifted[target] = raw
			}
		}
		encodedCells, err := encodeIndexedRawMap(shifted, otherRows)
		if err != nil {
			return nil, fmt.Errorf("marshal shifted cell data: %w", err)
		}
		sheet["cellData"] = encodedCells
	}

	// Row metadata (height, hidden, row style) moves with its row.
	if rowData, otherRowData, ok := decodeIndexedRawMap(sheet["rowData"]); ok {
		shifted := make(map[int]json.RawMessage, len(rowData))
		for row, raw := range rowData {
			if target, keep := shiftRowIndex(row, worksheetRow, insert); keep {
				shifted[target] = raw
			}
		}
		encoded, err := encodeIndexedRawMap(shifted, otherRowData)
		if err != nil {
			return nil, fmt.Errorf("marshal shifted row data: %w", err)
		}
		sheet["rowData"] = encoded
	}

	if mergeRaw, ok := sheet["mergeData"]; ok && len(mergeRaw) > 0 {
		var merges []map[string]json.RawMessage
		if err := json.Unmarshal(mergeRaw, &merges); err == nil {
			next := make([]map[string]json.RawMessage, 0, len(merges))
			for _, merge := range merges {
				var startRow, endRow int
				if json.Unmarshal(merge["startRow"], &startRow) != nil || json.Unmarshal(merge["endRow"], &endRow) != nil {
					next = append(next, merge)
					continue
				}
				if insert {
					if startRow >= worksheetRow {
						startRow++
					}
					if endRow >= worksheetRow {
						endRow++
					}
				} else {
					if startRow == worksheetRow && endRow == worksheetRow {
						continue
					}
					if startRow > worksheetRow {
						startRow--
					}
					if endRow >= worksheetRow {
						endRow--
					}
				}
				merge["startRow"] = json.RawMessage(strconv.Itoa(startRow))
				merge["endRow"] = json.RawMessage(strconv.Itoa(endRow))
				next = append(next, merge)
			}
			encoded, err := json.Marshal(next)
			if err != nil {
				return nil, fmt.Errorf("marshal shifted merges: %w", err)
			}
			sheet["mergeData"] = encoded
		}
	}

	if insert {
		var rowCount int
		if json.Unmarshal(sheet["rowCount"], &rowCount) == nil && rowCount > 0 {
			sheet["rowCount"] = json.RawMessage(strconv.Itoa(rowCount + 1))
		}
	}

	encodedSheet, err := json.Marshal(sheet)
	if err != nil {
		return nil, fmt.Errorf("marshal shifted worksheet: %w", err)
	}
	payload["univerSheetData"] = encodedSheet
	encodedConfig, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal shifted sheet config: %w", err)
	}
	return encodedConfig, nil
}
