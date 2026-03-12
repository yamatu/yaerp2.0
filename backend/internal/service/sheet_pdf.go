package service

import (
	"bytes"
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/phpdave11/gofpdf"
)

//go:embed assets/fonts/NotoSansSC.ttf
var sheetPDFChineseFont []byte

const sheetPDFFontFamily = "sheet-pdf-body"
const pxToMM = 0.2645833333

type sheetPDFCell struct {
	Text  string
	Style *univerStyleData
}

type sheetPDFGrid struct {
	SheetName       string
	Rows            []int
	Columns         []int
	RowHeights      map[int]float64
	ColumnWidths    map[int]float64
	Cells           map[string]sheetPDFCell
	MergeStarts     map[string]univerExportRange
	MergeCovered    map[string]bool
	ShowGridlines   bool
	DefaultFontSize float64
}

type sheetPDFLayout struct {
	Size             string
	Orientation      string
	MarginLeft       float64
	MarginTop        float64
	MarginRight      float64
	MarginBottom     float64
	Scale            float64
	ScaledColWidths  map[int]float64
	ScaledRowHeights map[int]float64
}

func (s *SheetService) BuildSheetPDFFile(userID, sheetID int64, filename string) (*sheetExportFile, error) {
	ctx, err := s.loadSheetExportContext(userID, sheetID)
	if err != nil {
		return nil, err
	}

	grid, err := s.buildSheetPDFGrid(ctx)
	if err != nil {
		return nil, err
	}
	layout := buildSheetPDFLayout(grid)

	pdf := gofpdf.New(layout.Orientation, "mm", layout.Size, "")
	pdf.SetMargins(layout.MarginLeft, layout.MarginTop, layout.MarginRight)
	pdf.SetAutoPageBreak(true, layout.MarginBottom)
	pdf.SetTitle(fmt.Sprintf("%s PDF", grid.SheetName), true)
	pdf.SetAuthor("YaERP", true)
	pdf.SetCreator("YaERP", true)

	registerSheetPDFFonts(pdf)
	if err := pdf.Error(); err != nil {
		return nil, fmt.Errorf("load pdf fonts: %w", err)
	}

	pdf.AddPage()
	if len(grid.Rows) == 0 || len(grid.Columns) == 0 {
		renderEmptySheetPDFState(pdf, layout)
	} else {
		renderSheetPDFGrid(pdf, grid, layout)
	}

	buffer := bytes.NewBuffer(nil)
	if err := pdf.Output(buffer); err != nil {
		return nil, fmt.Errorf("write pdf file: %w", err)
	}

	return &sheetExportFile{
		Filename:    normalizeSheetPDFFilename(filename, ctx.Sheet.Name, sheetID),
		ContentType: sheetPDFContentType,
		Data:        buffer.Bytes(),
	}, nil
}

func registerSheetPDFFonts(pdf *gofpdf.Fpdf) {
	pdf.AddUTF8FontFromBytes(sheetPDFFontFamily, "", sheetPDFChineseFont)
	pdf.AddUTF8FontFromBytes(sheetPDFFontFamily, "B", sheetPDFChineseFont)
	pdf.AddUTF8FontFromBytes(sheetPDFFontFamily, "I", sheetPDFChineseFont)
	pdf.AddUTF8FontFromBytes(sheetPDFFontFamily, "BI", sheetPDFChineseFont)
}

func (s *SheetService) buildSheetPDFGrid(ctx *sheetExportContext) (*sheetPDFGrid, error) {
	grid, err := s.buildSheetPDFGridFromSnapshot(ctx)
	if err != nil {
		return nil, err
	}
	if grid != nil {
		return grid, nil
	}
	return s.buildSheetPDFGridFromRows(ctx)
}

