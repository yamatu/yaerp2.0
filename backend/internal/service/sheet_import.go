package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"

	"github.com/xuri/excelize/v2"
)

const sheetImportMaxRows = 5000

type SheetImportService struct {
	sheetRepo    *repo.SheetRepo
	sheetService *SheetService
	uploadSvc    *UploadService
}

type SheetImportResult struct {
	Sheet         *model.Sheet `json:"sheet"`
	ImportedRows  int          `json:"imported_rows"`
	AttachmentID  *int64       `json:"attachment_id,omitempty"`
	AttachmentURL string       `json:"attachment_url,omitempty"`
}

type SheetImportError struct {
	Row     int
	Message string
}

func (e *SheetImportError) Error() string {
	if e == nil {
		return "导入失败"
	}
	if e.Row > 0 {
		return fmt.Sprintf("第 %d 行: %s", e.Row, e.Message)
	}
	return e.Message
}

func NewSheetImportService(sheetRepo *repo.SheetRepo, sheetService *SheetService, uploadSvc *UploadService) *SheetImportService {
	return &SheetImportService{sheetRepo: sheetRepo, sheetService: sheetService, uploadSvc: uploadSvc}
}

func (s *SheetImportService) ImportXLSX(userID, workbookID int64, file multipart.File, filename, requestedSheetName string, source *SpreadsheetImportSource) (*SheetImportResult, error) {
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("读取导入文件失败: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("导入文件为空")
	}

	xlsx, err := openNativeExcelImportFile(data, filename)
	if err != nil {
		return nil, err
	}
	defer func() { _ = xlsx.Close() }()

	firstSheetName := xlsx.GetSheetName(0)
	if strings.TrimSpace(firstSheetName) == "" {
		return nil, fmt.Errorf("未找到可导入的工作表")
	}

	// Import the sheet the way the workbook import does: cells, formulas, fills,
	// fonts, borders, number formats, column widths, row heights and merges, so
	// it looks like it did in Excel instead of a plain list of values.
	snapshot, err := buildWorkbookImportSheetSnapshot(xlsx, firstSheetName, 0)
	if err != nil {
		return nil, err
	}
	columnJSON, err := json.Marshal(snapshot.Columns)
	if err != nil {
		return nil, fmt.Errorf("序列化列结构失败: %w", err)
	}

	sourceFilename := filename
	sourceData := data
	if source != nil {
		sourceFilename = source.Filename
		sourceData = source.Data
	}
	attachmentID, attachmentURL := s.storeImportedWorkbookAttachment(userID, sourceFilename, sourceData)
	config, err := marshalWorkbookImportSheetConfig(sourceFilename, time.Now().Format(time.RFC3339), attachmentID, attachmentURL, snapshot)
	if err != nil {
		return nil, err
	}
	sheet := &model.Sheet{
		WorkbookID: workbookID,
		Name:       resolveImportedSheetName(requestedSheetName, sourceFilename, firstSheetName),
		Columns:    columnJSON,
		Config:     config,
		Frozen:     json.RawMessage(`{"row":0,"col":0}`),
	}
	if err := s.sheetService.CreateSheetForUserWithSource(userID, sheet, "import", "导入 Excel 工作表"); err != nil {
		return nil, err
	}
	if _, err := s.sheetService.CaptureCurrentVersion(userID, sheet.ID, "import", fmt.Sprintf("导入 Excel，共 %d 行", snapshot.RowCount), false); err != nil {
		return nil, err
	}

	return &SheetImportResult{
		Sheet:         sheet,
		ImportedRows:  snapshot.RowCount,
		AttachmentID:  attachmentID,
		AttachmentURL: attachmentURL,
	}, nil
}

func (s *SheetImportService) BuildTemplateFile() (*sheetExportFile, error) {
	file := excelize.NewFile()
	defer func() { _ = file.Close() }()

	sheetName := "模板"
	defaultSheet := file.GetSheetName(0)
	file.SetSheetName(defaultSheet, sheetName)

	headers := []string{"姓名", "年龄", "部门", "薪资", "入职日期", "绩效等级"}
	sample := []any{"张三", 28, "技术部", 12500, "2024-03-15", "A"}
	widths := []float64{140, 90, 120, 120, 130, 110}

	for index, header := range headers {
		axis, _ := excelize.CoordinatesToCellName(index+1, 1)
		if err := file.SetCellValue(sheetName, axis, header); err != nil {
			return nil, fmt.Errorf("写入模板表头失败: %w", err)
		}
		if err := file.SetColWidth(sheetName, axis[:1], axis[:1], widths[index]); err != nil {
			return nil, fmt.Errorf("设置模板列宽失败: %w", err)
		}
	}

	for index, value := range sample {
		axis, _ := excelize.CoordinatesToCellName(index+1, 2)
		if err := file.SetCellValue(sheetName, axis, value); err != nil {
			return nil, fmt.Errorf("写入模板示例失败: %w", err)
		}
	}

	styleID, err := file.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "#0F172A"},
		Fill:      excelize.Fill{Type: "pattern", Color: []string{"#E2E8F0"}, Pattern: 1},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center"},
	})
	if err == nil {
		_ = file.SetCellStyle(sheetName, "A1", "F1", styleID)
	}
	_ = file.SetPanes(sheetName, &excelize.Panes{Freeze: true, Split: false, XSplit: 0, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"})

	buffer := bytes.NewBuffer(nil)
	if _, err := file.WriteTo(buffer); err != nil {
		return nil, fmt.Errorf("生成模板文件失败: %w", err)
	}

	return &sheetExportFile{
		Filename:    "sheet_import_template.xlsx",
		ContentType: sheetExportContentType,
		Data:        buffer.Bytes(),
	}, nil
}

func resolveImportedSheetName(requestedSheetName, filename, fallbackSheetName string) string {
	if strings.TrimSpace(requestedSheetName) != "" {
		return strings.TrimSpace(requestedSheetName)
	}
	base := strings.TrimSpace(strings.TrimSuffix(filepath.Base(filename), filepath.Ext(filename)))
	if base != "" {
		return base
	}
	if strings.TrimSpace(fallbackSheetName) != "" {
		return strings.TrimSpace(fallbackSheetName)
	}
	return "导入工作表"
}
