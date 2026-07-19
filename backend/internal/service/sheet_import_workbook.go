package service

import (
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"

	"github.com/xuri/excelize/v2"
)

const sheetImportMaxSheets = 50
const sheetImportDefaultColumnWidth = 140
const sheetImportDefaultRowHeight = 28

type WorkbookImportResult struct {
	Workbook       *model.Workbook `json:"workbook"`
	FirstSheetID   int64           `json:"first_sheet_id"`
	ImportedRows   int             `json:"imported_rows"`
	ImportedSheets int             `json:"imported_sheets"`
	AttachmentID   *int64          `json:"attachment_id,omitempty"`
	AttachmentURL  string          `json:"attachment_url,omitempty"`
}

type WorkbookSourceXLSXFile struct {
	Filename    string
	ContentType string
	Size        int64
	Reader      io.ReadCloser
}

type workbookImportSourceMetadata struct {
	Filename      string `json:"filename"`
	ImportedAt    string `json:"imported_at"`
	AttachmentID  *int64 `json:"attachment_id"`
	AttachmentURL string `json:"attachment_url"`
	Mode          string `json:"mode"`
}

type workbookImportWorksheet struct {
	ID                 string                                 `json:"id"`
	Name               string                                 `json:"name"`
	TabColor           string                                 `json:"tabColor"`
	Hidden             int                                    `json:"hidden"`
	Freeze             univerExportFreeze                     `json:"freeze"`
	RowCount           int                                    `json:"rowCount"`
	ColumnCount        int                                    `json:"columnCount"`
	ZoomRatio          float64                                `json:"zoomRatio"`
	ScrollTop          int                                    `json:"scrollTop"`
	ScrollLeft         int                                    `json:"scrollLeft"`
	DefaultColumnWidth float64                                `json:"defaultColumnWidth"`
	DefaultRowHeight   float64                                `json:"defaultRowHeight"`
	MergeData          []univerExportRange                    `json:"mergeData"`
	CellData           map[string]map[string]univerExportCell `json:"cellData"`
	RowData            map[string]univerExportRow             `json:"rowData"`
	ColumnData         map[string]univerExportColumn          `json:"columnData"`
	RowHeader          map[string]float64                     `json:"rowHeader"`
	ColumnHeader       map[string]float64                     `json:"columnHeader"`
	ShowGridlines      int                                    `json:"showGridlines"`
	RightToLeft        int                                    `json:"rightToLeft"`
}

type workbookImportSheetSnapshot struct {
	Name        string
	Columns     []sheetColumnPayload
	Worksheet   workbookImportWorksheet
	Styles      map[string]univerStyleData
	RowCount    int
	ColumnCount int
}

func (s *SheetImportService) ImportWorkbookXLSX(userID int64, file multipart.File, filename, requestedWorkbookName string, folderID *int64, source *SpreadsheetImportSource) (*WorkbookImportResult, error) {
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("读取导入文件失败: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("导入文件为空")
	}
	sourceFilename := filename
	sourceData := data
	if source != nil {
		sourceFilename = source.Filename
		sourceData = source.Data
	}
	return s.importWorkbookXLSXData(userID, data, filename, sourceFilename, sourceData, requestedWorkbookName, folderID)
}

func (s *SheetImportService) ImportStoredWorkbookXLSX(userID, attachmentID int64, requestedWorkbookName string, folderID *int64) (*WorkbookImportResult, error) {
	attachment, reader, err := s.uploadSvc.OpenStoredFile(attachmentID)
	if err != nil {
		return nil, err
	}
	defer reader.Close()
	if !IsNativeExcelImportFilename(attachment.Filename) {
		return nil, fmt.Errorf("只有 XLSX、XLSM、XLTX 或 XLTM 附件可以保存为工作簿")
	}
	data, err := io.ReadAll(io.LimitReader(reader, (20<<20)+1))
	if err != nil {
		return nil, fmt.Errorf("读取附件失败: %w", err)
	}
	if len(data) > 20<<20 {
		return nil, fmt.Errorf("Excel 附件不能超过 20MB")
	}
	return s.importWorkbookXLSXData(userID, data, attachment.Filename, attachment.Filename, data, requestedWorkbookName, folderID)
}