func (s *SheetService) buildSheetPDFGridFromSnapshot(ctx *sheetExportContext) (*sheetPDFGrid, error) {
	snapshot, ok, err := extractUniverExportWorksheet(ctx.Sheet.Config)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, nil
	}

	hiddenRows := map[int]bool{}
	for key, row := range snapshot.RowData {
		index, err := strconv.Atoi(key)
		if err == nil && row.Hidden == 1 {
			hiddenRows[index] = true
		}
	}

	hiddenColumns := map[int]bool{}
	for key, column := range snapshot.ColumnData {
		index, err := strconv.Atoi(key)
		if err == nil && column.Hidden == 1 {
			hiddenColumns[index] = true
		}
	}

	minRow, maxRow, minCol, maxCol, found, err := s.detectSheetPDFBounds(snapshot, ctx, hiddenRows, hiddenColumns)
	if err != nil {
		return nil, err
	}
	if !found {
		return &sheetPDFGrid{SheetName: ctx.Sheet.Name, DefaultFontSize: 10}, nil
	}

	rows := make([]int, 0, maxRow-minRow+1)
	for row := minRow; row <= maxRow; row += 1 {
		if !hiddenRows[row] {
			rows = append(rows, row)
		}
	}
	columns := make([]int, 0, maxCol-minCol+1)
	for column := minCol; column <= maxCol; column += 1 {
		if !hiddenColumns[column] {
			columns = append(columns, column)
		}
	}

	grid := &sheetPDFGrid{
		SheetName:       ctx.Sheet.Name,
		Rows:            rows,
		Columns:         columns,
		RowHeights:      buildSheetPDFRowHeights(snapshot, rows),
		ColumnWidths:    buildSheetPDFColumnWidths(snapshot, ctx.Columns, columns),
		Cells:           make(map[string]sheetPDFCell, len(rows)*max(1, len(columns))),
		MergeStarts:     make(map[string]univerExportRange),
		MergeCovered:    make(map[string]bool),
		ShowGridlines:   snapshot.ShowGridlines != 0,
		DefaultFontSize: resolveSheetPDFFontSize(resolveUniverStyle(snapshot.DefaultStyle, ctx.Styles), 10),
	}

	rowSet := make(map[int]struct{}, len(rows))
	for _, row := range rows {
		rowSet[row] = struct{}{}
	}
	colSet := make(map[int]struct{}, len(columns))
	for _, column := range columns {
		colSet[column] = struct{}{}
	}

	for _, merge := range snapshot.MergeData {
		if merge.EndRow < minRow || merge.StartRow > maxRow || merge.EndColumn < minCol || merge.StartColumn > maxCol {
			continue
		}
		if _, ok := rowSet[merge.StartRow]; !ok {
			continue
		}
		if _, ok := colSet[merge.StartColumn]; !ok {
			continue
		}
		grid.MergeStarts[sheetPDFCellKey(merge.StartRow, merge.StartColumn)] = merge
		for row := merge.StartRow; row <= merge.EndRow; row += 1 {
			if _, ok := rowSet[row]; !ok {
				continue
			}
			for column := merge.StartColumn; column <= merge.EndColumn; column += 1 {
				if row == merge.StartRow && column == merge.StartColumn {
					continue
				}
				if _, ok := colSet[column]; ok {
					grid.MergeCovered[sheetPDFCellKey(row, column)] = true
				}
			}
		}
	}

	for _, row := range rows {
		rowMeta := snapshot.RowData[strconv.Itoa(row)]
		for _, column := range columns {
			columnMeta := snapshot.ColumnData[strconv.Itoa(column)]
			cell := snapshot.CellData[strconv.Itoa(row)][strconv.Itoa(column)]
			style := composeUniverStyles(ctx.Styles, snapshot.DefaultStyle, rowMeta.Style, columnMeta.Style, cell.Style)
			text := exportUniverCellText(cell)

			if row > 0 && column < len(ctx.Columns) {
				allowed := permissionMatrixAllowsCell(ctx.Matrix, ctx.Columns[column].Key, row-1, "read")
				if !allowed {
					text = ""
				}
			}

			grid.Cells[sheetPDFCellKey(row, column)] = sheetPDFCell{Text: text, Style: style}
		}
	}

	return grid, nil
}

