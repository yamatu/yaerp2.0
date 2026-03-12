package service

import (
	"bytes"
	"testing"

	"github.com/phpdave11/gofpdf"
)

func TestRegisterSheetPDFFonts(t *testing.T) {
	pdf := gofpdf.New("P", "mm", "A4", "")
	registerSheetPDFFonts(pdf)
	if err := pdf.Error(); err != nil {
		t.Fatalf("register font: %v", err)
	}

	pdf.AddPage()
	pdf.SetFont(sheetPDFFontFamily, "", 12)
	pdf.CellFormat(60, 10, "测试 PDF 导出", "", 0, "L", false, 0, "")

	buffer := bytes.NewBuffer(nil)
	if err := pdf.Output(buffer); err != nil {
		t.Fatalf("write pdf: %v", err)
	}
	if buffer.Len() == 0 {
		t.Fatal("expected generated pdf bytes")
	}
}
