package service

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"

	"github.com/xuri/excelize/v2"
)

var nativeExcelImportExtensions = map[string]string{
	".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
	".xltx": "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
	".xltm": "application/vnd.ms-excel.template.macroEnabled.12",
}

const legacyExcelImportExtension = ".xls"

type SpreadsheetImportSource struct {
	Filename string
	Data     []byte
}

func IsNativeExcelImportFilename(filename string) bool {
	_, ok := nativeExcelImportExtensions[strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))]
	return ok
}

func IsSupportedExcelImportFilename(filename string) bool {
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	return extension == legacyExcelImportExtension || IsNativeExcelImportFilename(filename)
}

func IsLegacyExcelImportFilename(filename string) bool {
	return strings.EqualFold(filepath.Ext(strings.TrimSpace(filename)), legacyExcelImportExtension)
}

func excelImportContentType(filename string) string {
	extension := strings.ToLower(filepath.Ext(strings.TrimSpace(filename)))
	if extension == legacyExcelImportExtension {
		return "application/vnd.ms-excel"
	}
	if contentType, ok := nativeExcelImportExtensions[extension]; ok {
		return contentType
	}
	return sheetExportContentType
}

func openNativeExcelImportFile(data []byte, filename string) (*excelize.File, error) {
	if !IsNativeExcelImportFilename(filename) {
		return nil, fmt.Errorf("不支持的 Excel 格式")
	}
	file, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("解析 Excel 文件失败: %w", err)
	}
	return file, nil
}
