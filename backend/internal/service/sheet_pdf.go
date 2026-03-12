package service

import (
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"html"
	"os"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

//go:embed assets/fonts/NotoSansSC.ttf
var sheetPDFChineseFont []byte

var sheetPDFFontBase64 = base64.StdEncoding.EncodeToString(sheetPDFChineseFont)

const sheetPDFBaseFontFamily = "YaERPPDF"
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
	CSSPageSize string
	PageWidthMM float64
	MarginMM    float64
	Scale       float64
	TotalWidth  float64
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
	htmlDoc := renderSheetPDFHTML(grid, layout)

	pdfBytes, err := renderSheetPDFWithChromium(htmlDoc, layout)
	if err != nil {
		return nil, err
	}

	return &sheetExportFile{
		Filename:    normalizeSheetPDFFilename(filename, ctx.Sheet.Name, sheetID),
		ContentType: sheetPDFContentType,
		Data:        pdfBytes,
	}, nil
}

func renderSheetPDFWithChromium(htmlDoc string, layout sheetPDFLayout) ([]byte, error) {
	chromePath, err := findChromiumExecutable()
	if err != nil {
		return nil, err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()

	allocatorOptions := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(chromePath),
		chromedp.NoSandbox,
		chromedp.DisableGPU,
		chromedp.Flag("disable-dev-shm-usage", true),
		chromedp.Flag("disable-software-rasterizer", true),
		chromedp.Flag("font-render-hinting", "medium"),
		chromedp.Flag("force-color-profile", "srgb"),
	)

	allocCtx, cancelAlloc := chromedp.NewExecAllocator(ctx, allocatorOptions...)
	defer cancelAlloc()

	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()

	var pdfData []byte
	err = chromedp.Run(browserCtx,
		chromedp.Navigate("about:blank"),
		chromedp.ActionFunc(func(ctx context.Context) error {
			frameTree, err := page.GetFrameTree().Do(ctx)
			if err != nil {
				return fmt.Errorf("load chromium frame tree: %w", err)
			}
			return page.SetDocumentContent(frameTree.Frame.ID, htmlDoc).Do(ctx)
		}),
		chromedp.ActionFunc(waitForPrintableDocument),
		chromedp.ActionFunc(func(ctx context.Context) error {
			data, _, err := page.PrintToPDF().
				WithPrintBackground(true).
				WithDisplayHeaderFooter(false).
				WithPreferCSSPageSize(true).
				WithScale(layout.Scale).
				WithMarginTop(0).
				WithMarginBottom(0).
				WithMarginLeft(0).
				WithMarginRight(0).
				Do(ctx)
			if err != nil {
				return fmt.Errorf("print chromium pdf: %w", err)
			}
			pdfData = append([]byte(nil), data...)
			return nil
		}),
	)
	if err != nil {
		return nil, err
	}

	return pdfData, nil
}

func waitForPrintableDocument(ctx context.Context) error {
	script := `(async () => {
		if (document.readyState !== 'complete') {
			await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }))
		}
		if (document.fonts && document.fonts.ready) {
			await document.fonts.ready
		}
		await new Promise((resolve) => setTimeout(resolve, 120))
		return true
	})()`
	_, exp, err := runtime.Evaluate(script).WithAwaitPromise(true).Do(ctx)
	if err != nil {
		return err
	}
	if exp != nil {
		return fmt.Errorf("printable document not ready")
	}
	return nil
}

func findChromiumExecutable() (string, error) {
	for _, envKey := range []string{"CHROME_PATH", "CHROMIUM_PATH", "CHROME_BIN"} {
		if value := strings.TrimSpace(os.Getenv(envKey)); value != "" {
			if resolved, err := exec.LookPath(value); err == nil {
				return resolved, nil
			}
		}
	}

	for _, candidate := range []string{"chromium-browser", "chromium", "google-chrome", "google-chrome-stable", "/usr/bin/chromium-browser", "/usr/bin/chromium"} {
		if resolved, err := exec.LookPath(candidate); err == nil {
			return resolved, nil
		}
	}

	return "", fmt.Errorf("chromium executable not found, please install chromium or set CHROME_PATH")
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
		result[row] = max(5.8, height*pxToMM)
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
		result[column] = max(8, width*pxToMM)
	}
	return result
}

func resolveSheetPDFFontSize(style *univerStyleData, fallback float64) float64 {
	if style != nil && style.FS != nil && *style.FS > 0 {
		return *style.FS
	}
	return fallback
}