func (s *SheetImportService) importWorkbookXLSXData(userID int64, data []byte, importFilename, sourceFilename string, sourceData []byte, requestedWorkbookName string, folderID *int64) (*WorkbookImportResult, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("导入文件为空")
	}

	xlsx, err := openNativeExcelImportFile(data, importFilename)
	if err != nil {
		return nil, err
	}
	defer func() { _ = xlsx.Close() }()

	sheetNames := xlsx.GetSheetList()
	if len(sheetNames) == 0 {
		return nil, fmt.Errorf("未找到可导入的工作表")
	}
	if len(sheetNames) > sheetImportMaxSheets {
		return nil, fmt.Errorf("单个文件最多支持导入 %d 张工作表", sheetImportMaxSheets)
	}

	importedAt := time.Now().Format(time.RFC3339)
	attachmentID, attachmentURL := s.storeImportedWorkbookAttachment(userID, sourceFilename, sourceData)
	workbookName := resolveImportedWorkbookName(requestedWorkbookName, sourceFilename)
	description := fmt.Sprintf("由 Excel 文件 %s 导入", filepath.Base(sourceFilename))
	metadata, err := json.Marshal(map[string]any{
		"importSource": map[string]any{
			"filename":       sourceFilename,
			"imported_at":    importedAt,
			"attachment_id":  attachmentID,
			"attachment_url": attachmentURL,
			"mode":           "excel_univer_snapshot",
		},
	})
	if err != nil {
		return nil, fmt.Errorf("序列化工作簿导入信息失败: %w", err)
	}

	workbook := &model.Workbook{
		Name:        workbookName,
		Description: &description,
		OwnerID:     userID,
		FolderID:    folderID,
		Metadata:    metadata,
	}
	if err := s.sheetService.CreateWorkbookForUserWithSource(userID, workbook, "import", "导入 Excel 工作簿"); err != nil {
		return nil, err
	}

	var firstSheetID int64
	importedRows := 0
	importedSheets := 0
	for index, sheetName := range sheetNames {
		snapshot, err := buildWorkbookImportSheetSnapshot(xlsx, sheetName, index)
		if err != nil {
			_ = s.sheetRepo.DeleteWorkbook(workbook.ID)
			return nil, err
		}

		columnsJSON, err := json.Marshal(snapshot.Columns)
		if err != nil {
			_ = s.sheetRepo.DeleteWorkbook(workbook.ID)
			return nil, fmt.Errorf("序列化工作表列结构失败: %w", err)
		}
		configJSON, err := marshalWorkbookImportSheetConfig(sourceFilename, importedAt, attachmentID, attachmentURL, snapshot)
		if err != nil {
			_ = s.sheetRepo.DeleteWorkbook(workbook.ID)
			return nil, err
		}

		sheet := &model.Sheet{
			WorkbookID: workbook.ID,
			Name:       snapshot.Name,
			Columns:    columnsJSON,
			Config:     configJSON,
			Frozen:     json.RawMessage(`{"row":0,"col":0}`),
		}
		if err := s.sheetService.CreateSheetForUserWithSource(userID, sheet, "import", "导入 Excel 工作簿"); err != nil {
			_ = s.sheetRepo.DeleteWorkbook(workbook.ID)
			return nil, err
		}
		if firstSheetID == 0 {
			firstSheetID = sheet.ID
		}
		importedRows += snapshot.RowCount
		importedSheets += 1
	}

	workbook.Sheets, _ = s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
	return &WorkbookImportResult{
		Workbook:       workbook,
		FirstSheetID:   firstSheetID,
		ImportedRows:   importedRows,
		ImportedSheets: importedSheets,
		AttachmentID:   attachmentID,
		AttachmentURL:  attachmentURL,
	}, nil
}

func (s *SheetImportService) storeImportedWorkbookAttachment(userID int64, filename string, data []byte) (*int64, string) {
	if s.uploadSvc == nil {
		return nil, ""
	}
	attachment, url, err := s.uploadSvc.UploadBytes(filename, excelImportContentType(filename), data, userID)
	if err != nil {
		return nil, ""
	}
	return &attachment.ID, url
}

func (s *SheetImportService) BuildWorkbookSourceXLSXFile(userID, workbookID int64) (*WorkbookSourceXLSXFile, error) {
	if s.uploadSvc == nil {
		return nil, fmt.Errorf("原始 Excel 文件存储服务不可用")
	}

	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return nil, err
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return nil, err
	}
	if err := s.sheetService.ensureWorkbookVisible(workbook, userID); err != nil {
		return nil, err
	}
	if err := s.ensureWorkbookSourceXLSXDownloadAllowed(userID, workbook); err != nil {
		return nil, err
	}

	source, err := parseWorkbookImportSourceMetadata(workbook.Metadata)
	if err != nil {
		return nil, err
	}
	if source.AttachmentID == nil || *source.AttachmentID <= 0 {
		return nil, fmt.Errorf("当前工作簿没有可下载的原始 Excel 文件")
	}

	attachment, reader, err := s.uploadSvc.OpenStoredFile(*source.AttachmentID)
	if err != nil {
		return nil, err
	}

	filename := normalizeWorkbookSourceXLSXFilename(source.Filename, workbook.Name)
	contentType := strings.TrimSpace(attachment.MimeType)
	if contentType == "" {
		contentType = excelImportContentType(filename)
	}

	return &WorkbookSourceXLSXFile{
		Filename:    filename,
		ContentType: contentType,
		Size:        attachment.Size,
		Reader:      reader,
	}, nil
}

