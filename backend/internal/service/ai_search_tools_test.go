package service

import (
	"encoding/json"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func testCandidate(sheetID int64, name string, hidden bool) sheetSearchCandidate {
	return sheetSearchCandidate{
		Sheet:        &model.Sheet{ID: sheetID, Name: name, IsHidden: hidden},
		WorkbookID:   7,
		WorkbookName: "工作簿",
	}
}

func TestOpenSheetContextFromChatContextCapturesHints(t *testing.T) {
	workbookID := int64(11)
	startRow := 3
	endRow := 8
	context := openSheetContextFromChatContext(&ChatContext{
		WorkbookID: &workbookID,
		SheetIDs:   []int64{21, 22, 0, -3, 21},
		Selection: &ChatSelectionContext{
			SheetID:    22,
			StartRow:   &startRow,
			EndRow:     &endRow,
			ColumnKeys: []string{" sku ", "sku", "qty"},
		},
	})
	if context == nil {
		t.Fatal("expected an open sheet context")
	}
	if context.WorkbookID != 11 {
		t.Fatalf("workbook id = %d, want 11", context.WorkbookID)
	}
	if len(context.SheetIDs) != 2 || context.SheetIDs[0] != 21 || context.SheetIDs[1] != 22 {
		t.Fatalf("sheet ids = %v, want [21 22]", context.SheetIDs)
	}
	if context.ActiveSheetID != 22 {
		t.Fatalf("active sheet = %d, want 22", context.ActiveSheetID)
	}
	if context.SelectionStartRow == nil || *context.SelectionStartRow != 3 {
		t.Fatalf("selection start = %v, want 3", context.SelectionStartRow)
	}
	if len(context.SelectionColumns) != 2 {
		t.Fatalf("selection columns = %v, want 2 unique entries", context.SelectionColumns)
	}

	injected := map[string]any{}
	context.inject(injected)
	if injected["_open_workbook_id"] != int64(11) {
		t.Fatalf("_open_workbook_id = %v, want 11", injected["_open_workbook_id"])
	}
	if injected["_open_active_sheet_id"] != int64(22) {
		t.Fatalf("_open_active_sheet_id = %v, want 22", injected["_open_active_sheet_id"])
	}
	if injected["_open_selection_start_row"] != 3 {
		t.Fatalf("_open_selection_start_row = %v, want 3", injected["_open_selection_start_row"])
	}
	sheetIDs, ok := injected["_open_sheet_ids"].([]int64)
	if !ok || len(sheetIDs) != 2 {
		t.Fatalf("_open_sheet_ids = %v, want two ids", injected["_open_sheet_ids"])
	}
}

func TestOpenSheetContextFromChatContextIsNilWhenEmpty(t *testing.T) {
	if context := openSheetContextFromChatContext(nil); context != nil {
		t.Fatalf("nil chat context produced %#v", context)
	}
	if context := openSheetContextFromChatContext(&ChatContext{}); context != nil {
		t.Fatalf("empty chat context produced %#v", context)
	}
}

func TestOpenWorkbookIDArgPrefersExplicitArgument(t *testing.T) {
	if got := openWorkbookIDArg(map[string]any{"workbook_id": float64(5), "_open_workbook_id": int64(9)}); got != 5 {
		t.Fatalf("explicit workbook id = %d, want 5", got)
	}
	if got := openWorkbookIDArg(map[string]any{"_open_workbook_id": int64(9)}); got != 9 {
		t.Fatalf("context workbook id = %d, want 9", got)
	}
	if got := openWorkbookIDArg(map[string]any{}); got != 0 {
		t.Fatalf("missing workbook id = %d, want 0", got)
	}
}

func TestPlanSheetSearchTargetsPutsTheOpenWorkbookFirst(t *testing.T) {
	targets, skippedHidden, exhausted := planSheetSearchTargets(
		"all", 7, nil, 10,
		[]sheetSearchCandidate{testCandidate(1, "当前表", false), testCandidate(2, "隐藏表", true)},
		[]sheetSearchCandidate{testCandidate(3, "其它表", false), testCandidate(1, "重复表", false)},
	)
	if skippedHidden != 1 {
		t.Fatalf("skipped hidden = %d, want 1", skippedHidden)
	}
	if exhausted {
		t.Fatal("budget should not be exhausted")
	}
	if len(targets) != 2 {
		t.Fatalf("targets = %d entries, want 2 (hidden skipped, duplicate deduped)", len(targets))
	}
	if targets[0].Tier != "open_workbook" || targets[0].Sheet.ID != 1 {
		t.Fatalf("first target = %+v, want the open workbook tier first", targets[0])
	}
	if targets[1].Tier != "other_workbooks" || targets[1].Sheet.ID != 3 {
		t.Fatalf("second target = %+v, want the other workbook tier", targets[1])
	}
}

func TestPlanSheetSearchTargetsDoesNotFanOutForCurrentScope(t *testing.T) {
	targets, _, _ := planSheetSearchTargets(
		"current", 7, nil, 10,
		[]sheetSearchCandidate{testCandidate(1, "当前表", false)},
		[]sheetSearchCandidate{testCandidate(3, "其它表", false)},
	)
	if len(targets) != 1 || targets[0].Sheet.ID != 1 {
		t.Fatalf("current scope targets = %+v, want only the open workbook", targets)
	}
}

func TestPlanSheetSearchTargetsHonoursTheSheetBudget(t *testing.T) {
	others := make([]sheetSearchCandidate, 0, 10)
	for index := int64(20); index < 30; index++ {
		others = append(others, testCandidate(index, "其它表", false))
	}
	targets, _, exhausted := planSheetSearchTargets(
		"all", 7, nil, 3,
		[]sheetSearchCandidate{testCandidate(1, "当前表", false)},
		others,
	)
	if !exhausted {
		t.Fatal("expected the budget to be exhausted")
	}
	if len(targets) != 3 {
		t.Fatalf("targets = %d, want the budget of 3", len(targets))
	}
	if targets[0].Sheet.ID != 1 {
		t.Fatalf("first target = %d, want the open workbook sheet", targets[0].Sheet.ID)
	}
}

func TestPlanSheetSearchTargetsRestrictsToRequestedSheets(t *testing.T) {
	targets, _, _ := planSheetSearchTargets(
		"all", 7, []int64{3}, 10,
		[]sheetSearchCandidate{testCandidate(1, "当前表", false)},
		[]sheetSearchCandidate{testCandidate(3, "其它表", false), testCandidate(4, "别的表", false)},
	)
	if len(targets) != 1 || targets[0].Sheet.ID != 3 {
		t.Fatalf("targets = %+v, want only sheet 3", targets)
	}
}

func TestSplitSearchQueryAcceptsShorthandLists(t *testing.T) {
	got := splitSearchQuery("A1001，A1002, A1003")
	if len(got) != 3 {
		t.Fatalf("split = %v, want three entries", got)
	}
	for index, want := range []string{"A1001", "A1002", "A1003"} {
		if got[index] != want {
			t.Fatalf("split[%d] = %q, want %q", index, got[index], want)
		}
	}
	if splitSearchQuery("   ") != nil {
		t.Fatal("blank query should produce no keywords")
	}
}

func TestRowDataMayContainKeywordsNeverRejectsAMatchingRow(t *testing.T) {
	row := map[string]interface{}{"sku": "A1001", "qty": 12}
	if !rowDataMayContainKeywords(row, []string{"a1001"}, "any") {
		t.Fatal("expected a case-insensitive substring hit")
	}
	if !rowDataMayContainKeywords(row, []string{"A1001", "12"}, "all") {
		t.Fatal("expected every keyword to be found")
	}
	if rowDataMayContainKeywords(row, []string{"A1001", "missing"}, "all") {
		t.Fatal("mode=all must require every keyword")
	}
	if rowDataMayContainKeywords(row, []string{"missing"}, "any") {
		t.Fatal("unrelated keyword must not match")
	}
	if rowDataMayContainKeywords(map[string]interface{}{"sku": nil}, []string{"sku"}, "any") {
		t.Fatal("nil cells carry no text")
	}
	if rowDataMayContainKeywords(nil, []string{"sku"}, "any") {
		t.Fatal("empty rows cannot match")
	}
}

func TestRowDataMayContainKeywordsAgreesWithTheAuthoritativeMatcher(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "sku", Name: "编号"}, {Key: "qty", Name: "数量"}}
	row := map[string]interface{}{"sku": "A1001", "qty": 12}
	cases := []struct {
		keywords []string
		mode     string
	}{
		{[]string{"a100"}, "any"},
		{[]string{"1"}, "any"},
		{[]string{"A1001", "12"}, "all"},
		{[]string{"nope"}, "any"},
	}
	for _, testCase := range cases {
		authoritative := len(collectRowKeywordMatches(row, columns, testCase.keywords, testCase.mode)) > 0
		cheap := rowDataMayContainKeywords(row, testCase.keywords, testCase.mode)
		if authoritative && !cheap {
			t.Fatalf("cheap pre-test rejected a row the matcher accepted: %v/%s", testCase.keywords, testCase.mode)
		}
		if !authoritative && !cheap {
			continue
		}
	}
}