func (s *SheetService) detectSheetPDFBounds(snapshot *univerExportWorksheet, ctx *sheetExportContext, hiddenRows, hiddenColumns map[int]bool) (int, int, int, int, bool, error) {
	minRow, maxRow := 0, 0
	minCol, maxCol := 0, 0
	found := false

	for rowKey, rowCells := range snapshot.CellData {
		rowIndex, err := strconv.Atoi(rowKey)
		if err != nil || rowIndex < 0 || hiddenRows[rowIndex] {
			continue
		}

		rowMeta := snapshot.RowData[rowKey]
		for colKey, cell := range rowCells {
			colIndex, err := strconv.Atoi(colKey)
			if err != nil || colIndex < 0 || hiddenColumns[colIndex] {
				continue
			}

			if rowIndex > 0 && colIndex < len(ctx.Columns) {
				allowed := permissionMatrixAllowsCell(ctx.Matrix, ctx.Columns[colIndex].Key, rowIndex-1, "read")
				if !allowed {
					continue
				}
			}

			columnMeta := snapshot.ColumnData[colKey]
			style := composeUniverStyles(ctx.Styles, snapshot.DefaultStyle, rowMeta.Style, columnMeta.Style, cell.Style)
			if exportCellHasContent(cell) || isMeaningfulUniverStyle(style) {
				minRow, maxRow, minCol, maxCol, found = extendSheetPDFBounds(minRow, maxRow, minCol, maxCol, rowIndex, colIndex, found)
			}
		}
	}

	for _, merge := range snapshot.MergeData {
		if hiddenRows[merge.StartRow] || hiddenColumns[merge.StartColumn] {
			continue
		}
		startCell := snapshot.CellData[strconv.Itoa(merge.StartRow)][strconv.Itoa(merge.StartColumn)]
		rowMeta := snapshot.RowData[strconv.Itoa(merge.StartRow)]
		columnMeta := snapshot.ColumnData[strconv.Itoa(merge.StartColumn)]
		style := composeUniverStyles(ctx.Styles, snapshot.DefaultStyle, rowMeta.Style, columnMeta.Style, startCell.Style)
		if exportCellHasContent(startCell) || isMeaningfulUniverStyle(style) {
			minRow, maxRow, minCol, maxCol, found = extendSheetPDFBounds(minRow, maxRow, minCol, maxCol, merge.StartRow, merge.StartColumn, found)
			minRow, maxRow, minCol, maxCol, found = extendSheetPDFBounds(minRow, maxRow, minCol, maxCol, merge.EndRow, merge.EndColumn, found)
		}
	}

	return minRow, maxRow, minCol, maxCol, found, nil
}