func (s *SheetImportService) ensureWorkbookSourceXLSXDownloadAllowed(userID int64, workbook *model.Workbook) error {
	canManage, err := s.sheetService.CanManageWorkbook(userID, workbook)
	if err != nil {
		return err
	}
	if canManage {
		return nil
	}

	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
	if err != nil {
		return err
	}
	if len(sheets) == 0 {
		return fmt.Errorf("%w: 当前账号没有下载原始 Excel 文件的权限", ErrSheetExportDenied)
	}

	for _, sheet := range sheets {
		matrix, err := s.sheetService.permService.GetPermissionMatrix(sheet.ID, userID)
		if err != nil {
			return err
		}
		if !matrix.Sheet.CanExport {
			return fmt.Errorf("%w: 当前账号没有下载原始 Excel 文件的权限，请联系管理员开启导出权限", ErrSheetExportDenied)
		}
	}

	return nil
}

func parseWorkbookImportSourceMetadata(metadata json.RawMessage) (*workbookImportSourceMetadata, error) {
	if len(metadata) == 0 || string(metadata) == "null" {
		return nil, fmt.Errorf("当前工作簿不是通过 Excel 文件导入的，无法下载原始文件")
	}

	var payload struct {
		ImportSource workbookImportSourceMetadata `json:"importSource"`
	}
	if err := json.Unmarshal(metadata, &payload); err != nil {
		return nil, fmt.Errorf("解析工作簿导入信息失败: %w", err)
	}
	if strings.TrimSpace(payload.ImportSource.Mode) == "" && payload.ImportSource.AttachmentID == nil {
		return nil, fmt.Errorf("当前工作簿没有可下载的原始 Excel 文件")
	}

	return &payload.ImportSource, nil
}

func normalizeWorkbookSourceXLSXFilename(filename, workbookName string) string {
	base := strings.TrimSpace(filepath.Base(filename))
	if base == "." || base == string(filepath.Separator) {
		base = ""
	}
	if base == "" {
		base = strings.TrimSpace(workbookName)
	}
	base = sanitizeDownloadFilename(base)
	if !IsSupportedExcelImportFilename(base) {
		base += ".xlsx"
	}
	return base
}

func resolveImportedWorkbookName(requestedWorkbookName, filename string) string {
	if strings.TrimSpace(requestedWorkbookName) != "" {
		return strings.TrimSpace(requestedWorkbookName)
	}
	base := strings.TrimSpace(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)))
	if base != "" {
		return base
	}
	return "导入工作簿"
}

func marshalWorkbookImportSheetConfig(filename, importedAt string, attachmentID *int64, attachmentURL string, snapshot *workbookImportSheetSnapshot) (json.RawMessage, error) {
	payload := map[string]any{
		"importSource": map[string]any{
			"filename":       filename,
			"imported_at":    importedAt,
			"attachment_id":  attachmentID,
			"attachment_url": attachmentURL,
			"mode":           "excel_univer_snapshot",
		},
		"univerSheetData": snapshot.Worksheet,
		"univerStyles":    snapshot.Styles,
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("序列化工作表导入快照失败: %w", err)
	}
	return encoded, nil
}

func buildWorkbookImportSheetSnapshot(file *excelize.File, sheetName string, sheetIndex int) (*workbookImportSheetSnapshot, error) {
	dimension, err := file.GetSheetDimension(sheetName)
	if err != nil {
		return nil, fmt.Errorf("读取工作表 %s 范围失败: %w", sheetName, err)
	}
	startCol, startRow, endCol, endRow := parseExcelDimension(dimension)
	startCol, startRow, endCol, endRow = expandExcelDimensionFromRows(file, sheetName, startCol, startRow, endCol, endRow)
	startCol, startRow, endCol, endRow = expandExcelDimensionFromMerges(file, sheetName, startCol, startRow, endCol, endRow)
	if endRow < startRow {
		endRow = startRow
	}
	if endCol < startCol {
		endCol = startCol
	}
	rowCount := endRow - startRow + 1
	columnCount := endCol - startCol + 1
	if rowCount > sheetImportMaxRows {
		return nil, &SheetImportError{Row: sheetImportMaxRows + 1, Message: fmt.Sprintf("工作表「%s」导入数据不能超过 %d 行", sheetName, sheetImportMaxRows)}
	}

	styles := make(map[string]univerStyleData)
	styleIDs := make(map[int]string)
	cellData := make(map[string]map[string]univerExportCell)

	for row := startRow; row <= endRow; row++ {
		targetRow := row - startRow
		rowKey := strconv.Itoa(targetRow)
		for col := startCol; col <= endCol; col++ {
			targetCol := col - startCol
			axis, _ := excelize.CoordinatesToCellName(col, row)
			cell, ok, err := buildWorkbookImportCell(file, sheetName, axis, styles, styleIDs)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			if _, exists := cellData[rowKey]; !exists {
				cellData[rowKey] = make(map[string]univerExportCell)
			}
			cellData[rowKey][strconv.Itoa(targetCol)] = cell
		}
	}

	columnData, err := buildWorkbookImportColumnData(file, sheetName, startCol, endCol, styles, styleIDs)
	if err != nil {
		return nil, err
	}
	rowData := buildWorkbookImportRowData(file, sheetName, startRow, endRow)
	mergeData := buildWorkbookImportMergeData(file, sheetName, startCol, startRow, endCol, endRow)
	freeze := buildWorkbookImportFreeze(file, sheetName)
	columns := buildWorkbookImportColumns(columnCount, columnData, cellData, styles)
	worksheetID := fmt.Sprintf("import-sheet-%d", sheetIndex+1)

	worksheet := workbookImportWorksheet{
		ID:                 worksheetID,
		Name:               normalizeImportedExcelSheetName(sheetName, sheetIndex),
		TabColor:           "",
		Hidden:             0,
		Freeze:             freeze,
		RowCount:           maxInt(rowCount+25, 200),
		ColumnCount:        maxInt(columnCount, 26),
		ZoomRatio:          1,
		ScrollTop:          0,
		ScrollLeft:         0,
		DefaultColumnWidth: sheetImportDefaultColumnWidth,
		DefaultRowHeight:   sheetImportDefaultRowHeight,
		MergeData:          mergeData,
		CellData:           cellData,
		RowData:            rowData,
		ColumnData:         columnData,
		RowHeader:          map[string]float64{"width": 46},
		ColumnHeader:       map[string]float64{"height": 30},
		ShowGridlines:      1,
		RightToLeft:        0,
	}

	return &workbookImportSheetSnapshot{
		Name:        worksheet.Name,
		Columns:     columns,
		Worksheet:   worksheet,
		Styles:      styles,
		RowCount:    rowCount,
		ColumnCount: columnCount,
	}, nil
}

