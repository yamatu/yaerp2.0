package service

import (
	"bytes"
	"encoding/json"
	"testing"

	"github.com/xuri/excelize/v2"
)

func openExcelImportFixture(t *testing.T, sheetName string, build func(file *excelize.File)) *excelize.File {
	t.Helper()

	source := excelize.NewFile()
	defer func() { _ = source.Close() }()
	if sheetName != "" {
		source.SetSheetName(source.GetSheetName(0), sheetName)
	}
	build(source)

	buffer := bytes.NewBuffer(nil)
	if _, err := source.WriteTo(buffer); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	file, err := excelize.OpenReader(bytes.NewReader(buffer.Bytes()))
	if err != nil {
		t.Fatalf("open fixture: %v", err)
	}
	t.Cleanup(func() { _ = file.Close() })
	return file
}

func TestCollectImportedCellFormulasKeepsFormulasAndCachedValues(t *testing.T) {
	sharedType := excelize.STCellFormulaTypeShared
	file := openExcelImportFixture(t, "Sheet1", func(excel *excelize.File) {
		_ = excel.SetCellValue("Sheet1", "A1", "qty")
		_ = excel.SetCellValue("Sheet1", "B1", "price")
		_ = excel.SetCellValue("Sheet1", "C1", "total")
		_ = excel.SetCellValue("Sheet1", "A2", 2)
		_ = excel.SetCellValue("Sheet1", "B2", 3)
		// Cached value written by Excel next to the formula.
		_ = excel.SetCellValue("Sheet1", "C2", 6)
		_ = excel.SetCellFormula("Sheet1", "C2", "A2*B2")
		_ = excel.SetCellValue("Sheet1", "A3", 4)
		_ = excel.SetCellValue("Sheet1", "B3", 5)
		_ = excel.SetCellValue("Sheet1", "C3", 20)
		_ = excel.SetCellFormula("Sheet1", "C3", "A3*B3", excelize.FormulaOpts{Type: &sharedType, Ref: stringPtr("C2:C3")})
		// Formula without a cached value, like files written by excelize itself.
		_ = excel.SetCellFormula("Sheet1", "D4", "SUM(A2:A3)")
	})

	formulas := collectImportedCellFormulas(file, "Sheet1", 4, 4)
	if len(formulas) != 3 {
		t.Fatalf("expected formulas for 3 rows, got %#v", formulas)
	}
	if got := formulas[2][2]; got != "=A2*B2" {
		t.Fatalf("C2 formula = %q, want %q", got, "=A2*B2")
	}
	if got := formulas[3][2]; got != "=A3*B3" {
		t.Fatalf("shared C3 formula = %q, want %q", got, "=A3*B3")
	}
	if got := formulas[4][3]; got != "=SUM(A2:A3)" {
		t.Fatalf("D4 formula = %q, want %q", got, "=SUM(A2:A3)")
	}
	if got := formulas[2][0]; got != "" {
		t.Fatalf("A2 should not carry a formula, got %q", got)
	}
}

func TestCollectImportedCellFormulasSkipsSheetsWithoutFormulas(t *testing.T) {
	file := openExcelImportFixture(t, "Sheet1", func(excel *excelize.File) {
		_ = excel.SetCellValue("Sheet1", "A1", "name")
		_ = excel.SetCellValue("Sheet1", "A2", "item")
	})

	if formulas := collectImportedCellFormulas(file, "Sheet1", 2, 5); formulas != nil {
		t.Fatalf("expected no formulas, got %#v", formulas)
	}
	if formulas := collectImportedCellFormulas(file, "Sheet1", 0, 5); formulas != nil {
		t.Fatalf("expected no formulas for an empty column range, got %#v", formulas)
	}
}

func TestImportedFormulaLastRowUsesDimensionWithinLimit(t *testing.T) {
	file := openExcelImportFixture(t, "Sheet1", func(excel *excelize.File) {
		_ = excel.SetCellValue("Sheet1", "A1", "name")
		_ = excel.SetCellValue("Sheet1", "A5", "item")
	})

	// excelize does not write a worksheet dimension, so the row count from
	// GetRows is the bound.
	if got := importedFormulaLastRow(file, "Sheet1", 2, 0); got != 2 {
		t.Fatalf("importedFormulaLastRow() = %d, want 2", got)
	}
	if got := importedFormulaLastRow(file, "Sheet1", 9, 0); got != 9 {
		t.Fatalf("importedFormulaLastRow() = %d, want 9", got)
	}
	if got := importedFormulaLastRow(nil, "Sheet1", 3, 0); got != 3 {
		t.Fatalf("importedFormulaLastRow(nil) = %d, want 3", got)
	}
}

