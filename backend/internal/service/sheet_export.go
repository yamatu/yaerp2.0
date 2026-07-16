package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"

	"github.com/xuri/excelize/v2"
)

const sheetExportContentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
const sheetPDFContentType = "application/pdf"

type sheetExportFile struct {
	Filename    string
	ContentType string
	Data        []byte
}

type sheetExportContext struct {
	UserID   int64
	Sheet    *model.Sheet
	Workbook *model.Workbook
	Columns  []sheetColumnPayload
	Matrix   *model.PermissionMatrix
	Styles   map[string]univerStyleData
}

type univerExportCell struct {
	Value   any    `json:"v"`
	Formula string `json:"f"`
	Style   any    `json:"s,omitempty"`
}

type univerExportColumn struct {
	Width  float64 `json:"w"`
	Hidden int     `json:"hd,omitempty"`
	Style  any     `json:"s,omitempty"`
	Custom any     `json:"custom,omitempty"`
	Text   any     `json:"tx,omitempty"`
	VAlign any     `json:"vt,omitempty"`
}

type univerExportRow struct {
	Height     float64 `json:"h,omitempty"`
	AutoHeight float64 `json:"ah,omitempty"`
	Hidden     int     `json:"hd,omitempty"`
	Style      any     `json:"s,omitempty"`
}

type univerExportRange struct {
	StartRow    int `json:"startRow"`
	StartColumn int `json:"startColumn"`
	EndRow      int `json:"endRow"`
	EndColumn   int `json:"endColumn"`
}

type univerExportFreeze struct {
	XSplit      int `json:"xSplit"`
	YSplit      int `json:"ySplit"`
	StartRow    int `json:"startRow"`
	StartColumn int `json:"startColumn"`
}

type univerExportWorksheet struct {
	CellData           map[string]map[string]univerExportCell `json:"cellData"`
	ColumnData         map[string]univerExportColumn          `json:"columnData"`
	RowData            map[string]univerExportRow             `json:"rowData"`
	Freeze             univerExportFreeze                     `json:"freeze"`
	DefaultStyle       any                                    `json:"defaultStyle"`
	MergeData          []univerExportRange                    `json:"mergeData"`
	DefaultColumnWidth float64                                `json:"defaultColumnWidth"`
	DefaultRowHeight   float64                                `json:"defaultRowHeight"`
	ShowGridlines      int                                    `json:"showGridlines"`
}

type exportSnapshotRow struct {
	SourceRowIndex int
	Cells          map[int]univerExportCell
}

type exportSnapshotMatrix struct {
	Columns []int
	Rows    []exportSnapshotRow
}

func (s *SheetService) BuildSheetExportFile(userID, sheetID int64, filename string) (*sheetExportFile, error) {
	ctx, err := s.loadSheetExportContext(userID, sheetID, true)
	if err != nil {
		return nil, err
	}

	file := excelize.NewFile()
	defer func() { _ = file.Close() }()
	if err := applySheetExportWorkbookProps(file); err != nil {
		return nil, err
	}

	excelSheetName := normalizeExcelSheetName(ctx.Sheet.Name)
	defaultSheet := file.GetSheetName(0)
	file.SetSheetName(defaultSheet, excelSheetName)

	if err := s.writeSheetExportContext(file, excelSheetName, ctx); err != nil {
		return nil, err
	}
	if err := file.UpdateLinkedValue(); err != nil {
		return nil, fmt.Errorf("update formula links: %w", err)
	}

	buffer := bytes.NewBuffer(nil)
	if _, err := file.WriteTo(buffer); err != nil {
		return nil, fmt.Errorf("stream export workbook: %w", err)
	}

	return &sheetExportFile{
		Filename:    normalizeSheetExportFilename(filename, ctx.Sheet.Name, sheetID),
		ContentType: sheetExportContentType,
		Data:        buffer.Bytes(),
	}, nil
}

