package service

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestNormalizeAgentSheetColumnsAcceptsCommonAliases(t *testing.T) {
	columns, err := normalizeAgentSheetColumns([]any{
		map[string]any{
			"column_key":  "invoice_no",
			"column_name": "发票号码",
			"column_type": "文本",
			"width":       160.0,
		},
		map[string]any{
			"columnKey":  "payment_method",
			"columnName": "付款方式",
			"format":     "银行转账,现金,支票,电汇,承兑汇票",
		},
	})
	if err != nil {
		t.Fatalf("normalizeAgentSheetColumns() error = %v", err)
	}
	if len(columns) != 2 {
		t.Fatalf("columns length = %d, want 2", len(columns))
	}
	if columns[0].Key != "invoice_no" || columns[0].Name != "发票号码" || columns[0].Type != "text" {
		t.Fatalf("first column = %#v", columns[0])
	}
	if columns[1].Type != "select" {
		t.Fatalf("payment method type = %q, want select", columns[1].Type)
	}
	wantOptions := []string{"银行转账", "现金", "支票", "电汇", "承兑汇票"}
	if !reflect.DeepEqual(columns[1].Options, wantOptions) {
		t.Fatalf("payment method options = %#v, want %#v", columns[1].Options, wantOptions)
	}
}

func TestEnsureAgentWorksheetSnapshotPreservesValuesAndFormulas(t *testing.T) {
	rowData, _ := json.Marshal(map[string]any{"name": "采购单", "amount": "=10*2"})
	sheet := &model.Sheet{ID: 9, Name: "采购", Config: json.RawMessage(`{}`)}
	columns := []sheetColumnPayload{
		{Key: "name", Name: "名称", Type: "text", Width: 160},
		{Key: "amount", Name: "金额", Type: "currency", Width: 120},
	}

	_, worksheet, cellData, err := ensureAgentWorksheetSnapshot(sheet, columns, []model.Row{{RowIndex: 0, Data: rowData}})
	if err != nil {
		t.Fatalf("ensureAgentWorksheetSnapshot() error = %v", err)
	}
	header := cellData["0"].(map[string]any)
	if header["0"].(map[string]any)["v"] != "名称" {
		t.Fatalf("header = %#v", header)
	}
	firstRow := cellData["1"].(map[string]any)
	if firstRow["0"].(map[string]any)["v"] != "采购单" {
		t.Fatalf("first row = %#v", firstRow)
	}
	if firstRow["1"].(map[string]any)["f"] != "=10*2" {
		t.Fatalf("formula cell = %#v", firstRow["1"])
	}
	if worksheet["rowCount"].(int) < 200 || worksheet["columnCount"].(int) < 26 {
		t.Fatalf("worksheet extent = %#v", worksheet)
	}
}

func TestApplyAgentStylePatch(t *testing.T) {
	style := map[string]any{}
	applyAgentStylePatch(style, "#E0F2FE", "#0F172A", "#CBD5E1", "thin", "center", "middle", true, true, false, true, true, true, 12, true)
	if style["bl"] != 1 || style["it"] != 0 || style["ht"] != 2 || style["vt"] != 2 || style["tb"] != 3 {
		t.Fatalf("style flags = %#v", style)
	}
	if style["bg"].(map[string]any)["rgb"] != "#E0F2FE" || style["cl"].(map[string]any)["rgb"] != "#0F172A" {
		t.Fatalf("style colors = %#v", style)
	}
	if _, ok := style["bd"].(map[string]any); !ok {
		t.Fatalf("border missing: %#v", style)
	}
}

func TestNormalizeAgentSheetColumnsRejectsMalformedColumns(t *testing.T) {
	_, err := normalizeAgentSheetColumns([]any{
		map[string]any{"column_name": "供应商", "column_type": "text"},
	})
	if err == nil || !strings.Contains(err.Error(), "缺少 key") {
		t.Fatalf("error = %v, want missing key error", err)
	}

	_, err = normalizeAgentSheetColumns([]any{
		map[string]any{"key": "supplier", "name": "供应商", "type": "text"},
		map[string]any{"key": "supplier", "name": "供应商编号", "type": "text"},
	})
	if err == nil || !strings.Contains(err.Error(), "重复") {
		t.Fatalf("error = %v, want duplicate key error", err)
	}
}