func TestSearchSheetContentRequiresKeywords(t *testing.T) {
	service := &AIService{}
	if _, err := service.toolSearchSheetContent(1, map[string]any{}); err == nil {
		t.Fatal("expected an error when keywords are missing")
	}
}

func TestSearchSheetContentWorkbookScopeNeedsWorkbook(t *testing.T) {
	service := &AIService{}
	_, err := service.toolSearchSheetContent(1, map[string]any{
		"keywords": []any{"abc"},
		"scope":    "workbook",
	})
	if err == nil || !strings.Contains(err.Error(), "workbook_id") {
		t.Fatalf("expected a workbook_id error, got %v", err)
	}
}

func TestSearchSheetContentRejectsUnknownScope(t *testing.T) {
	service := &AIService{}
	_, err := service.toolSearchSheetContent(1, map[string]any{
		"keywords": []any{"abc"},
		"scope":    "everything",
	})
	if err == nil || !strings.Contains(err.Error(), "scope") {
		t.Fatalf("expected a scope error, got %v", err)
	}
}

func TestSearchToolsAreRegisteredAndDefined(t *testing.T) {
	service := &AIService{tools: map[string]ToolFunc{}}
	registry := service.buildToolRegistry()
	names := []string{"get_open_workbook_context", "search_sheet_content"}
	for _, name := range names {
		if _, ok := registry[name]; !ok {
			t.Fatalf("tool %q is not registered", name)
		}
	}

	defined := map[string]bool{}
	for _, definition := range service.buildToolDefinitions() {
		defined[definition.Function.Name] = true
	}
	for _, name := range names {
		if !defined[name] {
			t.Fatalf("tool %q has no definition sent to the model", name)
		}
		if !readOnlyAgentTools[name] {
			t.Fatalf("tool %q must be read-only", name)
		}
		if label := toolDisplayLabel(name); label == name {
			t.Fatalf("tool %q has no Chinese display label", name)
		}
	}
}

