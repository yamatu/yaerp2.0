package service

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"
	"time"

	"github.com/xuri/excelize/v2"
)

type sheetExportStyleCache struct {
	ids map[string]int
}

type excelNumberFormatSpec struct {
	NumFmt       *int    `json:"numFmt,omitempty"`
	CustomNumFmt *string `json:"customNumFmt,omitempty"`
}

func applySheetExportSnapshotDecorations(file *excelize.File, sheetName string, snapshot univerExportWorksheet, matrix exportSnapshotMatrix, columns []sheetColumnPayload, styles map[string]univerStyleData) error {
	if len(matrix.Rows) == 0 || len(matrix.Columns) == 0 {
		return nil
	}

	rowTargets := make(map[int]int, len(matrix.Rows))
	for targetIndex, row := range matrix.Rows {
		rowTargets[row.SourceRowIndex] = targetIndex + 1
	}
	colTargets := make(map[int]int, len(matrix.Columns))
	for targetIndex, column := range matrix.Columns {
		colTargets[column] = targetIndex + 1
	}
	for sourceColumn, targetColumn := range colTargets {
		if meta, ok := snapshot.ColumnData[strconv.Itoa(sourceColumn)]; ok && meta.Hidden == 1 {
			columnName, err := excelize.ColumnNumberToName(targetColumn)
			if err == nil {
				_ = file.SetColVisible(sheetName, columnName, false)
			}
		}
	}
	for sourceRow, targetRow := range rowTargets {
		if meta, ok := snapshot.RowData[strconv.Itoa(sourceRow)]; ok && meta.Hidden == 1 {
			_ = file.SetRowVisible(sheetName, targetRow, false)
		}
	}

	cache := &sheetExportStyleCache{ids: make(map[string]int)}
	for _, row := range matrix.Rows {
		targetRow := rowTargets[row.SourceRowIndex]
		rowMeta := snapshot.RowData[strconv.Itoa(row.SourceRowIndex)]
		for _, sourceColumn := range matrix.Columns {
			targetColumn := colTargets[sourceColumn]
			cell := row.Cells[sourceColumn]
			columnMeta := snapshot.ColumnData[strconv.Itoa(sourceColumn)]
			style := composeUniverStyles(styles, snapshot.DefaultStyle, rowMeta.Style, columnMeta.Style, cell.Style)
			if !isMeaningfulUniverStyle(style) {
				style = nil
			}
			var column *sheetColumnPayload
			if sourceColumn >= 0 && sourceColumn < len(columns) {
				column = &columns[sourceColumn]
			}

			styleID, err := cache.styleID(file, style, column, cell)
			if err != nil {
				return err
			}
			if styleID == 0 {
				continue
			}
			axis, _ := excelize.CoordinatesToCellName(targetColumn, targetRow)
			if err := file.SetCellStyle(sheetName, axis, axis, styleID); err != nil {
				return err
			}
		}
	}

	for _, merge := range snapshot.MergeData {
		startRow, ok := rowTargets[merge.StartRow]
		if !ok {
			continue
		}
		endRow, ok := rowTargets[merge.EndRow]
		if !ok {
			continue
		}
		startColumn, ok := colTargets[merge.StartColumn]
		if !ok {
			continue
		}
		endColumn, ok := colTargets[merge.EndColumn]
		if !ok {
			continue
		}

		topLeft, _ := excelize.CoordinatesToCellName(startColumn, startRow)
		bottomRight, _ := excelize.CoordinatesToCellName(endColumn, endRow)
		if err := file.MergeCell(sheetName, topLeft, bottomRight); err != nil {
			return err
		}

		cell := snapshot.CellData[strconv.Itoa(merge.StartRow)][strconv.Itoa(merge.StartColumn)]
		rowMeta := snapshot.RowData[strconv.Itoa(merge.StartRow)]
		columnMeta := snapshot.ColumnData[strconv.Itoa(merge.StartColumn)]
		style := composeUniverStyles(styles, snapshot.DefaultStyle, rowMeta.Style, columnMeta.Style, cell.Style)
		if !isMeaningfulUniverStyle(style) {
			style = nil
		}
		var column *sheetColumnPayload
		if merge.StartColumn >= 0 && merge.StartColumn < len(columns) {
			column = &columns[merge.StartColumn]
		}

		styleID, err := cache.styleID(file, style, column, cell)
		if err != nil {
			return err
		}
		if styleID == 0 {
			continue
		}
		if err := file.SetCellStyle(sheetName, topLeft, bottomRight, styleID); err != nil {
			return err
		}
	}

	return nil
}