func parseExcelDimension(dimension string) (int, int, int, int) {
	parts := strings.Split(strings.TrimSpace(dimension), ":")
	if len(parts) == 0 || strings.TrimSpace(parts[0]) == "" {
		return 1, 1, 1, 1
	}
	startCol, startRow, err := excelize.CellNameToCoordinates(parts[0])
	if err != nil {
		return 1, 1, 1, 1
	}
	endCol, endRow := startCol, startRow
	if len(parts) > 1 && strings.TrimSpace(parts[1]) != "" {
		if col, row, err := excelize.CellNameToCoordinates(parts[1]); err == nil {
			endCol, endRow = col, row
		}
	}
	return startCol, startRow, endCol, endRow
}

func expandExcelDimensionFromRows(file *excelize.File, sheetName string, startCol, startRow, endCol, endRow int) (int, int, int, int) {
	rows, err := file.GetRows(sheetName)
	if err != nil || len(rows) == 0 {
		return startCol, startRow, endCol, endRow
	}

	maxRow := len(rows)
	maxCol := 1
	for _, row := range rows {
		if len(row) > maxCol {
			maxCol = len(row)
		}
	}
	if maxRow <= 0 || maxCol <= 0 {
		return startCol, startRow, endCol, endRow
	}
	return minInt(startCol, 1), minInt(startRow, 1), maxInt(endCol, maxCol), maxInt(endRow, maxRow)
}

func expandExcelDimensionFromMerges(file *excelize.File, sheetName string, startCol, startRow, endCol, endRow int) (int, int, int, int) {
	mergeCells, err := file.GetMergeCells(sheetName)
	if err != nil || len(mergeCells) == 0 {
		return startCol, startRow, endCol, endRow
	}
	for _, merge := range mergeCells {
		left, top, err := excelize.CellNameToCoordinates(merge.GetStartAxis())
		if err != nil {
			continue
		}
		right, bottom, err := excelize.CellNameToCoordinates(merge.GetEndAxis())
		if err != nil {
			continue
		}
		startCol = minInt(startCol, left)
		startRow = minInt(startRow, top)
		endCol = maxInt(endCol, right)
		endRow = maxInt(endRow, bottom)
	}
	return startCol, startRow, endCol, endRow
}

func buildWorkbookImportCell(file *excelize.File, sheetName, axis string, styles map[string]univerStyleData, styleIDs map[int]string) (univerExportCell, bool, error) {
	formula, err := file.GetCellFormula(sheetName, axis)
	if err != nil {
		return univerExportCell{}, false, fmt.Errorf("读取 %s!%s 公式失败: %w", sheetName, axis, err)
	}
	displayValue, err := file.GetCellValue(sheetName, axis)
	if err != nil {
		return univerExportCell{}, false, fmt.Errorf("读取 %s!%s 值失败: %w", sheetName, axis, err)
	}
	rawValue, err := file.GetCellValue(sheetName, axis, excelize.Options{RawCellValue: true})
	if err != nil {
		rawValue = displayValue
	}
	cellType, err := file.GetCellType(sheetName, axis)
	if err != nil {
		cellType = excelize.CellTypeUnset
	}
	styleRef, err := workbookImportCellStyleRef(file, sheetName, axis, styles, styleIDs)
	if err != nil {
		return univerExportCell{}, false, err
	}

	cell := univerExportCell{}
	if value, ok := normalizeWorkbookImportCellValue(cellType, rawValue, displayValue); ok {
		cell.Value = value
	}
	if strings.TrimSpace(formula) != "" {
		cell.Formula = normalizeUniverFormula(formula)
	}
	if styleRef != "" {
		cell.Style = styleRef
	}
	if cell.Value == nil && cell.Formula == "" && cell.Style == nil {
		return cell, false, nil
	}
	return cell, true, nil
}

