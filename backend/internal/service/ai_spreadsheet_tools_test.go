package service

import (
	"strings"
	"testing"
)

func TestParseSpreadsheetScriptStatementKinds(t *testing.T) {
	program, err := parseSpreadsheetScript(strings.Join([]string{
		"# 统计已付款订单",
		`select where status = "已付款"`,
		"filter where amount > 1000 and region contains 华南",
		"sort by amount desc",
		"compute total = SUM({{amount}})",
		`set note = "已核对"`,
	}, "\n"))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(program.Steps) != 5 {
		t.Fatalf("steps = %d, want 5 (comments and blank lines are skipped)", len(program.Steps))
	}

	if program.Steps[0].Op != "select" || len(program.Steps[0].Condition) != 1 {
		t.Fatalf("select step = %+v", program.Steps[0])
	}
	if program.Steps[0].Condition[0].ColumnKey != "status" || program.Steps[0].Condition[0].Value != "已付款" {
		t.Fatalf("select condition = %+v", program.Steps[0].Condition[0])
	}

	if program.Steps[1].Op != "filter" || len(program.Steps[1].Condition) != 2 {
		t.Fatalf("filter step = %+v", program.Steps[1])
	}
	if op := program.Steps[1].Condition[1].Op; op != "contains" {
		t.Fatalf("second filter op = %q, want contains", op)
	}

	if program.Steps[2].Op != "sort" || program.Steps[2].Column != "amount" || !program.Steps[2].Descending {
		t.Fatalf("sort step = %+v", program.Steps[2])
	}

	if program.Steps[3].Op != "compute" || program.Steps[3].Column != "total" {
		t.Fatalf("compute step = %+v", program.Steps[3])
	}
	if !strings.EqualFold(program.Steps[3].Formula, "SUM({{amount}})") {
		t.Fatalf("compute formula = %q", program.Steps[3].Formula)
	}

	if program.Steps[4].Op != "set" || program.Steps[4].Set["note"] != "已核对" {
		t.Fatalf("set step = %+v", program.Steps[4])
	}
}

func TestParseSpreadsheetScriptRejectsUnknownVerb(t *testing.T) {
	_, err := parseSpreadsheetScript("delete everything")
	if err == nil {
		t.Fatal("expected an error for an unsupported keyword")
	}
	if !strings.Contains(err.Error(), "delete") {
		t.Fatalf("error should name the bad keyword, got %v", err)
	}
}

func TestParseSpreadsheetScriptRejectsBrokenSort(t *testing.T) {
	if _, err := parseSpreadsheetScript("sort"); err == nil {
		t.Fatal("expected an error for a sort without a column")
	}
	if _, err := parseSpreadsheetScript("sort by amount sideways"); err == nil {
		t.Fatal("expected an error for an unknown sort direction")
	}
}

func TestParseSpreadsheetScriptRejectsUnparseableCondition(t *testing.T) {
	if _, err := parseSpreadsheetScript("select where nothing at all"); err == nil {
		t.Fatal("expected an error for a condition without an operator")
	}
}

func TestParseSpreadsheetScriptSetRequiresAssignment(t *testing.T) {
	if _, err := parseSpreadsheetScript("set note"); err == nil {
		t.Fatal("expected an error for a set without '='")
	}
}

func TestParseScriptLiteralKinds(t *testing.T) {
	cases := []struct {
		input string
		want  any
	}{
		{`"已付款"`, "已付款"},
		{`'quoted'`, "quoted"},
		{`“中文引号”`, "中文引号"},
		{"42", float64(42)},
		{"3.5", 3.5},
		{"true", true},
		{"否", false},
		{"空", ""},
		{"plain", "plain"},
	}
	for _, testCase := range cases {
		if got := parseScriptLiteral(testCase.input); got != testCase.want {
			t.Fatalf("parseScriptLiteral(%q) = %#v, want %#v", testCase.input, got, testCase.want)
		}
	}
}

func TestSplitScriptAndIgnoresQuotedAndNestedSeparators(t *testing.T) {
	clauses := splitScriptAnd(`a = "x and y" and b = 1`)
	if len(clauses) != 2 {
		t.Fatalf("clauses = %d, want 2: %#v", len(clauses), clauses)
	}
	if !strings.Contains(clauses[0], `"x and y"`) {
		t.Fatalf("quoted separator was split: %#v", clauses[0])
	}
}

// ---------------------------------------------------------------------------
// Condition evaluation
// ---------------------------------------------------------------------------

