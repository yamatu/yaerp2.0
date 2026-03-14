package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"strconv"
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

func (s *SheetImportService) ImportXLSX(userID, workbookID int64, file multipart.File, filename, requestedSheetName string) (*SheetImportResult, error) {
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("读取导入文件失败: %w", err)
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("导入文件为空")
	}

	xlsx, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("解析 XLSX 失败: %w", err)
	}
	defer func() { _ = xlsx.Close() }()

	firstSheetName := xlsx.GetSheetName(0)
	if strings.TrimSpace(firstSheetName) == "" {
		return nil, fmt.Errorf("未找到可导入的工作表")
	}

	rows, err := xlsx.GetRows(firstSheetName)
	if err != nil {
		return nil, fmt.Errorf("读取工作表数据失败: %w", err)
	}

	headerRowIndex := -1
	for index, row := range rows {
		if !isImportedRowEmpty(row) {
			headerRowIndex = index
			break
		}
	}
	if headerRowIndex < 0 {
		return nil, fmt.Errorf("模板中缺少表头")
	}

	headers := normalizeImportedHeaderRow(rows[headerRowIndex])
	if len(headers) == 0 {
		return nil, fmt.Errorf("模板中缺少有效表头")
	}

	dataRows := make([][]string, 0, len(rows)-headerRowIndex-1)
	excelRowNumbers := make([]int, 0, len(rows)-headerRowIndex-1)
	for index := headerRowIndex + 1; index < len(rows); index++ {
		row := padImportedRow(rows[index], len(headers))
		if isImportedRowEmpty(row) {
			continue
		}
		dataRows = append(dataRows, row)
		excelRowNumbers = append(excelRowNumbers, index+1)
		if len(dataRows) > sheetImportMaxRows {
			return nil, &SheetImportError{Row: index + 1, Message: fmt.Sprintf("导入数据不能超过 %d 行", sheetImportMaxRows)}
		}
	}

	columns := inferImportedColumns(headers, dataRows)
	columnJSON, err := json.Marshal(columns)
	if err != nil {
		return nil, fmt.Errorf("序列化列结构失败: %w", err)
	}

	rowPayloads := make([]json.RawMessage, 0, len(dataRows))
	for index, row := range dataRows {
		payload, err := buildImportedRowPayload(columns, row)
		if err != nil {
			return nil, &SheetImportError{Row: excelRowNumbers[index], Message: err.Error()}
		}
		rowPayloads = append(rowPayloads, payload)
	}

	config, attachmentID, attachmentURL := s.buildImportSheetConfig(userID, filename, data)
	sheet := &model.Sheet{
		WorkbookID: workbookID,
		Name:       resolveImportedSheetName(requestedSheetName, filename, firstSheetName),
		Columns:    columnJSON,
		Config:     config,
	}
	if err := s.sheetService.CreateSheetForUser(userID, sheet); err != nil {
		return nil, err
	}

	for index, payload := range rowPayloads {
		if err := s.sheetRepo.UpsertRow(sheet.ID, index, payload, userID); err != nil {
			_ = s.sheetRepo.DeleteSheet(sheet.ID)
			return nil, fmt.Errorf("写入第 %d 行数据失败: %w", excelRowNumbers[index], err)
		}
	}

	return &SheetImportResult{
		Sheet:         sheet,
		ImportedRows:  len(rowPayloads),
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

func (s *SheetImportService) buildImportSheetConfig(userID int64, filename string, data []byte) (json.RawMessage, *int64, string) {
	payload := map[string]any{
		"importSource": map[string]any{
			"filename":    filename,
			"imported_at": time.Now().Format(time.RFC3339),
		},
	}

	var attachmentID *int64
	attachmentURL := ""
	if s.uploadSvc != nil {
		attachment, url, err := s.uploadSvc.UploadBytes(filename, sheetExportContentType, data, userID)
		if err == nil {
			attachmentID = &attachment.ID
			attachmentURL = url
			payload["importSource"].(map[string]any)["attachment_id"] = attachment.ID
			payload["importSource"].(map[string]any)["attachment_url"] = url
		}
	}

	config, err := json.Marshal(payload)
	if err != nil {
		return json.RawMessage(`{}`), attachmentID, attachmentURL
	}
	return config, attachmentID, attachmentURL
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

func normalizeImportedHeaderRow(row []string) []string {
	trimmed := trimTrailingImportedCells(row)
	result := make([]string, 0, len(trimmed))
	for index, cell := range trimmed {
		value := strings.TrimSpace(cell)
		if value == "" {
			value = fmt.Sprintf("列%d", index+1)
		}
		result = append(result, value)
	}
	return result
}

func inferImportedColumns(headers []string, dataRows [][]string) []sheetColumnPayload {
	seenKeys := make(map[string]int)
	columns := make([]sheetColumnPayload, 0, len(headers))
	for index, header := range headers {
		samples := importedColumnSamples(dataRows, index)
		columnType, options := inferImportedColumnType(header, samples)
		key := buildImportedColumnKey(header, index, seenKeys)
		column := sheetColumnPayload{
			Key:   key,
			Name:  header,
			Type:  columnType,
			Width: 140,
		}
		if len(options) > 0 {
			column.Options = options
		}
		if columnType == "currency" {
			column.CurrencyCode = "CNY"
		}
		columns = append(columns, column)
	}
	return columns
}

func importedColumnSamples(dataRows [][]string, index int) []string {
	result := make([]string, 0, len(dataRows))
	for _, row := range dataRows {
		if index >= len(row) {
			continue
		}
		value := strings.TrimSpace(row[index])
		if value != "" {
			result = append(result, value)
		}
	}
	return result
}

func inferImportedColumnType(header string, samples []string) (string, []string) {
	label := strings.ToLower(strings.TrimSpace(header))
	switch {
	case strings.Contains(label, "日期") || strings.Contains(label, "时间") || strings.Contains(label, "date") || strings.Contains(label, "time"):
		return "date", nil
	case strings.Contains(label, "薪") || strings.Contains(label, "金额") || strings.Contains(label, "预算") || strings.Contains(label, "salary") || strings.Contains(label, "amount"):
		return "currency", nil
	case strings.Contains(label, "年龄") || strings.Contains(label, "数量") || strings.Contains(label, "编号") || strings.Contains(label, "age") || strings.Contains(label, "count"):
		return "number", nil
	case strings.Contains(label, "绩效") || strings.Contains(label, "等级") || strings.Contains(label, "状态") || strings.Contains(label, "status") || strings.Contains(label, "grade"):
		return "select", buildImportedOptions(samples)
	}

	if len(samples) > 0 && allImportedSamplesNumeric(samples) {
		return "number", nil
	}
	if len(samples) > 0 && allImportedSamplesDateLike(samples) {
		return "date", nil
	}
	options := buildImportedOptions(samples)
	if len(options) >= 2 && len(options) <= 8 {
		return "select", options
	}
	return "text", nil
}

func buildImportedOptions(samples []string) []string {
	seen := make(map[string]struct{})
	options := make([]string, 0, len(samples))
	for _, sample := range samples {
		value := strings.TrimSpace(sample)
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		options = append(options, value)
	}
	return options
}

func allImportedSamplesNumeric(samples []string) bool {
	for _, sample := range samples {
		if _, ok := parseImportedNumeric(sample); !ok {
			return false
		}
	}
	return len(samples) > 0
}

func allImportedSamplesDateLike(samples []string) bool {
	for _, sample := range samples {
		if _, ok := parseImportedDate(sample); !ok {
			return false
		}
	}
	return len(samples) > 0
}

func buildImportedColumnKey(header string, index int, seen map[string]int) string {
	base := strings.TrimSpace(strings.ToLower(header))
	if base == "" {
		base = fmt.Sprintf("col_%d", index+1)
	}

	var builder strings.Builder
	lastUnderscore := false
	for _, r := range base {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			builder.WriteRune(r)
			lastUnderscore = false
		case r == '_':
			if !lastUnderscore && builder.Len() > 0 {
				builder.WriteRune('_')
				lastUnderscore = true
			}
		default:
			if r > 127 {
				builder.WriteRune(r)
				lastUnderscore = false
			} else if !lastUnderscore && builder.Len() > 0 {
				builder.WriteRune('_')
				lastUnderscore = true
			}
		}
	}

	key := strings.Trim(builder.String(), "_")
	if key == "" {
		key = fmt.Sprintf("col_%d", index+1)
	}
	if count := seen[key]; count > 0 {
		seen[key] = count + 1
		return fmt.Sprintf("%s_%d", key, count+1)
	}
	seen[key] = 1
	return key
}

func buildImportedRowPayload(columns []sheetColumnPayload, row []string) (json.RawMessage, error) {
	data := make(map[string]any, len(columns))
	for index, column := range columns {
		if index >= len(row) {
			continue
		}
		value := strings.TrimSpace(row[index])
		if value == "" {
			continue
		}
		converted, err := convertImportedCellValue(column, value)
		if err != nil {
			return nil, fmt.Errorf("列「%s」格式无效: %w", firstNonEmpty(column.Name, column.Key), err)
		}
		data[column.Key] = converted
	}

	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, fmt.Errorf("序列化行数据失败: %w", err)
	}
	return encoded, nil
}