func (s *SheetService) BuildWorkbookExportFile(userID, workbookID int64, sheetIDs []int64, filename string) (*sheetExportFile, error) {
	workbook, contexts, err := s.loadWorkbookExportContexts(userID, workbookID, sheetIDs, true)
	if err != nil {
		return nil, err
	}

	file := excelize.NewFile()
	defer func() { _ = file.Close() }()
	if err := applySheetExportWorkbookProps(file); err != nil {
		return nil, err
	}

	usedSheetNames := map[string]int{}
	for index, ctx := range contexts {
		excelSheetName := uniqueExcelSheetName(ctx.Sheet.Name, usedSheetNames)
		if index == 0 {
			defaultSheet := file.GetSheetName(0)
			file.SetSheetName(defaultSheet, excelSheetName)
		} else if _, err := file.NewSheet(excelSheetName); err != nil {
			return nil, fmt.Errorf("create export sheet %s: %w", excelSheetName, err)
		}

		if err := s.writeSheetExportContext(file, excelSheetName, ctx); err != nil {
			return nil, err
		}
	}
	if err := file.UpdateLinkedValue(); err != nil {
		return nil, fmt.Errorf("update formula links: %w", err)
	}

	buffer := bytes.NewBuffer(nil)
	if _, err := file.WriteTo(buffer); err != nil {
		return nil, fmt.Errorf("stream export workbook: %w", err)
	}

	return &sheetExportFile{
		Filename:    normalizeWorkbookExportFilename(filename, workbook.Name, workbookID, ".xlsx"),
		ContentType: sheetExportContentType,
		Data:        buffer.Bytes(),
	}, nil
}

func (s *SheetService) writeSheetExportContext(file *excelize.File, excelSheetName string, ctx *sheetExportContext) error {
	snapshot, snapshotMatrix, writtenFromSnapshot, err := s.writeSheetExportSnapshot(file, excelSheetName, ctx.Matrix, ctx.Styles, ctx.Sheet.Config, ctx.Columns)
	if err != nil {
		return err
	}
	if !writtenFromSnapshot {
		rows, err := s.GetSheetDataForUser(ctx.Sheet.ID, ctx.UserID)
		if err != nil {
			return err
		}
		if err := s.writeSheetExportRows(file, excelSheetName, ctx.Matrix, ctx.Columns, rows); err != nil {
			return err
		}
		applySheetExportHeaderStyle(file, excelSheetName, maxSheetExportColumnCount(ctx.Columns))
		applySheetExportFreeze(file, excelSheetName, nil, nil)
	} else {
		applySheetExportFreeze(file, excelSheetName, snapshot, snapshotMatrix)
	}
	return nil
}

func applySheetExportWorkbookProps(file *excelize.File) error {
	filterPrivacy := true
	date1904 := false
	codeName := "ThisWorkbook"
	if err := file.SetWorkbookProps(&excelize.WorkbookPropsOptions{
		FilterPrivacy: &filterPrivacy,
		Date1904:      &date1904,
		CodeName:      &codeName,
	}); err != nil {
		return fmt.Errorf("set workbook props: %w", err)
	}
	return nil
}

func (s *SheetService) loadSheetExportContext(userID, sheetID int64, requireExport bool) (*sheetExportContext, error) {
	matrix, err := s.permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return nil, err
	}
	if requireExport && !matrix.Sheet.CanExport {
		return nil, fmt.Errorf("%w: 当前账号没有导出这个工作表的权限", ErrSheetExportDenied)
	}
	if !requireExport && !matrix.Sheet.CanView {
		return nil, fmt.Errorf("%w: 当前账号没有查看这个工作表的权限", ErrWorkbookAccessDenied)
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, err
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, err
	}

	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return nil, err
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return nil, err
	}
	if err := s.ensureWorkbookVisible(workbook, userID); err != nil {
		return nil, err
	}
	sheet, err = s.maskSheetForUser(sheet, userID)
	if err != nil {
		return nil, err
	}

	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return nil, err
	}

	styles, err := extractUniverStyleMap(sheet.Config)
	if err != nil {
		return nil, err
	}

	return &sheetExportContext{UserID: userID, Sheet: sheet, Workbook: workbook, Columns: columns, Matrix: matrix, Styles: styles}, nil
}