func TestMatchFilterConditionOperators(t *testing.T) {
	row := map[string]any{"status": "已付款", "amount": 1500.0, "note": ""}

	cases := []struct {
		name      string
		condition filterCondition
		want      bool
	}{
		{"equals text", filterCondition{ColumnKey: "status", Op: "equals", Value: "已付款"}, true},
		{"equals mismatch", filterCondition{ColumnKey: "status", Op: "equals", Value: "待付款"}, false},
		{"equals numeric string", filterCondition{ColumnKey: "amount", Op: "equals", Value: "1500"}, true},
		{"not equals", filterCondition{ColumnKey: "status", Op: "not_equals", Value: "待付款"}, true},
		{"contains", filterCondition{ColumnKey: "status", Op: "contains", Value: "付款"}, true},
		{"not contains", filterCondition{ColumnKey: "status", Op: "not_contains", Value: "退款"}, true},
		{"starts with", filterCondition{ColumnKey: "status", Op: "starts_with", Value: "已"}, true},
		{"greater than", filterCondition{ColumnKey: "amount", Op: "gt", Value: 1000}, true},
		{"greater equal", filterCondition{ColumnKey: "amount", Op: "gte", Value: 1500}, true},
		{"less than", filterCondition{ColumnKey: "amount", Op: "lt", Value: 1000}, false},
		{"less equal", filterCondition{ColumnKey: "amount", Op: "lte", Value: 1500}, true},
		{"empty", filterCondition{ColumnKey: "note", Op: "empty"}, true},
		{"not empty", filterCondition{ColumnKey: "status", Op: "not_empty"}, true},
		{"in list", filterCondition{ColumnKey: "status", Op: "in", Value: []any{"已付款", "已发货"}}, true},
		{"in list miss", filterCondition{ColumnKey: "status", Op: "in", Value: []any{"退款"}}, false},
		{"unknown op falls back to contains", filterCondition{ColumnKey: "status", Op: "resembles", Value: "付款"}, true},
	}
	for _, testCase := range cases {
		if got := matchFilterCondition(row[testCase.condition.ColumnKey], testCase.condition); got != testCase.want {
			t.Fatalf("%s: got %v, want %v", testCase.name, got, testCase.want)
		}
	}
}

func TestSheetValuesMatchRequiresAllConditions(t *testing.T) {
	values := map[string]any{"status": "已付款", "amount": 500.0}
	conditions := []filterCondition{
		{ColumnKey: "status", Op: "equals", Value: "已付款"},
		{ColumnKey: "amount", Op: "gt", Value: 1000},
	}
	if sheetValuesMatch(values, conditions) {
		t.Fatal("all conditions must match, the amount condition fails")
	}
}

func TestCompareSheetValuesOrdersNumbersNumerically(t *testing.T) {
	// String comparison would put "9" after "10"; the numeric path must not.
	if compareSheetValues(9, 10) >= 0 {
		t.Fatal("9 must sort before 10")
	}
	if compareSheetValues("10", "9") <= 0 {
		t.Fatal("numeric strings must compare numerically")
	}
	if compareSheetValues("apple", "banana") >= 0 {
		t.Fatal("text must compare alphabetically")
	}
	if compareSheetValues("Apple", "apple") != 0 {
		t.Fatal("text comparison must be case-insensitive")
	}
}

func TestNormalizeComparableValueUnwrapsCellStructures(t *testing.T) {
	if got := normalizeComparableValue(map[string]any{"value": 12.5}); got != 12.5 {
		t.Fatalf("map value = %#v", got)
	}
	if got := normalizeComparableValue(map[string]any{"label": "已付款"}); got != "已付款" {
		t.Fatalf("map label = %#v", got)
	}
	if got := normalizeComparableValue([]any{"a", "b"}); got != "a,b" {
		t.Fatalf("slice = %#v", got)
	}
	if got := normalizeComparableValue(nil); got != "" {
		t.Fatalf("nil = %#v", got)
	}
}

