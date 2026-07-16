package service

import (
	"bytes"
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestSupportedExcelImportFilenames(t *testing.T) {
	tests := []struct {
		name       string
		supported  bool
		nativeRead bool
	}{
		{name: "report.xlsx", supported: true, nativeRead: true},
		{name: "report.XLSM", supported: true, nativeRead: true},
		{name: "template.xltx", supported: true, nativeRead: true},
		{name: "template.xltm", supported: true, nativeRead: true},
		{name: "legacy.xls", supported: true, nativeRead: false},
		{name: "report.csv", supported: false, nativeRead: false},
		{name: "report.xls.exe", supported: false, nativeRead: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := IsSupportedExcelImportFilename(test.name); got != test.supported {
				t.Fatalf("IsSupportedExcelImportFilename() = %v, want %v", got, test.supported)
			}
			if got := IsNativeExcelImportFilename(test.name); got != test.nativeRead {
				t.Fatalf("IsNativeExcelImportFilename() = %v, want %v", got, test.nativeRead)
			}
		})
	}
}

func TestOpenNativeExcelImportFileAcceptsMacroExtension(t *testing.T) {
	source := excelize.NewFile()
	defer func() { _ = source.Close() }()
	sheetName := source.GetSheetName(0)
	if err := source.SetCellValue(sheetName, "A1", "macro workbook"); err != nil {
		t.Fatal(err)
	}
	buffer := bytes.NewBuffer(nil)
	if _, err := source.WriteTo(buffer); err != nil {
		t.Fatal(err)
	}

	imported, err := openNativeExcelImportFile(buffer.Bytes(), "report.xlsm")
	if err != nil {
		t.Fatalf("openNativeExcelImportFile() error = %v", err)
	}
	defer func() { _ = imported.Close() }()
	value, err := imported.GetCellValue(imported.GetSheetName(0), "A1")
	if err != nil {
		t.Fatal(err)
	}
	if value != "macro workbook" {
		t.Fatalf("cell A1 = %q, want %q", value, "macro workbook")
	}
}

func TestNormalizeWorkbookSourceFilenamePreservesExcelFormat(t *testing.T) {
	if got := normalizeWorkbookSourceXLSXFilename("采购台账.xlsm", "采购台账"); got != "采购台账.xlsm" {
		t.Fatalf("normalizeWorkbookSourceXLSXFilename() = %q", got)
	}
	if got := normalizeWorkbookSourceXLSXFilename("采购台账", "采购台账"); got != "采购台账.xlsx" {
		t.Fatalf("normalizeWorkbookSourceXLSXFilename() fallback = %q", got)
	}
}