func (c *sheetExportStyleCache) styleID(file *excelize.File, style *univerStyleData, column *sheetColumnPayload, cell univerExportCell) (int, error) {
	numberFormat := inferExcelNumberFormat(style, column, cell)
	if style == nil && numberFormat == nil {
		return 0, nil
	}
	keyBytes, err := json.Marshal(struct {
		Style  *univerStyleData       `json:"style,omitempty"`
		Format *excelNumberFormatSpec `json:"format,omitempty"`
	}{Style: style, Format: numberFormat})
	if err != nil {
		return 0, err
	}
	key := string(keyBytes)
	if existing, ok := c.ids[key]; ok {
		return existing, nil
	}

	excelStyle := buildExcelStyle(style, numberFormat)
	styleID, err := file.NewStyle(excelStyle)
	if err != nil {
		return 0, err
	}
	c.ids[key] = styleID
	return styleID, nil
}

func buildExcelStyle(style *univerStyleData, numberFormat *excelNumberFormatSpec) *excelize.Style {
	excelStyle := &excelize.Style{}

	if font := buildExcelFont(style); font != nil {
		excelStyle.Font = font
	}
	if fill := buildExcelFill(style); fill != nil {
		excelStyle.Fill = *fill
	}
	if alignment := buildExcelAlignment(style); alignment != nil {
		excelStyle.Alignment = alignment
	}
	if borders := buildExcelBorders(style); len(borders) > 0 {
		excelStyle.Border = borders
	}
	if numberFormat != nil {
		if numberFormat.NumFmt != nil {
			excelStyle.NumFmt = *numberFormat.NumFmt
		}
		if numberFormat.CustomNumFmt != nil && strings.TrimSpace(*numberFormat.CustomNumFmt) != "" {
			pattern := *numberFormat.CustomNumFmt
			excelStyle.CustomNumFmt = &pattern
		}
	}

	return excelStyle
}

func buildExcelFont(style *univerStyleData) *excelize.Font {
	if style == nil {
		return nil
	}

	font := &excelize.Font{}
	used := false
	if style.Bl != nil && *style.Bl == 1 {
		font.Bold = true
		used = true
	}
	if style.It != nil && *style.It == 1 {
		font.Italic = true
		used = true
	}
	if style.Ul != nil && style.Ul.S != nil && *style.Ul.S == 1 {
		font.Underline = "single"
		used = true
	}
	if style.St != nil && style.St.S != nil && *style.St.S == 1 {
		font.Strike = true
		used = true
	}
	if style.FF != nil && strings.TrimSpace(*style.FF) != "" {
		font.Family = strings.TrimSpace(strings.Split(*style.FF, ",")[0])
		used = true
	}
	if style.FS != nil && *style.FS > 0 {
		font.Size = *style.FS
		used = true
	}
	if r, g, b, ok := parseUniverColor(style.Cl); ok {
		font.Color = excelColorString(r, g, b)
		used = true
	}
	if style.Va != nil {
		switch *style.Va {
		case 2:
			font.VertAlign = "subscript"
			used = true
		case 3:
			font.VertAlign = "superscript"
			used = true
		}
	}

	if !used {
		return nil
	}
	return font
}

func buildExcelFill(style *univerStyleData) *excelize.Fill {
	if style == nil {
		return nil
	}
	r, g, b, ok := parseUniverColor(style.Bg)
	if !ok {
		return nil
	}
	return &excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{excelColorString(r, g, b)}}
}