func buildSheetPDFLayout(grid *sheetPDFGrid) sheetPDFLayout {
	totalWidth := 0.0
	for _, column := range grid.Columns {
		totalWidth += grid.ColumnWidths[column]
	}
	if totalWidth <= 0 {
		totalWidth = 120
	}

	candidates := []struct {
		css       string
		pageWidth float64
	}{
		{css: "A4 portrait", pageWidth: 210},
		{css: "A4 landscape", pageWidth: 297},
		{css: "A3 landscape", pageWidth: 420},
	}

	margin := 8.0
	chosen := candidates[len(candidates)-1]
	scale := 1.0
	for _, candidate := range candidates {
		available := candidate.pageWidth - margin*2
		candidateScale := available / totalWidth
		if totalWidth <= available {
			chosen = candidate
			scale = 1
			break
		}
		if candidateScale >= 0.68 {
			chosen = candidate
			scale = candidateScale
			break
		}
	}
	if scale > 1 {
		scale = 1
	}
	if scale < 0.55 {
		scale = 0.55
	}

	return sheetPDFLayout{
		CSSPageSize: chosen.css,
		PageWidthMM: chosen.pageWidth,
		MarginMM:    margin,
		Scale:       scale,
		TotalWidth:  totalWidth,
	}
}

func renderSheetPDFHTML(grid *sheetPDFGrid, layout sheetPDFLayout) string {
	var builder strings.Builder
	builder.Grow(64 * 1024)

	builder.WriteString("<!DOCTYPE html><html><head><meta charset=\"utf-8\" /><style>")
	builder.WriteString("@font-face{font-family:'" + sheetPDFBaseFontFamily + "';src:url(data:font/ttf;base64,")
	builder.WriteString(sheetPDFFontBase64)
	builder.WriteString(") format('truetype');font-weight:100 900;font-style:normal;}\n")
	builder.WriteString(fmt.Sprintf("@page{size:%s;margin:%.2fmm;}\n", layout.CSSPageSize, layout.MarginMM))
	builder.WriteString("html,body{margin:0;padding:0;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact;}\n")
	builder.WriteString("body{font-family:'" + sheetPDFBaseFontFamily + "','Noto Sans SC','Microsoft YaHei',sans-serif;color:#0f172a;}\n")
	builder.WriteString(fmt.Sprintf("table{border-collapse:collapse;table-layout:fixed;width:%.2fmm;}\n", layout.TotalWidth))
	builder.WriteString("td{box-sizing:border-box;overflow:hidden;line-height:1.35;}\n")
	builder.WriteString(".empty{padding:12mm 8mm;border:1px solid #cbd5e1;border-radius:3mm;background:#f8fafc;text-align:center;color:#475569;font-size:12px;}\n")
	builder.WriteString("</style></head><body>")

	if len(grid.Rows) == 0 || len(grid.Columns) == 0 {
		builder.WriteString("<div class=\"empty\">当前工作表暂无可导出的内容</div></body></html>")
		return builder.String()
	}

	builder.WriteString("<table><colgroup>")
	for _, column := range grid.Columns {
		builder.WriteString(fmt.Sprintf("<col style=\"width:%.2fmm\" />", grid.ColumnWidths[column]))
	}
	builder.WriteString("</colgroup><tbody>")

	for _, row := range grid.Rows {
		builder.WriteString(fmt.Sprintf("<tr style=\"height:%.2fmm\">", grid.RowHeights[row]))
		for _, column := range grid.Columns {
			cellKey := sheetPDFCellKey(row, column)
			if grid.MergeCovered[cellKey] {
				continue
			}

			attrs := ""
			if merge, ok := grid.MergeStarts[cellKey]; ok {
				rowSpan := sheetPDFVisibleRowSpan(grid, merge)
				colSpan := sheetPDFVisibleColSpan(grid, merge)
				if rowSpan > 1 {
					attrs += fmt.Sprintf(" rowspan=\"%d\"", rowSpan)
				}
				if colSpan > 1 {
					attrs += fmt.Sprintf(" colspan=\"%d\"", colSpan)
				}
			}

			cell := grid.Cells[cellKey]
			builder.WriteString("<td")
			builder.WriteString(attrs)
			builder.WriteString(" style=\"")
			builder.WriteString(buildSheetPDFCellCSS(cell.Style, grid.ShowGridlines, grid.DefaultFontSize))
			builder.WriteString("\">")
			builder.WriteString(renderSheetPDFCellHTML(cell.Text))
			builder.WriteString("</td>")
		}
		builder.WriteString("</tr>")
	}

	builder.WriteString("</tbody></table></body></html>")
	return builder.String()
}