func (s *SheetService) loadWorkbookExportContexts(userID, workbookID int64, sheetIDs []int64, requireExport bool) (*model.Workbook, []*sheetExportContext, error) {
	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return nil, nil, err
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return nil, nil, err
	}
	if err := s.ensureWorkbookVisible(workbook, userID); err != nil {
		return nil, nil, err
	}

	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return nil, nil, err
	}
	if err := applySheetLifecycleStates(sheets); err != nil {
		return nil, nil, err
	}

	requestedIDs := normalizeExportSheetIDs(sheetIDs)
	requestedIDSet := make(map[int64]struct{}, len(requestedIDs))
	for _, id := range requestedIDs {
		requestedIDSet[id] = struct{}{}
	}

	contexts := make([]*sheetExportContext, 0, len(sheets))
	foundIDs := make(map[int64]struct{}, len(requestedIDSet))
	for _, sheet := range sheets {
		if len(requestedIDSet) > 0 {
			if _, ok := requestedIDSet[sheet.ID]; !ok {
				continue
			}
		}

		ctx, err := s.loadSheetExportContext(userID, sheet.ID, requireExport)
		if err != nil {
			return nil, nil, err
		}
		if ctx.Sheet.WorkbookID != workbookID {
			return nil, nil, fmt.Errorf("%w: 工作表不属于当前工作簿", ErrWorkbookAccessDenied)
		}
		contexts = append(contexts, ctx)
		foundIDs[sheet.ID] = struct{}{}
	}

	if len(requestedIDSet) > 0 && len(foundIDs) != len(requestedIDSet) {
		return nil, nil, fmt.Errorf("%w: 部分工作表不存在或不属于当前工作簿", ErrWorkbookAccessDenied)
	}
	if len(contexts) == 0 {
		return nil, nil, fmt.Errorf("当前工作簿没有可导出的工作表")
	}

	return workbook, contexts, nil
}

func normalizeExportSheetIDs(sheetIDs []int64) []int64 {
	seen := make(map[int64]struct{}, len(sheetIDs))
	result := make([]int64, 0, len(sheetIDs))
	for _, id := range sheetIDs {
		if id <= 0 {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	return result
}

func (s *SheetService) writeSheetExportSnapshot(file *excelize.File, sheetName string, permMatrix *model.PermissionMatrix, styles map[string]univerStyleData, config json.RawMessage, columns []sheetColumnPayload) (*univerExportWorksheet, *exportSnapshotMatrix, bool, error) {
	if len(config) == 0 {
		return nil, nil, false, nil
	}

	var payload map[string]json.RawMessage
	if err := json.Unmarshal(config, &payload); err != nil {
		return nil, nil, false, fmt.Errorf("parse sheet config: %w", err)
	}

	rawSheet, ok := payload["univerSheetData"]
	if !ok || len(rawSheet) == 0 || string(rawSheet) == "null" {
		return nil, nil, false, nil
	}

	var snapshot univerExportWorksheet
	if err := json.Unmarshal(rawSheet, &snapshot); err != nil {
		return nil, nil, false, fmt.Errorf("parse univer sheet data: %w", err)
	}

	snapshotMatrix := buildExportSnapshotMatrix(snapshot)
	if len(snapshotMatrix.Columns) == 0 {
		snapshotMatrix.Columns = buildFallbackExportColumns(columns)
	}
	setSheetExportColumnWidthsForIndexes(file, sheetName, columns, snapshot.ColumnData, snapshotMatrix.Columns)
	setSheetExportRowHeightsForRows(file, sheetName, snapshot, snapshotMatrix.Rows)

	targetRowIndex := 0
	for _, row := range snapshotMatrix.Rows {
		for targetColumnIndex, sourceColumnIndex := range snapshotMatrix.Columns {
			cell, ok := row.Cells[sourceColumnIndex]
			if !ok {
				continue
			}

			if row.SourceRowIndex > 0 && sourceColumnIndex < len(columns) {
				allowed := permissionMatrixAllowsCell(permMatrix, columns[sourceColumnIndex].Key, row.SourceRowIndex-1, "read")
				if !allowed {
					continue
				}
			}

			axis, _ := excelize.CoordinatesToCellName(targetColumnIndex+1, targetRowIndex+1)
			var column *sheetColumnPayload
			if sourceColumnIndex >= 0 && sourceColumnIndex < len(columns) {
				column = &columns[sourceColumnIndex]
			}
			if err := setSheetExportCell(file, sheetName, axis, cell, column); err != nil {
				return nil, nil, true, err
			}
		}
		targetRowIndex += 1
	}

	if err := applySheetExportSnapshotDecorations(file, sheetName, snapshot, snapshotMatrix, columns, styles); err != nil {
		return nil, nil, true, err
	}

	return &snapshot, &snapshotMatrix, true, nil
}

func (s *SheetService) writeSheetExportRows(file *excelize.File, sheetName string, matrix *model.PermissionMatrix, columns []sheetColumnPayload, rows []model.Row) error {
	setSheetExportColumnWidths(file, sheetName, columns, nil)
	if err := writeSheetExportHeader(file, sheetName, columns, nil); err != nil {
		return err
	}
	styleCache := &sheetExportStyleCache{ids: make(map[string]int)}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].RowIndex == rows[j].RowIndex {
			return rows[i].ID < rows[j].ID
		}
		return rows[i].RowIndex < rows[j].RowIndex
	})

	for _, row := range rows {
		data := map[string]any{}
		if len(row.Data) > 0 {
			if err := json.Unmarshal(row.Data, &data); err != nil {
				return fmt.Errorf("parse sheet row %d: %w", row.RowIndex, err)
			}
		}

		for index, column := range columns {
			allowed := permissionMatrixAllowsCell(matrix, column.Key, row.RowIndex, "read")
			if !allowed {
				continue
			}

			axis, _ := excelize.CoordinatesToCellName(index+1, row.RowIndex+2)
			value := data[column.Key]
			if err := setSheetExportCell(file, sheetName, axis, univerExportCell{Value: value}, &column); err != nil {
				return err
			}
			if styleID, err := styleCache.styleID(file, nil, &column, univerExportCell{Value: value}); err != nil {
				return err
			} else if styleID > 0 {
				if err := file.SetCellStyle(sheetName, axis, axis, styleID); err != nil {
					return err
				}
			}
		}
	}

	return nil
}