func buildExcelAlignment(style *univerStyleData) *excelize.Alignment {
	if style == nil {
		return nil
	}
	alignment := &excelize.Alignment{}
	used := false
	if style.Ht != nil {
		switch *style.Ht {
		case 2:
			alignment.Horizontal = "center"
			used = true
		case 3:
			alignment.Horizontal = "right"
			used = true
		default:
			alignment.Horizontal = "left"
			used = true
		}
	}
	if style.Vt != nil {
		switch *style.Vt {
		case 2:
			alignment.Vertical = "center"
			used = true
		case 3:
			alignment.Vertical = "bottom"
			used = true
		default:
			alignment.Vertical = "top"
			used = true
		}
	}
	if style.Tb != nil {
		alignment.WrapText = *style.Tb == 3
		used = true
	}
	if style.Tr != nil {
		if style.Tr.V != nil && *style.Tr.V == 1 {
			alignment.TextRotation = 255
			used = true
		} else {
			rotation := int(style.Tr.A)
			if rotation < 0 {
				rotation = 90 - rotation
			}
			if rotation >= 0 && rotation <= 180 {
				alignment.TextRotation = rotation
				used = true
			}
		}
	}
	if !used {
		return nil
	}
	return alignment
}

func buildExcelBorders(style *univerStyleData) []excelize.Border {
	if style == nil || style.Bd == nil {
		return nil
	}
	borders := make([]excelize.Border, 0, 4)
	if border := buildExcelBorderSide("top", style.Bd.T); border != nil {
		borders = append(borders, *border)
	}
	if border := buildExcelBorderSide("right", style.Bd.R); border != nil {
		borders = append(borders, *border)
	}
	if border := buildExcelBorderSide("bottom", style.Bd.B); border != nil {
		borders = append(borders, *border)
	}
	if border := buildExcelBorderSide("left", style.Bd.L); border != nil {
		borders = append(borders, *border)
	}
	return borders
}

func buildExcelBorderSide(side string, border *univerBorderStyleData) *excelize.Border {
	if border == nil || border.S == nil || *border.S == 0 {
		return nil
	}
	result := &excelize.Border{Type: side, Style: mapExcelBorderStyle(*border.S)}
	if r, g, b, ok := parseUniverColor(border.CL); ok {
		result.Color = excelColorString(r, g, b)
	}
	return result
}

func mapExcelBorderStyle(style int) int {
	switch style {
	case 1:
		return 1
	case 2:
		return 7
	case 3:
		return 4
	case 4:
		return 3
	case 5:
		return 9
	case 6:
		return 11
	case 7:
		return 6
	case 8:
		return 2
	case 9:
		return 8
	case 10:
		return 10
	case 11:
		return 12
	case 12:
		return 13
	case 13:
		return 5
	default:
		return 1
	}
}

func excelColorString(r, g, b int) string {
	return fmt.Sprintf("#%02X%02X%02X", r, g, b)
}

func normalizeExcelExportValue(value any, column *sheetColumnPayload) (any, bool) {
	if value == nil {
		return nil, false
	}
	if column == nil {
		return nil, false
	}

	switch typed := value.(type) {
	case time.Time:
		return typed, true
	case string:
		trimmed := strings.TrimSpace(typed)
		if trimmed == "" {
			return typed, true
		}
		switch strings.ToLower(column.Type) {
		case "date":
			if parsed, ok := parseExcelTimeValue(trimmed); ok {
				return parsed, true
			}
		case "number", "currency", "formula":
			if parsed, ok := parseExcelNumericValue(trimmed); ok {
				return parsed, true
			}
		}
		if strings.HasSuffix(trimmed, "%") {
			if parsed, ok := parseExcelPercentValue(trimmed); ok {
				return parsed, true
			}
		}
	case json.Number:
		if parsed, err := typed.Float64(); err == nil {
			return parsed, true
		}
	}
	return nil, false
}