func (s *SheetService) buildSheetPDFGridFromRows(ctx *sheetExportContext) (*sheetPDFGrid, error) {
	rows, err := s.sheetRepo.GetRows(ctx.Sheet.ID)
	if err != nil {
		return nil, err
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].RowIndex == rows[j].RowIndex {
			return rows[i].ID < rows[j].ID
		}
		return rows[i].RowIndex < rows[j].RowIndex
	})

	usedColumns := map[int]struct{}{}
	parsedRows := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		data := map[string]any{}
		if len(row.Data) > 0 {
			if err := json.Unmarshal(row.Data, &data); err != nil {
				return nil, fmt.Errorf("parse sheet row %d: %w", row.RowIndex, err)
			}
		}
		parsedRows = append(parsedRows, data)
		for index, column := range ctx.Columns {
			allowed := permissionMatrixAllowsCell(ctx.Matrix, column.Key, row.RowIndex, "read")
			if !allowed {
				continue
			}
			if strings.TrimSpace(exportAnyCellText(data[column.Key])) != "" {
				usedColumns[index] = struct{}{}
			}
		}
	}

	visibleColumns := sortedExportColumns(usedColumns)
	if len(visibleColumns) == 0 {
		visibleColumns = buildFallbackExportColumns(ctx.Columns)
	}

	grid := &sheetPDFGrid{
		SheetName:       ctx.Sheet.Name,
		Rows:            make([]int, 0, len(parsedRows)),
		Columns:         visibleColumns,
		RowHeights:      make(map[int]float64, len(parsedRows)),
		ColumnWidths:    make(map[int]float64, len(visibleColumns)),
		Cells:           make(map[string]sheetPDFCell, len(parsedRows)*max(1, len(visibleColumns))),
		MergeStarts:     make(map[string]univerExportRange),
		MergeCovered:    make(map[string]bool),
		ShowGridlines:   true,
		DefaultFontSize: 10,
	}

	for _, column := range visibleColumns {
		width := 140.0
		if column < len(ctx.Columns) && ctx.Columns[column].Width > 0 {
			width = float64(ctx.Columns[column].Width)
		}
		grid.ColumnWidths[column] = width * pxToMM
	}

	for rowIndex, data := range parsedRows {
		visible := false
		for _, column := range visibleColumns {
			columnKey := ""
			if column < len(ctx.Columns) {
				columnKey = ctx.Columns[column].Key
			}
			text := exportAnyCellText(data[columnKey])
			if strings.TrimSpace(text) != "" {
				visible = true
			}
			grid.Cells[sheetPDFCellKey(rowIndex, column)] = sheetPDFCell{Text: text}
		}
		if visible {
			grid.Rows = append(grid.Rows, rowIndex)
			grid.RowHeights[rowIndex] = 28 * pxToMM
		}
	}

	return grid, nil
}

func extractUniverExportWorksheet(config json.RawMessage) (*univerExportWorksheet, bool, error) {
	if len(config) == 0 {
		return nil, false, nil
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, false, fmt.Errorf("parse sheet config: %w", err)
	}

	rawSheet, ok := payload["univerSheetData"]
	if !ok || len(rawSheet) == 0 || string(rawSheet) == "null" {
		return nil, false, nil
	}

	var snapshot univerExportWorksheet
	if err := json.Unmarshal(rawSheet, &snapshot); err != nil {
		return nil, false, fmt.Errorf("parse univer sheet data: %w", err)
	}

	return &snapshot, true, nil
}

func buildSheetPDFRowHeights(snapshot *univerExportWorksheet, rows []int) map[int]float64 {
	result := make(map[int]float64, len(rows))
	defaultHeight := snapshot.DefaultRowHeight
	if defaultHeight <= 0 {
		defaultHeight = 28
	}
	for _, row := range rows {
		height := defaultHeight
		if meta, ok := snapshot.RowData[strconv.Itoa(row)]; ok {
			if meta.AutoHeight > 0 {
				height = meta.AutoHeight
			} else if meta.Height > 0 {
				height = meta.Height
			}
		}
		result[row] = math.Max(5.8, height*pxToMM)
	}
	return result
}

func buildSheetPDFColumnWidths(snapshot *univerExportWorksheet, columns []sheetColumnPayload, visible []int) map[int]float64 {
	result := make(map[int]float64, len(visible))
	defaultWidth := snapshot.DefaultColumnWidth
	if defaultWidth <= 0 {
		defaultWidth = 140
	}
	for _, column := range visible {
		width := defaultWidth
		if meta, ok := snapshot.ColumnData[strconv.Itoa(column)]; ok && meta.Width > 0 {
			width = meta.Width
		} else if column < len(columns) && columns[column].Width > 0 {
			width = float64(columns[column].Width)
		}
		result[column] = math.Max(8, width*pxToMM)
	}
	return result
}