func TestNormalizeRawSpreadsheetOperationsExpandsRowUpdate(t *testing.T) {
	operations, err := normalizeRawSpreadsheetOperations(map[string]any{
		"kind":     "update_row",
		"sheet_id": float64(6),
		"row":      float64(0),
		"values": map[string]any{
			"invoice_no":    "PI-2025-001",
			"supplier_name": "示例供应商有限公司",
		},
	})
	if err != nil {
		t.Fatalf("normalizeRawSpreadsheetOperations() error = %v", err)
	}
	if len(operations) != 2 {
		t.Fatalf("operations length = %d, want 2", len(operations))
	}
	for _, operation := range operations {
		if operation.Kind != "update_cell" || operation.SheetID != 6 || operation.Row != 0 || operation.ColumnKey == "" {
			t.Fatalf("unexpected operation: %#v", operation)
		}
	}
}

func TestNormalizeRawSpreadsheetOperationsInfersRowUpdate(t *testing.T) {
	operations, err := normalizeRawSpreadsheetOperations(map[string]any{
		"sheetId":  float64(6),
		"rowIndex": float64(0),
		"data": map[string]any{
			"invoice_no": "PI-2025-001",
			"quantity":   float64(100),
		},
	})
	if err != nil {
		t.Fatalf("normalizeRawSpreadsheetOperations() error = %v", err)
	}
	if len(operations) != 2 {
		t.Fatalf("operations length = %d, want 2", len(operations))
	}
	for _, operation := range operations {
		if operation.Kind != "update_cell" || operation.SheetID != 6 || operation.Row != 0 {
			t.Fatalf("unexpected operation: %#v", operation)
		}
	}
}

func TestNormalizeRawSpreadsheetOperationAcceptsAliases(t *testing.T) {
	operation, err := normalizeRawSpreadsheetOperation(map[string]any{
		"action":     "set_cell",
		"sheetId":    float64(6),
		"rowIndex":   float64(0),
		"column":     "payment_status",
		"new_value":  "已付款",
		"sheet_name": "采购发票",
	})
	if err != nil {
		t.Fatalf("normalizeRawSpreadsheetOperation() error = %v", err)
	}
	if operation.Kind != "update_cell" || operation.SheetID != 6 || operation.Row != 0 || operation.ColumnKey != "payment_status" || operation.Value != "已付款" {
		t.Fatalf("unexpected operation: %#v", operation)
	}
}

func TestExpandFormulaTemplateUsesColumnKeys(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "unit", Name: "单位"},
		{Key: "quantity", Name: "数量"},
		{Key: "unit_price", Name: "单价"},
		{Key: "amount", Name: "金额"},
	}
	result := expandFormulaTemplate("={{quantity}}*{{unit_price}}", 0, columns)
	if result != "=B2*C2" {
		t.Fatalf("formula = %q, want =B2*C2", result)
	}
}

func TestValidateFormulaTemplateReferencesRejectsTextArithmetic(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "invoice_no", Name: "发票号码", Type: "text"},
		{Key: "invoice_date", Name: "发票日期", Type: "date"},
		{Key: "supplier_name", Name: "供应商名称", Type: "text"},
		{Key: "supplier_tax_no", Name: "供应商税号", Type: "text"},
		{Key: "po_no", Name: "采购订单号", Type: "text"},
		{Key: "description", Name: "货物或服务名称", Type: "text"},
		{Key: "spec", Name: "规格型号", Type: "text"},
		{Key: "unit", Name: "单位", Type: "text"},
		{Key: "quantity", Name: "数量", Type: "number"},
		{Key: "unit_price", Name: "单价", Type: "currency"},
	}
	if err := validateFormulaTemplateReferences("=H{{row}}*J{{row}}", columns); err == nil || !strings.Contains(err.Error(), "非数值列") {
		t.Fatalf("error = %v, want non-numeric reference error", err)
	}
	if err := validateFormulaTemplateReferences("=I{{row}}*J{{row}}", columns); err != nil {
		t.Fatalf("valid numeric formula error = %v", err)
	}
	if err := validateFormulaTemplateReferences("={{quantity}}*{{unit_price}}", columns); err != nil {
		t.Fatalf("valid key formula error = %v", err)
	}
}
