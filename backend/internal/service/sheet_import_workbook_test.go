package service

import (
	"testing"

	"github.com/xuri/excelize/v2"
)

func TestBuildWorkbookImportSheetSnapshotPreservesExcelStructure(t *testing.T) {
	file := excelize.NewFile()
	defer func() { _ = file.Close() }()

	defaultSheet := file.GetSheetName(0)
	const sheetName = "业务台账"
	file.SetSheetName(defaultSheet, sheetName)

	styleID, err := file.NewStyle(&excelize.Style{
		Font:      &excelize.Font{Bold: true, Color: "#FFFFFF", Size: 14},
		Fill:      excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"#2563EB"}},
		Alignment: &excelize.Alignment{Horizontal: "center", Vertical: "center", WrapText: true},
		Border: []excelize.Border{
			{Type: "bottom", Style: 1, Color: "#0F172A"},
		},
	})
	if err != nil {
		t.Fatalf("create style: %v", err)
	}

	if err := file.SetCellValue(sheetName, "A1", "销售汇总"); err != nil {
		t.Fatalf("set title: %v", err)
	}
	if err := file.SetCellStyle(sheetName, "A1", "C1", styleID); err != nil {
		t.Fatalf("set style: %v", err)
	}
	if err := file.MergeCell(sheetName, "A1", "C1"); err != nil {
		t.Fatalf("merge title: %v", err)
	}
	_ = file.SetCellValue(sheetName, "A2", "项目")
	_ = file.SetCellValue(sheetName, "B2", 120)
	_ = file.SetCellValue(sheetName, "B3", 180)
	if err := file.SetCellFormula(sheetName, "B4", "SUM(B2:B3)"); err != nil {
		t.Fatalf("set formula: %v", err)
	}
	if err := file.SetColWidth(sheetName, "A", "A", 24); err != nil {
		t.Fatalf("set column width: %v", err)
	}
	if err := file.SetRowHeight(sheetName, 1, 36); err != nil {
		t.Fatalf("set row height: %v", err)
	}
	if err := file.SetPanes(sheetName, &excelize.Panes{Freeze: true, YSplit: 1, TopLeftCell: "A2", ActivePane: "bottomLeft"}); err != nil {
		t.Fatalf("set panes: %v", err)
	}

	snapshot, err := buildWorkbookImportSheetSnapshot(file, sheetName, 0)
	if err != nil {
		t.Fatalf("build snapshot: %v", err)
	}

	if snapshot.Name != sheetName {
		t.Fatalf("unexpected sheet name: %q", snapshot.Name)
	}
	if snapshot.RowCount < 4 || snapshot.ColumnCount < 2 {
		t.Fatalf("unexpected bounds: rows=%d cols=%d", snapshot.RowCount, snapshot.ColumnCount)
	}
	if got := snapshot.Worksheet.CellData["0"]["0"].Value; got != "销售汇总" {
		t.Fatalf("title value was not imported: %#v", got)
	}
	if got := snapshot.Worksheet.CellData["1"]["1"].Value; got != int64(120) {
		t.Fatalf("numeric value was not imported as a number: %#v", got)
	}
	if got := snapshot.Worksheet.CellData["3"]["1"].Formula; got != "SUM(B2:B3)" {
		t.Fatalf("formula was not imported: %#v", got)
	}
	if len(snapshot.Worksheet.MergeData) != 1 {
		t.Fatalf("merge data missing: %#v", snapshot.Worksheet.MergeData)
	}
	merge := snapshot.Worksheet.MergeData[0]
	if merge.StartRow != 0 || merge.StartColumn != 0 || merge.EndRow != 0 || merge.EndColumn != 2 {
		t.Fatalf("unexpected merge range: %#v", merge)
	}
	if len(snapshot.Styles) == 0 {
		t.Fatalf("expected imported styles")
	}
	if snapshot.Worksheet.ColumnData["0"].Width <= sheetImportDefaultColumnWidth {
		t.Fatalf("column width was not imported: %#v", snapshot.Worksheet.ColumnData["0"])
	}
	if snapshot.Worksheet.RowData["0"].Height <= sheetImportDefaultRowHeight {
		t.Fatalf("row height was not imported: %#v", snapshot.Worksheet.RowData["0"])
	}
	if snapshot.Worksheet.Freeze.YSplit != 1 || snapshot.Worksheet.Freeze.StartRow != 1 {
		t.Fatalf("freeze pane was not imported: %#v", snapshot.Worksheet.Freeze)
	}
}