func buildSheetPDFLayout(grid *sheetPDFGrid) sheetPDFLayout {
	totalWidth := 0.0
	for _, column := range grid.Columns {
		totalWidth += grid.ColumnWidths[column]
	}

	candidates := []struct {
		Size        string
		Orientation string
		Width       float64
		Height      float64
	}{
		{Size: "A4", Orientation: "P", Width: 210, Height: 297},
		{Size: "A4", Orientation: "L", Width: 297, Height: 210},
		{Size: "A3", Orientation: "L", Width: 420, Height: 297},
	}

	chosen := candidates[len(candidates)-1]
	scale := 1.0
	for _, candidate := range candidates {
		available := candidate.Width - 16
		if totalWidth <= available {
			chosen = candidate
			scale = 1
			break
		}
		candidateScale := available / math.Max(totalWidth, 1)
		if candidateScale >= 0.62 {
			chosen = candidate
			scale = candidateScale
			break
		}
	}
	if totalWidth > chosen.Width-16 {
		scale = (chosen.Width - 16) / math.Max(totalWidth, 1)
	}
	if scale > 1 {
		scale = 1
	}
	if scale < 0.5 {
		scale = 0.5
	}

	layout := sheetPDFLayout{
		Size:             chosen.Size,
		Orientation:      chosen.Orientation,
		MarginLeft:       8,
		MarginTop:        8,
		MarginRight:      8,
		MarginBottom:     8,
		Scale:            scale,
		ScaledColWidths:  make(map[int]float64, len(grid.Columns)),
		ScaledRowHeights: make(map[int]float64, len(grid.Rows)),
	}
	for _, column := range grid.Columns {
		layout.ScaledColWidths[column] = grid.ColumnWidths[column] * scale
	}
	for _, row := range grid.Rows {
		layout.ScaledRowHeights[row] = math.Max(3.6, grid.RowHeights[row]*scale)
	}
	return layout
}

func renderSheetPDFGrid(pdf *gofpdf.Fpdf, grid *sheetPDFGrid, layout sheetPDFLayout) {
	for _, row := range grid.Rows {
		rowHeight := layout.ScaledRowHeights[row]
		if shouldAddSheetPDFPage(pdf, layout, rowHeight) {
			pdf.AddPage()
		}

		x := layout.MarginLeft
		y := pdf.GetY()
		for _, column := range grid.Columns {
			key := sheetPDFCellKey(row, column)
			if grid.MergeCovered[key] {
				x += layout.ScaledColWidths[column]
				continue
			}

			width := layout.ScaledColWidths[column]
			height := rowHeight
			if merge, ok := grid.MergeStarts[key]; ok {
				width = sumSheetPDFMergeWidth(layout, grid, merge)
				height = sumSheetPDFMergeHeight(layout, grid, merge)
			}

			cell := grid.Cells[key]
			drawSheetPDFCell(pdf, x, y, width, height, cell, layout, grid.ShowGridlines)
			x += layout.ScaledColWidths[column]
		}

		pdf.SetY(y + rowHeight)
	}
}

func renderEmptySheetPDFState(pdf *gofpdf.Fpdf, layout sheetPDFLayout) {
	pageWidth, _ := pdf.GetPageSize()
	width := pageWidth - layout.MarginLeft - layout.MarginRight
	y := layout.MarginTop + 12
	pdf.SetFillColor(248, 250, 252)
	pdf.SetDrawColor(226, 232, 240)
	pdf.RoundedRect(layout.MarginLeft, y, width, 20, 2.5, "1234", "DF")
	pdf.SetTextColor(51, 65, 85)
	pdf.SetFont(sheetPDFFontFamily, "B", 12)
	pdf.SetXY(layout.MarginLeft, y+5)
	pdf.CellFormat(width, 5, "当前工作表暂无可导出的内容", "", 0, "C", false, 0, "")
	pdf.SetFont(sheetPDFFontFamily, "", 9)
	pdf.SetTextColor(100, 116, 139)
	pdf.SetXY(layout.MarginLeft+6, y+11)
	pdf.CellFormat(width-12, 4.5, "可以先在表格中录入数据，或确认当前账号对可见列具备导出权限。", "", 0, "C", false, 0, "")
}