func normalizeWorkbookImportCellValue(cellType excelize.CellType, rawValue, displayValue string) (any, bool) {
	displayValue = strings.TrimSpace(displayValue)
	rawValue = strings.TrimSpace(rawValue)
	if displayValue == "" && rawValue == "" {
		return nil, false
	}

	switch cellType {
	case excelize.CellTypeBool:
		normalized := strings.ToLower(firstNonEmpty(rawValue, displayValue))
		switch normalized {
		case "1", "true":
			return true, true
		case "0", "false":
			return false, true
		}
	case excelize.CellTypeNumber, excelize.CellTypeFormula, excelize.CellTypeUnset:
		if rawValue != "" {
			if !strings.ContainsAny(rawValue, ".eE") {
				if integer, err := strconv.ParseInt(rawValue, 10, 64); err == nil {
					return integer, true
				}
			}
			if number, err := strconv.ParseFloat(rawValue, 64); err == nil {
				return number, true
			}
		}
	}

	if displayValue != "" {
		return displayValue, true
	}
	return rawValue, true
}

func workbookImportCellStyleRef(file *excelize.File, sheetName, axis string, styles map[string]univerStyleData, styleIDs map[int]string) (string, error) {
	styleID, err := file.GetCellStyle(sheetName, axis)
	if err != nil {
		return "", fmt.Errorf("读取 %s!%s 样式失败: %w", sheetName, axis, err)
	}
	return workbookImportStyleRef(file, styleID, styles, styleIDs)
}

func workbookImportStyleRef(file *excelize.File, styleID int, styles map[string]univerStyleData, styleIDs map[int]string) (string, error) {
	if styleID <= 0 {
		return "", nil
	}
	if existing, ok := styleIDs[styleID]; ok {
		return existing, nil
	}
	excelStyle, err := file.GetStyle(styleID)
	if err != nil {
		return "", fmt.Errorf("读取样式 %d 失败: %w", styleID, err)
	}
	univerStyle := convertExcelStyleToUniverStyle(excelStyle)
	if !isMeaningfulUniverStyle(&univerStyle) {
		styleIDs[styleID] = ""
		return "", nil
	}
	ref := fmt.Sprintf("xlsx-style-%d", styleID)
	styles[ref] = univerStyle
	styleIDs[styleID] = ref
	return ref, nil
}

func buildWorkbookImportColumnData(file *excelize.File, sheetName string, startCol, endCol int, styles map[string]univerStyleData, styleIDs map[int]string) (map[string]univerExportColumn, error) {
	columnData := make(map[string]univerExportColumn)
	for col := startCol; col <= endCol; col++ {
		targetCol := col - startCol
		colName, _ := excelize.ColumnNumberToName(col)
		column := univerExportColumn{}
		width, err := file.GetColWidth(sheetName, colName)
		if err == nil && width > 0 {
			column.Width = excelColumnWidthToUniver(width)
		}
		styleID, styleErr := file.GetColStyle(sheetName, colName)
		if styleErr != nil {
			return nil, fmt.Errorf("读取 %s!%s 列默认样式失败: %w", sheetName, colName, styleErr)
		}
		styleRef, styleErr := workbookImportStyleRef(file, styleID, styles, styleIDs)
		if styleErr != nil {
			return nil, styleErr
		}
		if styleRef != "" {
			column.Style = styleRef
		}
		if column.Width > 0 || column.Style != nil {
			columnData[strconv.Itoa(targetCol)] = column
		}
	}
	return columnData, nil
}

func buildWorkbookImportRowData(file *excelize.File, sheetName string, startRow, endRow int) map[string]univerExportRow {
	rowData := make(map[string]univerExportRow)
	for row := startRow; row <= endRow; row++ {
		targetRow := row - startRow
		height, err := file.GetRowHeight(sheetName, row)
		if err != nil || height <= 0 {
			continue
		}
		rowData[strconv.Itoa(targetRow)] = univerExportRow{Height: excelRowHeightToUniver(height)}
	}
	return rowData
}