func writeSheetExportHeader(file *excelize.File, sheetName string, columns []sheetColumnPayload, headerRow map[string]univerExportCell) error {
	if len(headerRow) > 0 {
		for _, columnIndex := range sortedStringMapIndexes(headerRow) {
			axis, _ := excelize.CoordinatesToCellName(columnIndex+1, 1)
			if err := setSheetExportCell(file, sheetName, axis, headerRow[strconv.Itoa(columnIndex)], nil); err != nil {
				return err
			}
		}
	}

	for index, column := range columns {
		axis, _ := excelize.CoordinatesToCellName(index+1, 1)
		cellValue, err := file.GetCellValue(sheetName, axis)
		if err == nil && strings.TrimSpace(cellValue) != "" {
			continue
		}
		_ = file.SetCellValue(sheetName, axis, sanitizeExcelString(firstNonEmpty(column.Name, column.Key)))
	}

	return nil
}

func writeSheetExportHeaderForIndexes(file *excelize.File, sheetName string, columns []sheetColumnPayload, sourceIndexes []int) error {
	for targetIndex, sourceIndex := range sourceIndexes {
		headerName := columnIndexLabel(sourceIndex)
		if sourceIndex < len(columns) {
			headerName = firstNonEmpty(columns[sourceIndex].Name, columns[sourceIndex].Key)
		}
		axis, _ := excelize.CoordinatesToCellName(targetIndex+1, 1)
		if err := file.SetCellValue(sheetName, axis, sanitizeExcelString(headerName)); err != nil {
			return err
		}
	}
	return nil
}

func setSheetExportCell(file *excelize.File, sheetName, axis string, cell univerExportCell, column *sheetColumnPayload) error {
	formula := sanitizeExcelString(strings.TrimSpace(cell.Formula))
	if formula != "" {
		if err := file.SetCellFormula(sheetName, axis, strings.TrimPrefix(formula, "=")); err == nil {
			return nil
		}
	}

	value := normalizeSheetPDFValue(cell.Value)
	if normalized, ok := normalizeExcelExportValue(value, column); ok {
		return file.SetCellValue(sheetName, axis, normalized)
	}

	switch typed := value.(type) {
	case nil:
		if formula != "" {
			return file.SetCellValue(sheetName, axis, sanitizeExcelString(formula))
		}
		return nil
	case string:
		return file.SetCellValue(sheetName, axis, sanitizeExcelString(typed))
	case float64, bool, int, int32, int64, uint, uint32, uint64:
		return file.SetCellValue(sheetName, axis, typed)
	default:
		sanitized := sanitizeExcelJSONValue(typed)
		encoded, err := json.Marshal(sanitized)
		if err != nil {
			return file.SetCellValue(sheetName, axis, sanitizeExcelString(fmt.Sprint(sanitized)))
		}
		return file.SetCellValue(sheetName, axis, sanitizeExcelString(string(encoded)))
	}
}