func inferExcelNumberFormat(style *univerStyleData, column *sheetColumnPayload, cell univerExportCell) *excelNumberFormatSpec {
	if style != nil && style.N != nil && strings.TrimSpace(style.N.Pattern) != "" {
		return mapExcelNumberPattern(style.N.Pattern)
	}
	if column == nil {
		if text, ok := normalizeSheetPDFValue(cell.Value).(string); ok && strings.HasSuffix(strings.TrimSpace(text), "%") {
			return &excelNumberFormatSpec{NumFmt: intPtr(10)}
		}
		return nil
	}

	raw := normalizeSheetPDFValue(cell.Value)
	switch strings.ToLower(column.Type) {
	case "currency":
		pattern := buildCurrencyNumFmt(column.CurrencyCode, raw)
		return &excelNumberFormatSpec{CustomNumFmt: &pattern}
	case "date":
		pattern := "yyyy-mm-dd"
		if text, ok := raw.(string); ok {
			if _, hasTime := parseExcelTimeValue(text); hasTime && strings.ContainsAny(text, ":T") {
				pattern = "yyyy-mm-dd hh:mm:ss"
			}
		}
		return mapExcelNumberPattern(pattern)
	case "number", "formula":
		return inferNumericExcelFormat(raw)
	default:
		if text, ok := raw.(string); ok && strings.HasSuffix(strings.TrimSpace(text), "%") {
			return &excelNumberFormatSpec{NumFmt: intPtr(10)}
		}
		return nil
	}
}

func inferNumericExcelFormat(value any) *excelNumberFormatSpec {
	decimals := 0
	switch typed := value.(type) {
	case float64:
		decimals = decimalPlacesFromFloat(typed)
	case float32:
		decimals = decimalPlacesFromFloat(float64(typed))
	case string:
		trimmed := strings.TrimSpace(strings.ReplaceAll(typed, ",", ""))
		if strings.HasSuffix(trimmed, "%") {
			return &excelNumberFormatSpec{NumFmt: intPtr(10)}
		}
		if dot := strings.Index(trimmed, "."); dot >= 0 {
			decimals = len(strings.TrimRight(trimmed[dot+1:], "0"))
		}
	case json.Number:
		if text := typed.String(); strings.Contains(text, ".") {
			decimals = len(strings.TrimRight(strings.SplitN(text, ".", 2)[1], "0"))
		}
	}
	if decimals <= 0 {
		return &excelNumberFormatSpec{NumFmt: intPtr(3)}
	}
	if decimals == 2 {
		return &excelNumberFormatSpec{NumFmt: intPtr(4)}
	}
	pattern := "#,##0." + strings.Repeat("0", min(decimals, 6))
	return &excelNumberFormatSpec{CustomNumFmt: &pattern}
}

func mapExcelNumberPattern(pattern string) *excelNumberFormatSpec {
	trimmed := strings.TrimSpace(pattern)
	if trimmed == "" {
		return nil
	}
	normalized := strings.ToLower(strings.ReplaceAll(trimmed, " ", ""))
	switch normalized {
	case "0":
		return &excelNumberFormatSpec{NumFmt: intPtr(1)}
	case "0.00":
		return &excelNumberFormatSpec{NumFmt: intPtr(2)}
	case "#,##0":
		return &excelNumberFormatSpec{NumFmt: intPtr(3)}
	case "#,##0.00":
		return &excelNumberFormatSpec{NumFmt: intPtr(4)}
	case "0%":
		return &excelNumberFormatSpec{NumFmt: intPtr(9)}
	case "0.00%":
		return &excelNumberFormatSpec{NumFmt: intPtr(10)}
	case "m/d/yy":
		return &excelNumberFormatSpec{NumFmt: intPtr(14)}
	case "yyyy-mm-dd", "yyyy/mm/dd", "yyyy.mm.dd":
		return &excelNumberFormatSpec{CustomNumFmt: &trimmed}
	case "yyyy-mm-ddhh:mm:ss", "yyyy/mm/ddhh:mm:ss":
		formatted := strings.ReplaceAll(trimmed, "hh", " hh")
		return &excelNumberFormatSpec{CustomNumFmt: &formatted}
	case "d-mmm-yy":
		return &excelNumberFormatSpec{NumFmt: intPtr(15)}
	case "d-mmm":
		return &excelNumberFormatSpec{NumFmt: intPtr(16)}
	case "mmm-yy":
		return &excelNumberFormatSpec{NumFmt: intPtr(17)}
	case "h:mm":
		return &excelNumberFormatSpec{NumFmt: intPtr(20)}
	case "h:mm:ss":
		return &excelNumberFormatSpec{NumFmt: intPtr(21)}
	case "m/d/yyh:mm", "m/d/yyh:mm:ss":
		return &excelNumberFormatSpec{NumFmt: intPtr(22)}
	default:
		return &excelNumberFormatSpec{CustomNumFmt: &trimmed}
	}
}