func buildSheetPDFCellCSS(style *univerStyleData, showGridlines bool, defaultFontSize float64) string {
	parts := []string{"position:relative", "font-family:'" + sheetPDFBaseFontFamily + "','Noto Sans SC','Microsoft YaHei',sans-serif", "padding:4px 6px", "vertical-align:top", "text-align:left", "white-space:pre-wrap", "overflow-wrap:anywhere"}
	if showGridlines {
		parts = append(parts, "border:1px solid #dbe3ec")
	} else {
		parts = append(parts, "border:none")
	}

	fontSize := defaultFontSize
	if style != nil && style.FS != nil && *style.FS > 0 {
		fontSize = *style.FS
	}
	parts = append(parts, fmt.Sprintf("font-size:%.2fpx", fontSize))

	if style != nil {
		if style.FF != nil && strings.TrimSpace(*style.FF) != "" {
			parts = append(parts, "font-family:'"+escapeCSSString(strings.TrimSpace(strings.Split(*style.FF, ",")[0]))+"','"+sheetPDFBaseFontFamily+"','Microsoft YaHei',sans-serif")
		}
		if style.Bl != nil && *style.Bl == 1 {
			parts = append(parts, "font-weight:700")
		}
		if style.It != nil && *style.It == 1 {
			parts = append(parts, "font-style:italic")
		}
		decorations := make([]string, 0, 2)
		if style.Ul != nil && style.Ul.S != nil && *style.Ul.S == 1 {
			decorations = append(decorations, "underline")
		}
		if style.St != nil && style.St.S != nil && *style.St.S == 1 {
			decorations = append(decorations, "line-through")
		}
		if len(decorations) > 0 {
			parts = append(parts, "text-decoration:"+strings.Join(decorations, " "))
		}
		if r, g, b, ok := parseUniverColor(style.Cl); ok {
			parts = append(parts, "color:"+cssRGBString(r, g, b))
		}
		if r, g, b, ok := parseUniverColor(style.Bg); ok {
			parts = append(parts, "background:"+cssRGBString(r, g, b))
		}
		if style.Ht != nil {
			switch *style.Ht {
			case 2:
				parts = append(parts, "text-align:center")
			case 3:
				parts = append(parts, "text-align:right")
			default:
				parts = append(parts, "text-align:left")
			}
		}
		if style.Vt != nil {
			switch *style.Vt {
			case 2:
				parts = append(parts, "vertical-align:middle")
			case 3:
				parts = append(parts, "vertical-align:bottom")
			default:
				parts = append(parts, "vertical-align:top")
			}
		}
		if style.Tb != nil && *style.Tb != 3 {
			parts = append(parts, "white-space:pre")
		}
		if style.Pd != nil {
			parts = append(parts, fmt.Sprintf("padding:%s %s %s %s",
				cssPaddingValue(style.Pd.T, 4),
				cssPaddingValue(style.Pd.R, 6),
				cssPaddingValue(style.Pd.B, 4),
				cssPaddingValue(style.Pd.L, 6),
			))
		}
		if style.Bd != nil {
			if border := cssBorderValue(style.Bd.T); border != "" {
				parts = append(parts, "border-top:"+border)
			}
			if border := cssBorderValue(style.Bd.R); border != "" {
				parts = append(parts, "border-right:"+border)
			}
			if border := cssBorderValue(style.Bd.B); border != "" {
				parts = append(parts, "border-bottom:"+border)
			}
			if border := cssBorderValue(style.Bd.L); border != "" {
				parts = append(parts, "border-left:"+border)
			}
		}
	}

	return strings.Join(parts, ";")
}

func renderSheetPDFCellHTML(text string) string {
	escaped := html.EscapeString(text)
	escaped = strings.ReplaceAll(escaped, "\n", "<br />")
	if strings.TrimSpace(text) == "" {
		return "&nbsp;"
	}
	return escaped
}

func sheetPDFVisibleRowSpan(grid *sheetPDFGrid, merge univerExportRange) int {
	count := 0
	for _, row := range grid.Rows {
		if row >= merge.StartRow && row <= merge.EndRow {
			count += 1
		}
	}
	return max(1, count)
}

func sheetPDFVisibleColSpan(grid *sheetPDFGrid, merge univerExportRange) int {
	count := 0
	for _, column := range grid.Columns {
		if column >= merge.StartColumn && column <= merge.EndColumn {
			count += 1
		}
	}
	return max(1, count)
}

func cssPaddingValue(value *float64, fallback float64) string {
	if value == nil {
		return fmt.Sprintf("%.1fpx", fallback)
	}
	return fmt.Sprintf("%.1fpx", *value)
}

func cssBorderValue(border *univerBorderStyleData) string {
	if border == nil || border.S == nil || *border.S == 0 {
		return ""
	}
	width, style := cssBorderStyle(*border.S)
	color := "#64748b"
	if r, g, b, ok := parseUniverColor(border.CL); ok {
		color = cssRGBString(r, g, b)
	}
	return fmt.Sprintf("%.2fpx %s %s", width, style, color)
}

func cssBorderStyle(styleCode int) (float64, string) {
	switch styleCode {
	case 13:
		return 2.2, "dashed"
	case 12:
		return 1.5, "dashed"
	case 11:
		return 1.2, "dashed"
	case 10:
		return 1.4, "dashed"
	case 9:
		return 1.0, "dashed"
	case 8:
		return 1.8, "dashed"
	case 7:
		return 3.0, "double"
	case 6:
		return 1.0, "dotted"
	case 5:
		return 1.0, "dashed"
	case 4:
		return 1.0, "dashed"
	case 3:
		return 1.0, "dotted"
	case 2:
		return 0.8, "solid"
	default:
		return 1.0, "solid"
	}
}

func cssRGBString(r, g, b int) string {
	return fmt.Sprintf("rgb(%d,%d,%d)", r, g, b)
}

func escapeCSSString(value string) string {
	return strings.ReplaceAll(value, "'", "\\'")
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
	case time.Time:
		return typed.Format("2006-01-02 15:04:05")
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
