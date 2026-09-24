package service

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// FormulaColumnCode is the machine-readable error code returned when a literal
// value is written into a type=formula column. Clients and agents can branch on
// it without parsing the human message.
const FormulaColumnCode = "COLUMN_TYPE_FORMULA"

// ErrFormulaColumnLiteral is the sentinel wrapped by FormulaColumnLiteralError.
var ErrFormulaColumnLiteral = errors.New("formula column rejects literal value")

// FormulaColumnLiteralError reports a rejected write to a formula column.
type FormulaColumnLiteralError struct {
	ColumnKey  string
	ColumnName string
	SheetID    int64
}

func (e *FormulaColumnLiteralError) Error() string {
	name := strings.TrimSpace(e.ColumnName)
	if name == "" {
		name = e.ColumnKey
	}
	return fmt.Sprintf(
		"%s: 列「%s」的类型是 formula，只能写入以 = 开头的公式；如需写入普通值，请先修改列类型，或在写入工具中显式设置 disable_formula=true（%s）",
		ErrFormulaColumnLiteral.Error(), name, FormulaColumnCode,
	)
}

// Is lets errors.Is(err, ErrFormulaColumnLiteral) succeed.
func (e *FormulaColumnLiteralError) Is(target error) bool {
	return target == ErrFormulaColumnLiteral
}

// findSheetColumn resolves a column key case-insensitively. Column names are not
// matched here on purpose: the write path always normalizes references to keys.
func findSheetColumn(columns []sheetColumnPayload, key string) (sheetColumnPayload, bool) {
	normalized := strings.ToLower(strings.TrimSpace(key))
	if normalized == "" {
		return sheetColumnPayload{}, false
	}
	for _, column := range columns {
		if strings.ToLower(strings.TrimSpace(column.Key)) == normalized {
			return column, true
		}
	}
	return sheetColumnPayload{}, false
}

// isFormulaColumn reports whether the column was declared as type=formula.
func isFormulaColumn(column sheetColumnPayload) bool {
	return strings.EqualFold(strings.TrimSpace(column.Type), "formula")
}

// isFormulaCellValue reports whether a raw JSON cell value is a formula string.
func isFormulaCellValue(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return false
	}
	text, ok := value.(string)
	if !ok {
		return false
	}
	return strings.HasPrefix(strings.TrimSpace(text), "=")
}

// validateFormulaColumnWrite rejects a literal write into a formula column.
//
// A formula column is derived data: letting a literal overwrite it silently
// turns the column into a mixed bag and is the first step of the "公式列被写成
// 普通值" data-loss pattern. Formula values (starting with "=") always pass.
// Callers can explicitly opt out with allowFormulaLiteral (agent
// disable_formula=true) after the user confirms the intent.
func validateFormulaColumnWrite(columns []sheetColumnPayload, sheetID int64, key string, raw json.RawMessage, allowFormulaLiteral bool) error {
	if allowFormulaLiteral {
		return nil
	}
	column, ok := findSheetColumn(columns, key)
	if !ok || !isFormulaColumn(column) {
		return nil
	}
	if isFormulaCellValue(raw) {
		return nil
	}
	return &FormulaColumnLiteralError{ColumnKey: column.Key, ColumnName: column.Name, SheetID: sheetID}
}