func drawSheetPDFCell(pdf *gofpdf.Fpdf, x, y, width, height float64, cell sheetPDFCell, layout sheetPDFLayout, showGridlines bool) {
	style := cell.Style
	fillR, fillG, fillB := 255, 255, 255
	if r, g, b, ok := parseUniverColor(styleColor(style, "bg")); ok {
		fillR, fillG, fillB = r, g, b
	}
	pdf.SetFillColor(fillR, fillG, fillB)
	pdf.Rect(x, y, width, height, "F")

	drawSheetPDFCellBorders(pdf, x, y, width, height, style, layout.Scale, showGridlines)
	drawSheetPDFCellText(pdf, x, y, width, height, cell.Text, style, layout)
}

func drawSheetPDFCellBorders(pdf *gofpdf.Fpdf, x, y, width, height float64, style *univerStyleData, scale float64, showGridlines bool) {
	if showGridlines {
		pdf.SetDrawColor(226, 232, 240)
		pdf.SetLineWidth(0.15 * scale)
		pdf.Rect(x, y, width, height, "D")
	}

	if style == nil || style.Bd == nil {
		return
	}

	drawSheetPDFBorderSide(pdf, x, y, x+width, y, style.Bd.T, scale)
	drawSheetPDFBorderSide(pdf, x+width, y, x+width, y+height, style.Bd.R, scale)
	drawSheetPDFBorderSide(pdf, x, y+height, x+width, y+height, style.Bd.B, scale)
	drawSheetPDFBorderSide(pdf, x, y, x, y+height, style.Bd.L, scale)
}

func drawSheetPDFBorderSide(pdf *gofpdf.Fpdf, x1, y1, x2, y2 float64, border *univerBorderStyleData, scale float64) {
	if border == nil || border.S == nil || *border.S == 0 {
		return
	}
	r, g, b := 71, 85, 105
	if cr, cg, cb, ok := parseUniverColor(border.CL); ok {
		r, g, b = cr, cg, cb
	}
	pdf.SetDrawColor(r, g, b)
	pdf.SetLineWidth(sheetPDFBorderWidth(*border.S) * scale)
	pdf.Line(x1, y1, x2, y2)
}

func drawSheetPDFCellText(pdf *gofpdf.Fpdf, x, y, width, height float64, text string, style *univerStyleData, layout sheetPDFLayout) {
	fontSize := resolveSheetPDFFontSize(style, 10) * layout.Scale
	if fontSize < 6.2 {
		fontSize = 6.2
	}
	fontStyle := resolveSheetPDFFontStyle(style)
	pdf.SetFont(sheetPDFFontFamily, fontStyle, fontSize)

	r, g, b := 15, 23, 42
	if cr, cg, cb, ok := parseUniverColor(styleColor(style, "cl")); ok {
		r, g, b = cr, cg, cb
	}
	pdf.SetTextColor(r, g, b)

	padLeft, padTop, padRight, padBottom := resolveSheetPDFPadding(style, layout.Scale)
	innerWidth := math.Max(2, width-padLeft-padRight)
	innerHeight := math.Max(2, height-padTop-padBottom)
	lineHeight := math.Max(2.6, fontSize*0.36+0.8*layout.Scale)
	wrap := shouldWrapSheetPDFText(style, text)
	lines := formatSheetPDFLines(pdf, text, innerWidth, wrap)
	maxLines := max(1, int(math.Floor(innerHeight/lineHeight)))
	if len(lines) > maxLines {
		lines = lines[:maxLines]
		lastIndex := len(lines) - 1
		lines[lastIndex] = clipSheetPDFText(pdf, lines[lastIndex], innerWidth)
	}

	contentHeight := float64(len(lines)) * lineHeight
	startY := y + padTop
	switch resolveSheetPDFVerticalAlign(style) {
	case 2:
		startY = y + (height-contentHeight)/2
	case 3:
		startY = y + height - padBottom - contentHeight
	}

	align := resolveSheetPDFHorizontalAlign(style)
	for index, line := range lines {
		pdf.SetXY(x+padLeft, startY+float64(index)*lineHeight)
		pdf.CellFormat(innerWidth, lineHeight, line, "", 0, align, false, 0, "")
	}
}