func setSheetExportColumnWidths(file *excelize.File, sheetName string, columns []sheetColumnPayload, columnData map[string]univerExportColumn) {
	indexes := make([]int, 0, len(columns))
	for index := range columns {
		indexes = append(indexes, index)
	}
	setSheetExportColumnWidthsForIndexes(file, sheetName, columns, columnData, indexes)
}

func setSheetExportColumnWidthsForIndexes(file *excelize.File, sheetName string, columns []sheetColumnPayload, columnData map[string]univerExportColumn, sourceIndexes []int) {
	for targetIndex, sourceIndex := range sourceIndexes {
		width := 0.0
		if sourceIndex < len(columns) && columns[sourceIndex].Width > 0 {
			width = columns[sourceIndex].Width / 7.2
		}
		if meta, ok := columnData[strconv.Itoa(sourceIndex)]; ok && meta.Width > 0 {
			width = meta.Width / 7.2
		}
		if width <= 0 {
			continue
		}
		if width < 8 {
			width = 8
		}

		columnName, err := excelize.ColumnNumberToName(targetIndex + 1)
		if err != nil {
			continue
		}
		_ = file.SetColWidth(sheetName, columnName, columnName, width)
	}
}

func setSheetExportRowHeightsForRows(file *excelize.File, sheetName string, snapshot univerExportWorksheet, rows []exportSnapshotRow) {
	for targetRowIndex, row := range rows {
		height := snapshot.DefaultRowHeight
		if meta, ok := snapshot.RowData[strconv.Itoa(row.SourceRowIndex)]; ok {
			if meta.AutoHeight > 0 {
				height = meta.AutoHeight
			} else if meta.Height > 0 {
				height = meta.Height
			}
		}
		if height <= 0 {
			height = 28
		}
		_ = file.SetRowHeight(sheetName, targetRowIndex+1, height*0.75)
	}
}

func applySheetExportHeaderStyle(file *excelize.File, sheetName string, columnCount int) {
	if columnCount <= 0 {
		return
	}

	styleID, err := file.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true, Color: "#0f172a"},
		Fill: excelize.Fill{Type: "pattern", Color: []string{"#e2e8f0"}, Pattern: 1},
	})
	if err != nil {
		return
	}

	lastColumn, err := excelize.ColumnNumberToName(columnCount)
	if err != nil {
		return
	}
	_ = file.SetCellStyle(sheetName, "A1", fmt.Sprintf("%s1", lastColumn), styleID)
}

func applySheetExportFreeze(file *excelize.File, sheetName string, snapshot *univerExportWorksheet, matrix *exportSnapshotMatrix) {
	if snapshot == nil || matrix == nil {
		_ = file.SetPanes(sheetName, &excelize.Panes{
			Freeze:      true,
			Split:       false,
			XSplit:      0,
			YSplit:      1,
			TopLeftCell: "A2",
			ActivePane:  "bottomLeft",
			Selection:   []excelize.Selection{{SQRef: "A2", ActiveCell: "A2", Pane: "bottomLeft"}},
		})
		return
	}

	xSplit := 0
	ySplit := 0
	for _, column := range matrix.Columns {
		if column < snapshot.Freeze.XSplit {
			xSplit += 1
		}
	}
	for _, row := range matrix.Rows {
		if row.SourceRowIndex < snapshot.Freeze.YSplit {
			ySplit += 1
		}
	}
	if xSplit == 0 && ySplit == 0 {
		return
	}

	topLeftCell, _ := excelize.CoordinatesToCellName(max(1, xSplit+1), max(1, ySplit+1))
	activePane := "bottomLeft"
	selectionPane := "bottomLeft"
	switch {
	case xSplit > 0 && ySplit > 0:
		activePane = "bottomRight"
		selectionPane = "bottomRight"
	case xSplit > 0:
		activePane = "topRight"
		selectionPane = "topRight"
	}

	_ = file.SetPanes(sheetName, &excelize.Panes{
		Freeze:      true,
		Split:       false,
		XSplit:      xSplit,
		YSplit:      ySplit,
		TopLeftCell: topLeftCell,
		ActivePane:  activePane,
		Selection:   []excelize.Selection{{SQRef: topLeftCell, ActiveCell: topLeftCell, Pane: selectionPane}},
	})
}