func TestToFloatRejectsNonNumericText(t *testing.T) {
	if _, ok := toFloat("已付款"); ok {
		t.Fatal("text must not be treated as a number")
	}
	if value, ok := toFloat(" 42.5 "); !ok || value != 42.5 {
		t.Fatalf("toFloat(\" 42.5 \") = %v, %v", value, ok)
	}
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

func TestComputeSelectionAggregate(t *testing.T) {
	visible := []map[string]any{
		{"amount": 100.0, "note": "a"},
		{"amount": 200.0, "note": ""},
		{"amount": "300", "note": "c"},
		{"amount": nil, "note": ""},
	}
	selection := []int{0, 1, 2, 3}

	cases := []struct {
		formula string
		want    any
	}{
		{"SUM(amount)", 600.0},
		{"AVG(amount)", 200.0},
		{"COUNT(amount)", 4},
		{"COUNT_NON_EMPTY(note)", 2},
		{"MIN(amount)", 100.0},
		{"MAX(amount)", 300.0},
	}
	for _, testCase := range cases {
		got, err := computeSelectionAggregate(visible, selection, "amount", testCase.formula)
		if testCase.formula == "COUNT_NON_EMPTY(note)" {
			if err != nil {
				t.Fatalf("%s: %v", testCase.formula, err)
			}
			if got != testCase.want {
				t.Fatalf("%s = %v, want %v", testCase.formula, got, testCase.want)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", testCase.formula, err)
		}
		if got != testCase.want {
			t.Fatalf("%s = %v, want %v", testCase.formula, got, testCase.want)
		}
	}
}

func TestComputeSelectionAggregateRejectsUnknownFunction(t *testing.T) {
	if _, err := computeSelectionAggregate(nil, nil, "amount", "MEDIAN(amount)"); err == nil {
		t.Fatal("expected an error for an unsupported aggregate")
	}
}

func TestComputeSelectionAggregateHandlesNoNumbers(t *testing.T) {
	visible := []map[string]any{{"amount": "n/a"}}
	if value, err := computeSelectionAggregate(visible, []int{0}, "amount", "AVG(amount)"); err != nil || value != nil {
		t.Fatalf("AVG over text = %v, %v; want nil, nil", value, err)
	}
	if value, err := computeSelectionAggregate(visible, []int{0}, "amount", "SUM(amount)"); err != nil || value != 0.0 {
		t.Fatalf("SUM over text = %v, %v; want 0, nil", value, err)
	}
}

// ---------------------------------------------------------------------------
// Batch parsing
// ---------------------------------------------------------------------------

func TestParseBatchCellUpdatesAcceptsBothShapes(t *testing.T) {
	updates, err := parseBatchCellUpdates(map[string]any{
		"rows": []any{
			map[string]any{"row": 0, "values": map[string]any{"qty": 3, "price": 12.5}},
			map[string]any{"row": 1, "values": map[string]any{"qty": 4}},
		},
	})
	if err != nil {
		t.Fatalf("row shape: %v", err)
	}
	// Two columns for row 0 plus one for row 1.
	if len(updates) != 3 {
		t.Fatalf("updates = %d, want 3", len(updates))
	}

	updates, err = parseBatchCellUpdates(map[string]any{
		"updates": []any{
			map[string]any{"row": 2, "column_key": "qty", "value": 5},
		},
	})
	if err != nil {
		t.Fatalf("update shape: %v", err)
	}
	if len(updates) != 1 || updates[0].ColumnKey != "qty" || updates[0].Row == nil || *updates[0].Row != 2 {
		t.Fatalf("updates = %+v", updates)
	}
}

func TestParseBatchCellUpdatesRejectsIncompleteEntries(t *testing.T) {
	if _, err := parseBatchCellUpdates(map[string]any{
		"rows": []any{map[string]any{"row": 0}},
	}); err == nil {
		t.Fatal("expected an error for a row without values")
	}
	if _, err := parseBatchCellUpdates(map[string]any{
		"updates": []any{map[string]any{"row": 0, "column_key": "qty"}},
	}); err == nil {
		t.Fatal("expected an error for an update without a value")
	}
}

func TestParseBatchCellUpdatesIsEmptyWithoutInput(t *testing.T) {
	updates, err := parseBatchCellUpdates(map[string]any{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(updates) != 0 {
		t.Fatalf("updates = %d, want 0", len(updates))
	}
}

func TestParseFilterConditionsDefaultsAndValidation(t *testing.T) {
	conditions, err := parseFilterConditions(map[string]any{
		"conditions": []any{
			map[string]any{"column_key": "status", "value": "已付款"},
			map[string]any{"column_key": "amount", "op": "GT", "value": 100},
		},
	})
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if conditions[0].Op != "equals" {
		t.Fatalf("default op = %q, want equals", conditions[0].Op)
	}
	if conditions[1].Op != "gt" {
		t.Fatalf("op = %q, want gt (lower-cased)", conditions[1].Op)
	}

	if _, err := parseFilterConditions(map[string]any{
		"conditions": []any{map[string]any{"op": "equals", "value": 1}},
	}); err == nil {
		t.Fatal("expected an error for a condition without a column")
	}
}

func TestBoolArgAcceptsCommonTruthyForms(t *testing.T) {
	cases := map[any]bool{
		true: true, "true": true, "1": true, "是": true,
		false: false, "false": false, "no": false, 1: false,
	}
	for input, want := range cases {
		if got := boolArg(map[string]any{"apply": input}, "apply"); got != want {
			t.Fatalf("boolArg(%#v) = %v, want %v", input, got, want)
		}
	}
	if boolArg(map[string]any{}, "apply") {
		t.Fatal("a missing key must default to false")
	}
}