func shouldAddSheetPDFPage(pdf *gofpdf.Fpdf, layout sheetPDFLayout, nextRowHeight float64) bool {
	_, pageHeight := pdf.GetPageSize()
	_, _, _, bottom := pdf.GetMargins()
	return pdf.GetY()+nextRowHeight > pageHeight-bottom
}

func sumSheetPDFMergeWidth(layout sheetPDFLayout, grid *sheetPDFGrid, merge univerExportRange) float64 {
	total := 0.0
	for _, column := range grid.Columns {
		if column >= merge.StartColumn && column <= merge.EndColumn {
			total += layout.ScaledColWidths[column]
		}
	}
	return total
}

func sumSheetPDFMergeHeight(layout sheetPDFLayout, grid *sheetPDFGrid, merge univerExportRange) float64 {
	total := 0.0
	for _, row := range grid.Rows {
		if row >= merge.StartRow && row <= merge.EndRow {
			total += layout.ScaledRowHeights[row]
		}
	}
	return total
}

func resolveSheetPDFFontSize(style *univerStyleData, fallback float64) float64 {
	if style != nil && style.FS != nil && *style.FS > 0 {
		return *style.FS
	}
	return fallback
}

func resolveSheetPDFFontStyle(style *univerStyleData) string {
	if style == nil {
		return ""
	}
	parts := make([]string, 0, 3)
	if style.Bl != nil && *style.Bl == 1 {
		parts = append(parts, "B")
	}
	if style.It != nil && *style.It == 1 {
		parts = append(parts, "I")
	}
	if style.Ul != nil && style.Ul.S != nil && *style.Ul.S == 1 {
		parts = append(parts, "U")
	}
	return strings.Join(parts, "")
}

func resolveSheetPDFPadding(style *univerStyleData, scale float64) (float64, float64, float64, float64) {
	left := 1.5 * scale
	top := 1.2 * scale
	right := 1.5 * scale
	bottom := 1.2 * scale
	if style != nil && style.Pd != nil {
		if style.Pd.L != nil {
			left = math.Max(0.6, *style.Pd.L*pxToMM*scale)
		}
		if style.Pd.T != nil {
			top = math.Max(0.4, *style.Pd.T*pxToMM*scale)
		}
		if style.Pd.R != nil {
			right = math.Max(0.6, *style.Pd.R*pxToMM*scale)
		}
		if style.Pd.B != nil {
			bottom = math.Max(0.4, *style.Pd.B*pxToMM*scale)
		}
	}
	return left, top, right, bottom
}

func resolveSheetPDFHorizontalAlign(style *univerStyleData) string {
	if style == nil || style.Ht == nil {
		return "L"
	}
	switch *style.Ht {
	case 2:
		return "C"
	case 3:
		return "R"
	default:
		return "L"
	}
}

func resolveSheetPDFVerticalAlign(style *univerStyleData) int {
	if style == nil || style.Vt == nil {
		return 1
	}
	return *style.Vt
}

func shouldWrapSheetPDFText(style *univerStyleData, text string) bool {
	if strings.Contains(text, "\n") {
		return true
	}
	if style == nil || style.Tb == nil {
		return false
	}
	return *style.Tb == 3
}

