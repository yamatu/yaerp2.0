package service

import (
	"strings"
	"testing"
)

func TestRenderSheetPDFHTMLIncludesMergedStyledCells(t *testing.T) {
	style := &univerStyleData{Bl: intPtr(1), Ht: intPtr(2)}
	grid := &sheetPDFGrid{
		SheetName:       "测试",
		Rows:            []int{0, 1},
		Columns:         []int{0, 1},
		RowHeights:      map[int]float64{0: 8, 1: 8},
		ColumnWidths:    map[int]float64{0: 20, 1: 24},
		Cells:           map[string]sheetPDFCell{"0:0": {Text: "标题", Style: style}, "1:0": {Text: "值"}, "1:1": {Text: "内容"}},
		MergeStarts:     map[string]univerExportRange{"0:0": {StartRow: 0, StartColumn: 0, EndRow: 0, EndColumn: 1}},
		MergeCovered:    map[string]bool{"0:1": true},
		ShowGridlines:   true,
		DefaultFontSize: 10,
	}

	htmlDoc := renderSheetPDFHTML(grid, buildSheetPDFLayout(grid))
	checks := []string{"@font-face", "colspan=\"2\"", "标题", "font-weight:700", "text-align:center"}
	for _, check := range checks {
		if !strings.Contains(htmlDoc, check) {
			t.Fatalf("expected html to contain %q", check)
		}
	}
}