func maxSheetExportColumnCount(columns []sheetColumnPayload) int {
	if len(columns) > 0 {
		return len(columns)
	}
	return 1
}

func sortedStringMapIndexes[V any](items map[string]V) []int {
	indexes := make([]int, 0, len(items))
	for key := range items {
		index, err := strconv.Atoi(key)
		if err != nil || index < 0 {
			continue
		}
		indexes = append(indexes, index)
	}
	sort.Ints(indexes)
	return indexes
}

func buildExportSnapshotMatrix(snapshot univerExportWorksheet) exportSnapshotMatrix {
	rows := make([]exportSnapshotRow, 0, len(snapshot.CellData))
	usedColumns := make(map[int]struct{})

	for _, rowIndex := range sortedStringMapIndexes(snapshot.CellData) {
		if rowIndex < 0 {
			continue
		}

		rowKey := strconv.Itoa(rowIndex)
		rawRow := snapshot.CellData[rowKey]
		cells := make(map[int]univerExportCell, len(rawRow))
		for _, columnIndex := range sortedStringMapIndexes(rawRow) {
			cell := rawRow[strconv.Itoa(columnIndex)]
			cells[columnIndex] = cell
			if exportCellHasContent(cell) {
				usedColumns[columnIndex] = struct{}{}
			}
		}
		rows = append(rows, exportSnapshotRow{SourceRowIndex: rowIndex, Cells: cells})
	}

	columns := sortedExportColumns(usedColumns)
	rows = trimEmptySnapshotRows(rows, columns)

	return exportSnapshotMatrix{Columns: columns, Rows: rows}
}

func trimEmptySnapshotRows(rows []exportSnapshotRow, columns []int) []exportSnapshotRow {
	start := 0
	for start < len(rows) && !snapshotRowHasContent(rows[start], columns) {
		start += 1
	}

	end := len(rows) - 1
	for end >= start && !snapshotRowHasContent(rows[end], columns) {
		end -= 1
	}

	if start > end {
		return nil
	}
	return rows[start : end+1]
}

func snapshotRowHasContent(row exportSnapshotRow, columns []int) bool {
	if len(columns) == 0 {
		return false
	}
	for _, columnIndex := range columns {
		if exportCellHasContent(row.Cells[columnIndex]) {
			return true
		}
	}
	return false
}

func exportCellHasContent(cell univerExportCell) bool {
	if strings.TrimSpace(cell.Formula) != "" {
		return true
	}
	if cell.Style != nil {
		return true
	}
	switch value := cell.Value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(value) != ""
	default:
		return true
	}
}

func sortedExportColumns(items map[int]struct{}) []int {
	columns := make([]int, 0, len(items))
	for index := range items {
		if index >= 0 {
			columns = append(columns, index)
		}
	}
	sort.Ints(columns)
	return columns
}

func buildFallbackExportColumns(columns []sheetColumnPayload) []int {
	indexes := make([]int, 0, len(columns))
	for index := range columns {
		indexes = append(indexes, index)
	}
	if len(indexes) == 0 {
		return []int{0}
	}
	return indexes
}

func normalizeSheetExportFilename(filename, sheetName string, sheetID int64) string {
	return normalizeSheetExportFilenameWithExt(filename, sheetName, sheetID, ".xlsx")
}

func normalizeSheetPDFFilename(filename, sheetName string, sheetID int64) string {
	return normalizeSheetExportFilenameWithExt(filename, sheetName, sheetID, ".pdf")
}