func buildWorkbookImportMergeData(file *excelize.File, sheetName string, startCol, startRow, endCol, endRow int) []univerExportRange {
	mergeCells, err := file.GetMergeCells(sheetName)
	if err != nil {
		return nil
	}
	result := make([]univerExportRange, 0, len(mergeCells))
	for _, merge := range mergeCells {
		left, top, err := excelize.CellNameToCoordinates(merge.GetStartAxis())
		if err != nil {
			continue
		}
		right, bottom, err := excelize.CellNameToCoordinates(merge.GetEndAxis())
		if err != nil {
			continue
		}
		if right < startCol || left > endCol || bottom < startRow || top > endRow {
			continue
		}
		result = append(result, univerExportRange{
			StartRow:    maxInt(top, startRow) - startRow,
			StartColumn: maxInt(left, startCol) - startCol,
			EndRow:      minInt(bottom, endRow) - startRow,
			EndColumn:   minInt(right, endCol) - startCol,
		})
	}
	return result
}

func buildWorkbookImportFreeze(file *excelize.File, sheetName string) univerExportFreeze {
	panes, err := file.GetPanes(sheetName)
	if err != nil || !panes.Freeze {
		return univerExportFreeze{}
	}
	return univerExportFreeze{
		XSplit:      maxInt(panes.XSplit, 0),
		YSplit:      maxInt(panes.YSplit, 0),
		StartRow:    maxInt(panes.YSplit, 0),
		StartColumn: maxInt(panes.XSplit, 0),
	}
}

func buildWorkbookImportColumns(columnCount int, columnData map[string]univerExportColumn, cellData map[string]map[string]univerExportCell, styles map[string]univerStyleData) []sheetColumnPayload {
	inferredTypes := make([]string, columnCount)
	currencyCodes := make([]string, columnCount)
	for index := 0; index < columnCount; index++ {
		if column, ok := columnData[strconv.Itoa(index)]; ok {
			pattern := workbookImportNumberPattern(column.Style, styles)
			inferredTypes[index], currencyCodes[index] = inferWorkbookImportColumnFormat(pattern)
		}
	}
	for _, row := range cellData {
		for columnKey, cell := range row {
			index, err := strconv.Atoi(columnKey)
			if err != nil || index < 0 || index >= columnCount {
				continue
			}
			if strings.TrimSpace(cell.Formula) != "" {
				inferredTypes[index] = "formula"
				continue
			}
			candidate, currencyCode := inferWorkbookImportColumnFormat(workbookImportNumberPattern(cell.Style, styles))
			if workbookImportColumnTypePriority(candidate) > workbookImportColumnTypePriority(inferredTypes[index]) {
				inferredTypes[index] = candidate
			}
			if currencyCodes[index] == "" {
				currencyCodes[index] = currencyCode
			}
		}
	}

	columns := make([]sheetColumnPayload, 0, columnCount)
	for index := 0; index < columnCount; index++ {
		key := fmt.Sprintf("col_%d", index+1)
		width := float64(sheetImportDefaultColumnWidth)
		if column, ok := columnData[strconv.Itoa(index)]; ok && column.Width > 0 {
			width = column.Width
		}
		columnType := inferredTypes[index]
		if columnType == "" {
			columnType = "text"
		}
		columns = append(columns, sheetColumnPayload{
			Key:          key,
			Name:         columnIndexLabel(index),
			Type:         columnType,
			Width:        width,
			CurrencyCode: currencyCodes[index],
		})
	}
	return columns
}

func normalizeUniverFormula(formula string) string {
	trimmed := strings.TrimSpace(formula)
	if trimmed == "" || strings.HasPrefix(trimmed, "=") {
		return trimmed
	}
	return "=" + trimmed
}

func workbookImportNumberPattern(styleRef any, styles map[string]univerStyleData) string {
	ref, ok := styleRef.(string)
	if !ok || strings.TrimSpace(ref) == "" {
		return ""
	}
	style, ok := styles[ref]
	if !ok || style.N == nil {
		return ""
	}
	return strings.TrimSpace(style.N.Pattern)
}

func inferWorkbookImportColumnFormat(pattern string) (string, string) {
	lower := strings.ToLower(strings.TrimSpace(pattern))
	if lower == "" || lower == "general" || lower == "@" || lower == "@@@" {
		return "", ""
	}
	if strings.Contains(lower, "%") {
		return "percentage", ""
	}
	if excelDateFormatTokenPattern.MatchString(lower) || strings.Contains(lower, "[h]") || strings.Contains(lower, "am/pm") || strings.Contains(lower, "a/p") {
		return "date", ""
	}
	if strings.ContainsAny(pattern, "$¥€£₹₩₽") {
		currencyCode := ""
		switch {
		case strings.Contains(pattern, "¥"):
			currencyCode = "CNY"
		case strings.Contains(pattern, "€"):
			currencyCode = "EUR"
		case strings.Contains(pattern, "£"):
			currencyCode = "GBP"
		case strings.Contains(pattern, "₹"):
			currencyCode = "INR"
		case strings.Contains(pattern, "₩"):
			currencyCode = "KRW"
		case strings.Contains(pattern, "₽"):
			currencyCode = "RUB"
		case strings.Contains(pattern, "$"):
			currencyCode = "USD"
		}
		return "currency", currencyCode
	}
	if strings.ContainsAny(lower, "0#?") {
		return "number", ""
	}
	return "", ""
}