func TestSearchSheetContentDefinitionDocumentsTiering(t *testing.T) {
	service := &AIService{tools: map[string]ToolFunc{}}
	for _, definition := range service.buildToolDefinitions() {
		if definition.Function.Name != "search_sheet_content" {
			continue
		}
		description := definition.Function.Description
		if !strings.Contains(description, "currently has open") || !strings.Contains(description, "FIRST") {
			t.Fatalf("search_sheet_content description does not explain tiering: %q", description)
		}
		properties, ok := definition.Function.Parameters["properties"].(map[string]any)
		if !ok {
			t.Fatal("search_sheet_content has no properties")
		}
		if _, ok := properties["scope"]; !ok {
			t.Fatal("search_sheet_content must expose the scope parameter")
		}
		return
	}
	t.Fatal("search_sheet_content definition not found")
}

func TestCriteriaMayMatchRowNeverRejectsAMatchingRow(t *testing.T) {
	columns := []sheetColumnPayload{{Key: "sku", Name: "编号"}, {Key: "qty", Name: "数量"}}
	row := map[string]interface{}{"sku": "A1001", "qty": 12}
	cases := []map[string]any{
		{"sku": "a1001"},
		{"sku": "100"},
		{"sku": "A1001", "qty": 12},
		{"sku": "nope"},
		{"sku": ""},
	}
	for _, criteria := range cases {
		authoritative := len(collectCriteriaMatches(row, columns, criteria, "contains")) > 0
		cheap := criteriaMayMatchRow(row, criteria)
		if authoritative && !cheap {
			t.Fatalf("cheap pre-test rejected a row the lookup accepted: %v", criteria)
		}
	}
	if criteriaMayMatchRow(nil, map[string]any{"sku": "a"}) {
		t.Fatal("empty rows cannot match")
	}
	if criteriaMayMatchRow(row, nil) {
		t.Fatal("empty criteria cannot match")
	}
}