func normalizeWorkbookExportFilename(filename, workbookName string, workbookID int64, ext string) string {
	base := sanitizeDownloadFilename(strings.TrimSpace(filename))
	if base == "" {
		base = sanitizeDownloadFilename(strings.TrimSpace(workbookName))
	}
	if base == "" {
		base = fmt.Sprintf("workbook-%d", workbookID)
	}
	if !strings.HasSuffix(strings.ToLower(base), strings.ToLower(ext)) {
		base += ext
	}
	return base
}

func normalizeSheetExportFilenameWithExt(filename, sheetName string, sheetID int64, ext string) string {
	base := sanitizeDownloadFilename(strings.TrimSpace(filename))
	if base == "" {
		base = sanitizeDownloadFilename(strings.TrimSpace(sheetName))
	}
	if base == "" {
		base = fmt.Sprintf("sheet-%d", sheetID)
	}
	if !strings.HasSuffix(strings.ToLower(base), strings.ToLower(ext)) {
		base += ext
	}
	return base
}

func uniqueExcelSheetName(name string, used map[string]int) string {
	base := normalizeExcelSheetName(name)
	key := strings.ToLower(base)
	if _, exists := used[key]; !exists {
		used[key] = 1
		return base
	}

	for index := used[key] + 1; ; index++ {
		suffix := fmt.Sprintf(" (%d)", index)
		candidateBase := truncateRunes(base, 31-len([]rune(suffix)))
		candidateBase = strings.TrimSpace(candidateBase)
		if candidateBase == "" {
			candidateBase = "Sheet"
		}
		candidate := candidateBase + suffix
		candidateKey := strings.ToLower(candidate)
		if _, exists := used[candidateKey]; exists {
			continue
		}
		used[key] = index
		used[candidateKey] = 1
		return candidate
	}
}

func sanitizeDownloadFilename(name string) string {
	if name == "" {
		return ""
	}
	replacer := strings.NewReplacer(
		"\\", "-",
		"/", "-",
		":", "-",
		"*", "-",
		"?", "",
		"\"", "",
		"<", "(",
		">", ")",
		"|", "-",
		"\r", " ",
		"\n", " ",
		"\t", " ",
	)
	cleaned := strings.TrimSpace(replacer.Replace(name))
	cleaned = strings.Trim(cleaned, ". ")
	return cleaned
}

func normalizeExcelSheetName(name string) string {
	cleaned := strings.TrimSpace(name)
	if cleaned == "" {
		return "Sheet1"
	}
	replacer := strings.NewReplacer(
		":", "-",
		"\\", "-",
		"/", "-",
		"?", "",
		"*", "",
		"[", "(",
		"]", ")",
	)
	cleaned = replacer.Replace(cleaned)
	cleaned = truncateRunes(cleaned, 31)
	cleaned = strings.TrimSpace(cleaned)
	if cleaned == "" {
		return "Sheet1"
	}
	return cleaned
}

func truncateRunes(value string, limit int) string {
	if limit <= 0 {
		return ""
	}
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}

func columnIndexLabel(index int) string {
	if index < 0 {
		return "A"
	}
	value := index + 1
	result := ""
	for value > 0 {
		remainder := (value - 1) % 26
		result = string(rune('A'+remainder)) + result
		value = (value - 1) / 26
	}
	if result == "" {
		return "A"
	}
	return result
}

func sanitizeExcelJSONValue(value any) any {
	switch typed := value.(type) {
	case string:
		return sanitizeExcelString(typed)
	case []any:
		items := make([]any, len(typed))
		for index, item := range typed {
			items[index] = sanitizeExcelJSONValue(item)
		}
		return items
	case map[string]any:
		items := make(map[string]any, len(typed))
		for key, item := range typed {
			items[sanitizeExcelString(key)] = sanitizeExcelJSONValue(item)
		}
		return items
	default:
		return value
	}
}

func sanitizeExcelString(value string) string {
	if value == "" {
		return value
	}
	var builder strings.Builder
	builder.Grow(len(value))
	for _, r := range value {
		switch {
		case r == 0x9 || r == 0xA || r == 0xD:
			builder.WriteRune(r)
		case r >= 0x20 && r <= 0xD7FF:
			builder.WriteRune(r)
		case r >= 0xE000 && r <= 0xFFFD:
			builder.WriteRune(r)
		case r >= 0x10000 && r <= 0x10FFFF:
			builder.WriteRune(r)
		}
	}
	return builder.String()
}