func TestImportedDimensionLastRow(t *testing.T) {
	tests := []struct {
		dimension string
		want      int
		ok        bool
	}{
		{dimension: "A1:E6", want: 6, ok: true},
		{dimension: "D4", want: 4, ok: true},
		{dimension: " A1:B100 ", want: 100, ok: true},
		{dimension: "", want: 0, ok: false},
		{dimension: "nonsense", want: 0, ok: false},
	}

	for _, test := range tests {
		t.Run(test.dimension, func(t *testing.T) {
			got, ok := importedDimensionLastRow(test.dimension)
			if ok != test.ok || got != test.want {
				t.Fatalf("importedDimensionLastRow(%q) = (%d, %v), want (%d, %v)", test.dimension, got, ok, test.want, test.ok)
			}
		})
	}
}

func TestImportFormulaRowsSurviveGetRowsTruncation(t *testing.T) {
	// A round trip through the ERP export writes formulas without cached values.
	// Such cells must not disappear from the imported rows.
	file := openExcelImportFixture(t, "Sheet1", func(excel *excelize.File) {
		_ = excel.SetCellValue("Sheet1", "A1", "qty")
		_ = excel.SetCellValue("Sheet1", "B1", "total")
		_ = excel.SetCellValue("Sheet1", "A2", 2)
		_ = excel.SetCellFormula("Sheet1", "B2", "A2*3")
		_ = excel.SetCellValue("Sheet1", "A3", 4)
		_ = excel.SetCellFormula("Sheet1", "B3", "A3*3")
	})

	rows, err := file.GetRows("Sheet1")
	if err != nil {
		t.Fatalf("GetRows: %v", err)
	}
	if len(rows) != 3 {
		t.Fatalf("GetRows returned %d rows, want 3 (%#v)", len(rows), rows)
	}
	formulas := collectImportedCellFormulas(file, "Sheet1", 2, importedFormulaLastRow(file, "Sheet1", len(rows), 0))
	if got := formulas[2][1]; got != "=A2*3" {
		t.Fatalf("B2 formula = %q, want %q", got, "=A2*3")
	}
	if got := formulas[3][1]; got != "=A3*3" {
		t.Fatalf("B3 formula = %q, want %q", got, "=A3*3")
	}
}

func TestBuildImportedRowPayloadKeepsFormulaInsteadOfCachedValue(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "name", Name: "name", Type: "text"},
		{Key: "qty", Name: "qty", Type: "number"},
		{Key: "price", Name: "price", Type: "number"},
		{Key: "total", Name: "total", Type: "number"},
	}
	row := []string{"item-1", "2", "3", "6"}
	formulas := []string{"", "", "", "=B2*C2"}

	payload, err := buildImportedRowPayload(columns, row, formulas)
	if err != nil {
		t.Fatalf("buildImportedRowPayload() error = %v", err)
	}

	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if data["total"] != "=B2*C2" {
		t.Fatalf("formula cell stored %#v, want %q", data["total"], "=B2*C2")
	}
	if data["qty"] != float64(2) || data["price"] != float64(3) {
		t.Fatalf("cached values were not converted: %#v", data)
	}
	if data["name"] != "item-1" {
		t.Fatalf("text cell stored %#v, want %q", data["name"], "item-1")
	}
}

func TestBuildImportedRowPayloadHandlesFormulaOnlyRow(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "qty", Name: "qty", Type: "number"},
		{Key: "total", Name: "total", Type: "number"},
	}
	row := []string{}
	formulas := []string{"2", "=A2*3"}
	formulas[0] = ""

	payload, err := buildImportedRowPayload(columns, row, formulas)
	if err != nil {
		t.Fatalf("buildImportedRowPayload() error = %v", err)
	}

	var data map[string]any
	if err := json.Unmarshal(payload, &data); err != nil {
		t.Fatalf("unmarshal payload: %v", err)
	}
	if len(data) != 1 || data["total"] != "=A2*3" {
		t.Fatalf("unexpected payload: %#v", data)
	}
}

func TestImportedRowKeepsFormula(t *testing.T) {
	if importedRowKeepsFormula(nil) {
		t.Fatal("nil formulas must not count as a formula row")
	}
	if importedRowKeepsFormula([]string{"", ""}) {
		t.Fatal("empty formulas must not count as a formula row")
	}
	if !importedRowKeepsFormula([]string{"", "=A1"}) {
		t.Fatal("expected the row to be kept because it holds a formula")
	}
}