func workbookImportColumnTypePriority(columnType string) int {
	switch columnType {
	case "formula":
		return 5
	case "date":
		return 4
	case "currency", "percentage":
		return 3
	case "number":
		return 2
	default:
		return 0
	}
}

func normalizeImportedExcelSheetName(sheetName string, index int) string {
	trimmed := strings.TrimSpace(sheetName)
	if trimmed != "" {
		return trimmed
	}
	return fmt.Sprintf("Sheet%d", index+1)
}

func convertExcelStyleToUniverStyle(style *excelize.Style) univerStyleData {
	if style == nil {
		return univerStyleData{}
	}
	result := univerStyleData{}
	if font := convertExcelFontToUniver(style.Font); font != nil {
		result = mergeUniverStyleValues(result, *font)
	}
	if bg := convertExcelFillToUniverColor(style.Fill); bg != nil {
		result.Bg = bg
	}
	if alignment := convertExcelAlignmentToUniver(style.Alignment); alignment != nil {
		result = mergeUniverStyleValues(result, *alignment)
	}
	if border := convertExcelBordersToUniver(style.Border); border != nil {
		result.Bd = border
	}
	if pattern := excelStyleNumberFormatPattern(style); pattern != "" && !strings.EqualFold(pattern, "General") {
		result.N = &univerNumberFormat{Pattern: pattern}
	}
	return result
}

var excelLocaleCurrencyPattern = regexp.MustCompile(`\[\$([^\]-]*)(?:-[^\]]+)?\]`)
var excelDateFormatTokenPattern = regexp.MustCompile(`(?i)(^|[^a-z])(y{2,4}|m{1,4}|d{1,4}|h{1,2}|s{1,2})([^a-z]|$)`)

func excelStyleNumberFormatPattern(style *excelize.Style) string {
	if style == nil {
		return ""
	}
	if style.CustomNumFmt != nil && strings.TrimSpace(*style.CustomNumFmt) != "" {
		return normalizeExcelNumberFormatPattern(*style.CustomNumFmt)
	}
	return normalizeExcelNumberFormatPattern(excelBuiltinNumberFormatPattern(style.NumFmt))
}

func normalizeExcelNumberFormatPattern(pattern string) string {
	pattern = strings.TrimSpace(pattern)
	if pattern == "" {
		return ""
	}

	var normalized strings.Builder
	inQuote := false
	for index := 0; index < len(pattern); index++ {
		current := pattern[index]
		if current == '"' {
			inQuote = !inQuote
			normalized.WriteByte(current)
			continue
		}
		if inQuote {
			normalized.WriteByte(current)
			continue
		}
		if current == '_' || current == '*' {
			if index+1 < len(pattern) {
				index++
			}
			continue
		}
		if current == '\\' && index+1 < len(pattern) {
			next := pattern[index+1]
			switch next {
			case '(', ')', '-', '+', ' ', '_', '*':
				normalized.WriteByte(next)
				index++
				continue
			}
		}
		normalized.WriteByte(current)
	}

	result := excelLocaleCurrencyPattern.ReplaceAllStringFunc(strings.TrimSpace(normalized.String()), func(token string) string {
		matches := excelLocaleCurrencyPattern.FindStringSubmatch(token)
		if len(matches) < 2 || strings.TrimSpace(matches[1]) == "" {
			return ""
		}
		return `"` + strings.TrimSpace(matches[1]) + `"`
	})
	return strings.TrimSpace(result)
}

func excelBuiltinNumberFormatPattern(numFmt int) string {
	patterns := map[int]string{
		0: "General", 1: "0", 2: "0.00", 3: "#,##0", 4: "#,##0.00",
		9: "0%", 10: "0.00%", 11: "0.00E+00", 12: "# ?/?", 13: "# ??/??",
		14: "mm-dd-yy", 15: "d-mmm-yy", 16: "d-mmm", 17: "mmm-yy",
		18: "h:mm AM/PM", 19: "h:mm:ss AM/PM", 20: "h:mm", 21: "h:mm:ss", 22: "m/d/yy h:mm",
		37: "#,##0;(#,##0)", 38: "#,##0;[Red](#,##0)",
		39: "#,##0.00;(#,##0.00)", 40: "#,##0.00;[Red](#,##0.00)",
		45: "mm:ss", 46: "[h]:mm:ss", 47: "mmss.0", 48: "##0.0E+0", 49: "@",
	}
	return patterns[numFmt]
}