func formatSheetPDFLines(pdf *gofpdf.Fpdf, text string, width float64, wrap bool) []string {
	cleaned := strings.ReplaceAll(text, "\r", "")
	if strings.TrimSpace(cleaned) == "" {
		return []string{""}
	}
	paragraphs := strings.Split(cleaned, "\n")
	lines := make([]string, 0, len(paragraphs))
	for _, paragraph := range paragraphs {
		if !wrap {
			lines = append(lines, clipSheetPDFText(pdf, paragraph, width))
			continue
		}
		for _, line := range wrapSheetPDFText(pdf, paragraph, width) {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func wrapSheetPDFText(pdf *gofpdf.Fpdf, text string, width float64) []string {
	if strings.TrimSpace(text) == "" {
		return []string{""}
	}
	segments := strings.FieldsFunc(text, func(r rune) bool { return r == '\n' })
	if len(segments) == 0 {
		segments = []string{text}
	}
	lines := make([]string, 0, len(segments))
	for _, segment := range segments {
		current := ""
		for _, r := range segment {
			candidate := current + string(r)
			if current != "" && pdf.GetStringWidth(candidate) > width {
				lines = append(lines, current)
				current = string(r)
				continue
			}
			current = candidate
		}
		if current != "" {
			lines = append(lines, current)
		}
	}
	if len(lines) == 0 {
		return []string{""}
	}
	return lines
}

func clipSheetPDFText(pdf *gofpdf.Fpdf, text string, width float64) string {
	if pdf.GetStringWidth(text) <= width {
		return text
	}
	trimmed := text
	for len(trimmed) > 0 && pdf.GetStringWidth(trimmed+"…") > width {
		_, size := utf8.DecodeLastRuneInString(trimmed)
		trimmed = trimmed[:len(trimmed)-size]
	}
	if trimmed == "" {
		return ""
	}
	return trimmed + "…"
}

func sheetPDFBorderWidth(styleType int) float64 {
	switch styleType {
	case 13:
		return 0.9
	case 7, 8, 9, 10, 11, 12:
		return 0.55
	default:
		return 0.3
	}
}

func styleColor(style *univerStyleData, kind string) *univerColorStyle {
	if style == nil {
		return nil
	}
	switch kind {
	case "bg":
		return style.Bg
	case "cl":
		return style.Cl
	default:
		return nil
	}
}

func extendSheetPDFBounds(minRow, maxRow, minCol, maxCol, row, col int, found bool) (int, int, int, int, bool) {
	if !found {
		return row, row, col, col, true
	}
	if row < minRow {
		minRow = row
	}
	if row > maxRow {
		maxRow = row
	}
	if col < minCol {
		minCol = col
	}
	if col > maxCol {
		maxCol = col
	}
	return minRow, maxRow, minCol, maxCol, true
}

func sheetPDFCellKey(row, column int) string {
	return fmt.Sprintf("%d:%d", row, column)
}

func exportUniverCellText(cell univerExportCell) string {
	value := exportAnyCellText(cell.Value)
	if strings.TrimSpace(value) != "" {
		return value
	}
	return strings.TrimSpace(cell.Formula)
}

func exportAnyCellText(value any) string {
	switch typed := normalizeSheetPDFValue(value).(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(typed)
	case float64:
		if math.Abs(typed-math.Round(typed)) < 1e-9 {
			return strconv.FormatInt(int64(math.Round(typed)), 10)
		}
		return strconv.FormatFloat(typed, 'f', -1, 64)
	case float32:
		return strconv.FormatFloat(float64(typed), 'f', -1, 64)
	case int:
		return strconv.Itoa(typed)
	case int32:
		return strconv.FormatInt(int64(typed), 10)
	case int64:
		return strconv.FormatInt(typed, 10)
	case uint:
		return strconv.FormatUint(uint64(typed), 10)
	case uint32:
		return strconv.FormatUint(uint64(typed), 10)
	case uint64:
		return strconv.FormatUint(typed, 10)
	case bool:
		if typed {
			return "TRUE"
		}
		return "FALSE"
	case json.Number:
		return typed.String()
	default:
		encoded, err := json.Marshal(typed)
		if err != nil {
			return fmt.Sprint(typed)
		}
		return string(encoded)
	}
}

func normalizeSheetPDFValue(value any) any {
	if value == nil {
		return nil
	}
	data, ok := value.(map[string]any)
	if !ok {
		return value
	}
	if raw, exists := data["value"]; exists {
		return raw
	}
	if formula, ok := data["formula"].(string); ok && strings.TrimSpace(formula) != "" {
		return formula
	}
	if raw, exists := data["v"]; exists {
		return raw
	}
	if formula, ok := data["f"].(string); ok && strings.TrimSpace(formula) != "" {
		return formula
	}
	return value
}