func buildCurrencyNumFmt(currencyCode string, raw any) string {
	decimals := 2
	if parsed, ok := inferNumericExcelFormat(raw).CustomNumFmt, true; ok && parsed != nil {
		if dot := strings.Index(*parsed, "."); dot >= 0 {
			decimals = len((*parsed)[dot+1:])
		}
	}
	if decimals == 0 {
		decimals = 2
	}
	symbol := currencySymbol(currencyCode)
	return fmt.Sprintf("%s#,##0.%s;%s-#,##0.%s", symbol, strings.Repeat("0", decimals), symbol, strings.Repeat("0", decimals))
}

func currencySymbol(currencyCode string) string {
	switch strings.ToUpper(strings.TrimSpace(currencyCode)) {
	case "CNY", "RMB":
		return "[$¥-804]"
	case "USD":
		return "[$$-409]"
	case "EUR":
		return "[$€-2]"
	case "GBP":
		return "[$£-809]"
	case "JPY":
		return "[$¥-411]"
	case "HKD":
		return "HK$"
	case "TWD":
		return "NT$"
	default:
		if code := strings.ToUpper(strings.TrimSpace(currencyCode)); code != "" {
			return code + " "
		}
		return ""
	}
}

func parseExcelNumericValue(value string) (any, bool) {
	trimmed := strings.TrimSpace(strings.ReplaceAll(value, ",", ""))
	trimmed = strings.ReplaceAll(trimmed, "[$¥-804]", "")
	trimmed = strings.ReplaceAll(trimmed, "[$$-409]", "")
	trimmed = strings.ReplaceAll(trimmed, "￥", "")
	trimmed = strings.ReplaceAll(trimmed, "$", "")
	trimmed = strings.ReplaceAll(trimmed, "¥", "")
	if trimmed == "" {
		return nil, false
	}
	if strings.HasSuffix(trimmed, "%") {
		return parseExcelPercentValue(trimmed)
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return nil, false
	}
	if math.Abs(parsed-math.Round(parsed)) < 1e-9 {
		return int64(math.Round(parsed)), true
	}
	return parsed, true
}

func parseExcelPercentValue(value string) (any, bool) {
	trimmed := strings.TrimSpace(strings.TrimSuffix(strings.ReplaceAll(value, ",", ""), "%"))
	if trimmed == "" {
		return nil, false
	}
	parsed, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return nil, false
	}
	return parsed / 100, true
}

func parseExcelTimeValue(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	layouts := []string{
		time.RFC3339,
		"2006-01-02 15:04:05",
		"2006-01-02 15:04",
		"2006/01/02 15:04:05",
		"2006/01/02 15:04",
		"2006-01-02",
		"2006/01/02",
		"2006.01.02",
		"01/02/2006",
		"2006-1-2",
		"2006/1/2",
	}
	for _, layout := range layouts {
		if parsed, err := time.Parse(layout, trimmed); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func decimalPlacesFromFloat(value float64) int {
	text := strconv.FormatFloat(value, 'f', -1, 64)
	if dot := strings.Index(text, "."); dot >= 0 {
		return len(strings.TrimRight(text[dot+1:], "0"))
	}
	return 0
}