func convertExcelFontToUniver(font *excelize.Font) *univerStyleData {
	if font == nil {
		return nil
	}
	result := univerStyleData{}
	if strings.TrimSpace(font.Family) != "" {
		result.FF = stringPtr(strings.TrimSpace(font.Family))
	}
	if font.Size > 0 {
		result.FS = float64Ptr(font.Size)
	}
	if font.Bold {
		result.Bl = intPtr(1)
	}
	if font.Italic {
		result.It = intPtr(1)
	}
	if strings.TrimSpace(font.Underline) != "" {
		result.Ul = &univerTextDecoration{S: intPtr(1)}
	}
	if font.Strike {
		result.St = &univerTextDecoration{S: intPtr(1)}
	}
	if color := normalizeExcelColor(font.Color); color != "" {
		result.Cl = &univerColorStyle{RGB: stringPtr(color)}
	}
	switch strings.ToLower(strings.TrimSpace(font.VertAlign)) {
	case "subscript":
		result.Va = intPtr(2)
	case "superscript":
		result.Va = intPtr(3)
	}
	if !isMeaningfulUniverStyle(&result) {
		return nil
	}
	return &result
}

func convertExcelFillToUniverColor(fill excelize.Fill) *univerColorStyle {
	if strings.ToLower(strings.TrimSpace(fill.Type)) != "pattern" || fill.Pattern == 0 || len(fill.Color) == 0 {
		return nil
	}
	if color := normalizeExcelColor(fill.Color[0]); color != "" {
		return &univerColorStyle{RGB: stringPtr(color)}
	}
	return nil
}

func convertExcelAlignmentToUniver(alignment *excelize.Alignment) *univerStyleData {
	if alignment == nil {
		return nil
	}
	result := univerStyleData{}
	switch strings.ToLower(strings.TrimSpace(alignment.Horizontal)) {
	case "center":
		result.Ht = intPtr(2)
	case "right":
		result.Ht = intPtr(3)
	case "left":
		result.Ht = intPtr(1)
	}
	switch strings.ToLower(strings.TrimSpace(alignment.Vertical)) {
	case "center":
		result.Vt = intPtr(2)
	case "bottom":
		result.Vt = intPtr(3)
	case "top":
		result.Vt = intPtr(1)
	}
	if alignment.WrapText {
		result.Tb = intPtr(3)
	}
	if alignment.TextRotation != 0 {
		if alignment.TextRotation == 255 {
			result.Tr = &univerTextRotation{V: intPtr(1)}
		} else {
			result.Tr = &univerTextRotation{A: float64(alignment.TextRotation)}
		}
	}
	if !isMeaningfulUniverStyle(&result) {
		return nil
	}
	return &result
}

func convertExcelBordersToUniver(borders []excelize.Border) *univerBorderData {
	if len(borders) == 0 {
		return nil
	}
	result := &univerBorderData{}
	for _, border := range borders {
		side := convertExcelBorderSideToUniver(border)
		if side == nil {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(border.Type)) {
		case "top":
			result.T = side
		case "right":
			result.R = side
		case "bottom":
			result.B = side
		case "left":
			result.L = side
		}
	}
	if result.T == nil && result.R == nil && result.B == nil && result.L == nil {
		return nil
	}
	return result
}

func convertExcelBorderSideToUniver(border excelize.Border) *univerBorderStyleData {
	if border.Style <= 0 {
		return nil
	}
	result := &univerBorderStyleData{S: intPtr(mapUniverBorderStyle(border.Style))}
	if color := normalizeExcelColor(border.Color); color != "" {
		result.CL = &univerColorStyle{RGB: stringPtr(color)}
	}
	return result
}

func mapUniverBorderStyle(excelStyle int) int {
	switch excelStyle {
	case 1:
		return 1
	case 7:
		return 2
	case 4:
		return 3
	case 3:
		return 4
	case 9:
		return 5
	case 11:
		return 6
	case 6:
		return 7
	case 2:
		return 8
	case 8:
		return 9
	case 10:
		return 10
	case 12:
		return 11
	case 13:
		return 12
	case 5:
		return 13
	default:
		return 1
	}
}

func mergeUniverStyleValues(base, overlay univerStyleData) univerStyleData {
	merged := mergeUniverStyles(&base, &overlay)
	if merged == nil {
		return univerStyleData{}
	}
	return *merged
}

func normalizeExcelColor(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return ""
	}
	trimmed = strings.TrimPrefix(trimmed, "#")
	if len(trimmed) == 8 {
		trimmed = trimmed[2:]
	}
	if len(trimmed) != 6 {
		return ""
	}
	for _, r := range trimmed {
		if !((r >= '0' && r <= '9') || (r >= 'a' && r <= 'f') || (r >= 'A' && r <= 'F')) {
			return ""
		}
	}
	return "#" + strings.ToUpper(trimmed)
}

func excelColumnWidthToUniver(width float64) float64 {
	if width <= 0 {
		return sheetImportDefaultColumnWidth
	}
	return width * 8
}

func excelRowHeightToUniver(height float64) float64 {
	if height <= 0 {
		return sheetImportDefaultRowHeight
	}
	return height * 4 / 3
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