func TestResolveColumnKeyFilterAcceptsKeysAndNames(t *testing.T) {
	columns := []sheetColumnPayload{
		{Key: "sku", Name: "编号"},
		{Key: "qty", Name: "数量"},
	}
	if filter := resolveColumnKeyFilter(columns, nil); filter != nil {
		t.Fatalf("no references should mean no restriction, got %v", filter)
	}
	filter := resolveColumnKeyFilter(columns, []string{"数量", "SKU", "unknown"})
	if len(filter) != 2 {
		t.Fatalf("filter = %v, want the two resolvable columns", filter)
	}
	if _, ok := filter["qty"]; !ok {
		t.Fatalf("display name was not resolved: %v", filter)
	}
	if _, ok := filter["sku"]; !ok {
		t.Fatalf("column key was not resolved: %v", filter)
	}
	if filter := resolveColumnKeyFilter(columns, []string{"unknown"}); len(filter) != 0 {
		t.Fatalf("unresolvable reference should produce an empty filter, got %v", filter)
	}
}

func TestRestrictDataToColumnsKeepsOnlyRequestedColumns(t *testing.T) {
	row := map[string]interface{}{"sku": "A1001", "qty": 12, "note": "urgent"}
	if got := restrictDataToColumns(row, nil); len(got) != 3 {
		t.Fatalf("no filter must keep the whole row, got %v", got)
	}
	got := restrictDataToColumns(row, map[string]struct{}{"sku": {}})
	if len(got) != 1 || got["sku"] != "A1001" {
		t.Fatalf("restricted row = %v, want only sku", got)
	}
}

func TestCandidateFromWorkbookKeepsEverySheet(t *testing.T) {
	workbook := &model.Workbook{
		ID:   5,
		Name: "销售",
		Sheets: []model.Sheet{
			{ID: 51, Name: "一月", Columns: json.RawMessage(`[{"key":"sku","name":"编号","type":"text"}]`)},
			{ID: 52, Name: "二月"},
		},
	}
	candidates := candidatesFromWorkbook(workbook, "open_workbook")
	if len(candidates) != 2 {
		t.Fatalf("candidates = %d, want 2", len(candidates))
	}
	if candidates[1].Sheet.ID != 52 {
		t.Fatalf("second candidate sheet = %d, want 52", candidates[1].Sheet.ID)
	}
	if candidates[1].WorkbookName != "销售" || candidates[1].Tier != "open_workbook" {
		t.Fatalf("candidate metadata = %+v", candidates[1])
	}
}