func convertImportedCellValue(column sheetColumnPayload, raw string) (any, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return nil, nil
	}

	if strings.HasPrefix(trimmed, "=") {
		return trimmed, nil
	}

	switch strings.ToLower(strings.TrimSpace(column.Type)) {
	case "number", "currency":
		if numeric, ok := parseImportedNumeric(trimmed); ok {
			return numeric, nil
		}
		return nil, fmt.Errorf("需要数字")
	case "date":
		if normalized, ok := parseImportedDate(trimmed); ok {
			return normalized, nil
		}
		return nil, fmt.Errorf("需要日期，支持 YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD")
	default:
		return trimmed, nil
	}
}

func parseImportedNumeric(value string) (any, bool) {
	normalized := strings.NewReplacer(",", "", "¥", "", "$", "", "￥", "", " ", "").Replace(strings.TrimSpace(value))
	if normalized == "" {
		return nil, false
	}
	if !strings.ContainsAny(normalized, ".eE") {
		if integer, err := strconv.Atoi(normalized); err == nil {
			return integer, true
		}
	}
	floatValue, err := strconv.ParseFloat(normalized, 64)
	if err != nil {
		return nil, false
	}
	if floatValue == float64(int64(floatValue)) {
		return int64(floatValue), true
	}
	return floatValue, true
}

func parseImportedDate(value string) (string, bool) {
	trimmed := strings.TrimSpace(value)
	layouts := []string{
		"2006-01-02",
		"2006/01/02",
		"2006.01.02",
		"2006-1-2",
		"2006/1/2",
		"2006.1.2",
		"2006-01-02 15:04:05",
		"2006/01/02 15:04:05",
	}
	for _, layout := range layouts {
		parsed, err := time.Parse(layout, trimmed)
		if err == nil {
			return parsed.Format("2006-01-02"), true
		}
	}
	return "", false
}

func isImportedRowEmpty(row []string) bool {
	for _, cell := range row {
		if strings.TrimSpace(cell) != "" {
			return false
		}
	}
	return true
}

func trimTrailingImportedCells(row []string) []string {
	end := len(row)
	for end > 0 {
		if strings.TrimSpace(row[end-1]) != "" {
			break
		}
		end -= 1
	}
	return row[:end]
}

func padImportedRow(row []string, length int) []string {
	trimmed := trimTrailingImportedCells(row)
	if len(trimmed) >= length {
		return trimmed[:length]
	}
	padded := make([]string, length)
	copy(padded, trimmed)
	return padded
}
