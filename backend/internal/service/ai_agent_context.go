package service

import (
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

// agentSystemPrompt is the stable prefix of every agent request. Keeping it
// free of per-request data lets providers reuse their prompt cache.
const agentSystemPrompt = `你是 YaERP 智能表格 Agent，用工具查询和修改表格，绝不编造数据。回答用简洁的中文；需要时用 Markdown 表格，公式用 LaTeX（$...$）。

【权限】所有工具都按当前登录账号执行，只能读写该账号有权限的工作簿、工作表、行、列、单元格；只读账号只能查询。工具拒绝时如实说明缺少哪种权限，不要尝试绕过。只有用户询问“我能看到/能做什么”时才调用 get_my_permissions，写入前不必预先检查权限。

【坐标】工具里的 row 一律是 0-based 数据行（第一条数据 = 0，表头不算，界面行号 = row+2）；display_row 才是界面行号，不能当 row 传。列一律用 column_key。

【少走轮次】每一轮模型调用都会让用户多等几秒：
1. 上下文给出了当前工作表的数据预览且标明“全部数据”时，直接基于预览回答或写入，不要再重复读取。
2. 否则：按内容找数据用 search_sheet_content（默认先搜当前工作簿，已知表时传 sheet_id）；按条件筛选用 filter_sheet_rows；统计用 calculate_sheet_metrics；需要逐页读取才用 query_sheet，并检查 has_more / next_start_row，不得把未读完的结果说成“不存在”。只知道表名时用 search_spreadsheets 找 ID；禁止逐表全量扫描。
3. 互不依赖的只读工具在同一轮里一起调用。

【修改表格】
- 用户明确要求修改（改值、填充、插入/删除行、加列、排序、改格式）时直接调用写入工具执行，完成后用一两句话说明改动了哪里。
- 改单元格一律用 batch_update_cells，一次调用写完所有单元格；整列公式用 run_sheet_formulas（{{row}} 为 Excel 行号，{{column_key}} 引用同行其他列，例如 ={{quantity}}*{{unit_price}}，不要猜列字母）；插入/删除行用 insert_row（值放 row_values）/ delete_row；加列用 insert_column；排序用 sort_sheet_range；查重用 dedupe_sheet_rows；多步条件处理用 run_spreadsheet_script（其中 sort 只改变处理顺序，compute 只返回统计）。
- 以下情况不要直接写，先调用 preview_spreadsheet_plan 并直接传入 operations 生成待确认方案，由用户在界面确认：删除 2 行以上、覆盖超过 50 个已有非空单元格、目标行或意图不明确。
- formula 类型的列是自动计算的，只能写以 = 开头的公式。用户要求把公式列的某格改成固定数值时，先不要写入：说明该列是公式（给出当前公式），询问是否确认用固定值覆盖；只有用户在后续消息中明确确认后，才可设置 disable_formula=true。不得改列类型绕过。
- batch_update_cells 返回后核对 invariants_ok、total_rows_before/after 与 affected_columns；出现异常立即停止写入并如实报告，不要重试。
- 数据被误删或误覆盖时，用 list_sheet_versions 找到版本，经用户确认后调用 restore_sheet_version（confirm=true）；不得靠逐行重写或推测原值“修复”。

【结构与样式】create_workbook、create_sheet（columns 每项含 key、name、type，select 的选项放 options，长列表设 searchable=true，checkbox 默认“是/否”）、update_workbook、update_sheet_name、set_cell_format（列类型/下拉/复选框/选项颜色）、format_cell_range（颜色用 #RRGGBB、字体、对齐、边框、行高列宽）、configure_approval_flow（审批：待审值只有最终通过才写入，驳回保持原值；不得越权配置）。列类型：text、number、currency、date、select、checkbox、image、formula、percentage。

【ERP】客户、询价、SKU、供应商报价、对客报价、外贸流程类问题用 get_erp_context、search_erp_customers、search_erp_orders、get_erp_order、search_erp_suppliers 读取真实数据；结果已按权限遮罩，不得猜测被遮罩字段，也不得改用工作表工具绕过。任何 ERP 写入都必须通过 preview_erp_action 生成一项待确认操作（每次一步，即使用户要求立即执行）；客户、业务单、产品或供应商匹配不唯一时列出候选询问用户。确认后根据最新阶段和 advance_blockers 指导下一步。

【其他】报表 generate_report / schedule_daily_report；财务分析工作簿 create_financial_report；跨工作簿网页总结 create_summary_page，编辑既有总结先 list_summary_pages 再 update_summary_page。`

const (
	// The open sheet is previewed in the prompt so small sheets can be answered
	// or edited without a read turn; larger sheets still page through tools.
	agentSheetPreviewMaxRows  = 80
	agentSheetPreviewMaxBytes = 12000
	agentSheetPreviewCellRune = 60
	agentSheetPreviewSheets   = 2
)

// buildAgentSheetPreview renders the permission-filtered data rows of one
// sheet as a compact TSV block. complete reports whether every data row fit.
func (s *AIService) buildAgentSheetPreview(userID, sheetID int64) (text string, complete bool, err error) {
	if err := s.ensureSheetViewAccess(userID, sheetID); err != nil {
		return "", false, err
	}
	sheet, rows, err := s.loadAgentRowsByID(sheetID)
	if err != nil {
		return "", false, err
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return "", false, err
	}
	if len(columns) == 0 {
		return "", true, nil
	}
	visible, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
	if err != nil {
		return "", false, err
	}
	dataRows := make([]aiPreviewRow, 0, len(visible))
	for _, row := range visible {
		if len(row.Data) > 0 {
			dataRows = append(dataRows, row)
		}
	}

	var body strings.Builder
	header := make([]string, 0, len(columns)+1)
	header = append(header, "row")
	for _, column := range columns {
		header = append(header, column.Key)
	}
	body.WriteString(strings.Join(header, "\t"))
	body.WriteByte('\n')

	shown := 0
	for _, row := range dataRows {
		if shown >= agentSheetPreviewMaxRows || body.Len() >= agentSheetPreviewMaxBytes {
			break
		}
		cells := make([]string, 0, len(columns)+1)
		cells = append(cells, fmt.Sprint(row.Row))
		for _, column := range columns {
			cells = append(cells, previewCellText(row.Data[column.Key]))
		}
		body.WriteString(strings.Join(cells, "\t"))
		body.WriteByte('\n')
		shown++
	}
	complete = shown == len(dataRows)

	var out strings.Builder
	fmt.Fprintf(&out, "工作表「%s」(sheet_id=%d) 共 %d 条非空数据行", sheet.Name, sheet.ID, len(dataRows))
	switch {
	case len(dataRows) == 0:
		out.WriteString("，目前只有表头。")
		return out.String(), true, nil
	case complete:
		out.WriteString("，以下为全部数据：\n")
	default:
		fmt.Fprintf(&out, "，以下仅为前 %d 条（第 %d-%d 行），其余数据用 search_sheet_content / filter_sheet_rows / query_sheet 读取：\n", shown, dataRows[0].Row, dataRows[shown-1].Row)
	}
	out.WriteString(body.String())
	return out.String(), complete, nil
}

// previewAgentOperations validates operations the agent already worked out
// and returns them for the employee to confirm. Unlike the prompt form it does
// not ask the model a second time, which used to cost a full extra request.
func (s *AIService) previewAgentOperations(userID int64, args map[string]any) (*toolExecutionResult, error) {
	operations, err := spreadsheetOperationsArg(args, "operations")
	if err != nil {
		return nil, err
	}
	type sheetState struct {
		name    string
		columns map[string]string
		values  map[int]map[string]any
	}
	states := map[int64]*sheetState{}
	result := make([]SpreadsheetOperation, 0, len(operations))
	for index, operation := range operations {
		normalized, err := s.resolveSpreadsheetOperationForExecution(operation)
		if err != nil {
			return nil, fmt.Errorf("operations[%d]: %w", index, err)
		}
		if normalized.SheetID == 0 {
			return nil, fmt.Errorf("operations[%d]: sheet_id is required", index)
		}
		if err := s.validateSpreadsheetOperationAccess(userID, normalized); err != nil {
			return nil, fmt.Errorf("operations[%d] (%s): %w", index, normalized.Kind, err)
		}
		// Applying the plan resolves rows again, so hand back the agent's rows.
		requested := normalizeSpreadsheetOperation(operation)
		normalized.Row, normalized.StartRow, normalized.EndRow = requested.Row, requested.StartRow, requested.EndRow
		state := states[normalized.SheetID]
		if state == nil {
			sheet, rows, err := s.loadAgentRowsByID(normalized.SheetID)
			if err != nil {
				return nil, err
			}
			columns, err := parseSheetColumns(sheet.Columns)
			if err != nil {
				return nil, err
			}
			visible, err := s.buildVisiblePreviewRows(userID, sheet, columns, rows)
			if err != nil {
				return nil, err
			}
			state = &sheetState{name: sheet.Name, columns: map[string]string{}, values: map[int]map[string]any{}}
			for _, column := range columns {
				state.columns[column.Key] = column.Name
			}
			for _, row := range visible {
				state.values[row.Row] = row.Data
			}
			states[normalized.SheetID] = state
		}
		if normalized.SheetName == "" {
			normalized.SheetName = state.name
		}
		if normalized.ColumnName == "" {
			normalized.ColumnName = state.columns[normalized.ColumnKey]
		}
		if normalized.Kind == "update_cell" {
			normalized.CurrentValue = state.values[normalized.Row][normalized.ColumnKey]
		}
		result = append(result, normalized)
	}
	return &toolExecutionResult{
		Data:              map[string]any{"ok": true, "pending_confirmation": true, "operations": result},
		Summary:           fmt.Sprintf("已生成 %d 条待确认修改，等待用户在界面确认", len(result)),
		PendingOperations: result,
	}, nil
}

// inheritedRowFormulas returns the formulas a freshly inserted data row should
// carry, the way a calculated column extends in Excel: a column gets its
// neighbours' formula when the neighbouring rows agree on it (or the column is
// declared as a formula column). Columns in skip already have a value.
func inheritedRowFormulas(config json.RawMessage, columns []sheetColumnPayload, row int, skip map[string]any) map[string]any {
	cells, err := decodeRawCellData(config)
	if err != nil || len(cells) == 0 {
		return nil
	}
	target := row + 1 // worksheet row; the header is worksheet row 0
	result := map[string]any{}
	for index, column := range columns {
		if _, set := skip[column.Key]; set {
			continue
		}
		columnKey := strconv.Itoa(index)
		movedFrom := func(worksheetRow int) (string, bool) {
			if worksheetRow < 1 {
				return "", false
			}
			fields, ok := decodeCellValueFields(cells[strconv.Itoa(worksheetRow)][columnKey])
			if !ok {
				return "", false
			}
			var formula string
			if json.Unmarshal(fields.F, &formula) != nil || !strings.HasPrefix(formula, "=") {
				return "", false
			}
			return moveFormulaRelativeRefs(formula, 0, target-worksheetRow), true
		}
		declared := isFormulaColumn(column)
		above, hasAbove := movedFrom(target - 1)
		below, hasBelow := movedFrom(target + 1)
		switch {
		case hasAbove && hasBelow && above == below:
			result[column.Key] = above
		case hasAbove && !hasBelow:
			if previous, ok := movedFrom(target - 2); declared || (ok && previous == above) {
				result[column.Key] = above
			}
		case hasBelow && !hasAbove:
			if next, ok := movedFrom(target + 2); declared || (ok && next == below) {
				result[column.Key] = below
			}
		}
	}
	return result
}

// inheritRowFormulas reads the sheet after a row insert and returns the
// calculated-column formulas the new row should get, limited to cells the
// user may write.
func (s *AIService) inheritRowFormulas(userID, sheetID int64, row int, rowValues map[string]any) map[string]any {
	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return map[string]any{}
	}
	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return map[string]any{}
	}
	inherited := inheritedRowFormulas(sheet.Config, columns, row, rowValues)
	if len(inherited) == 0 {
		return map[string]any{}
	}
	filter, err := s.buildSheetCellFilter(userID, sheet)
	if err != nil {
		return map[string]any{}
	}
	for key := range inherited {
		// The neighbours the formula comes from must be readable, formula
		// included: copying a hidden formula into a visible cell would reveal it.
		hidden := false
		for _, neighbour := range []int{row - 1, row + 1} {
			if neighbour < 0 {
				continue
			}
			if protectionHidesCell(filter.protections, neighbour, key, userID, filter.isAdmin, filter.departmentSet) ||
				protectionHidesFormula(filter.protections, neighbour, key, userID, filter.isAdmin, filter.departmentSet) ||
				!permissionMatrixAllowsCell(filter.matrix, key, neighbour, "read") {
				hidden = true
			}
		}
		if hidden || s.validateCellWriteAccess(userID, sheetID, row, key) != nil {
			delete(inherited, key)
		}
	}
	if inherited == nil {
		return map[string]any{}
	}
	return inherited
}

// saveSheetAsUser persists a sheet's columns/config change through the same
// gates as an editor save (edit right, lifecycle state, structure and cell
// protections, per-cell write rights), so agent tools that rewrite sheet
// metadata can never do more than the employee could in the editor.
func (s *AIService) saveSheetAsUser(userID int64, next *model.Sheet, action, summary string) error {
	if err := s.ensureSheetEditAccess(userID, next.ID); err != nil {
		return err
	}
	existing, err := s.sheetRepo.GetSheet(next.ID)
	if err != nil {
		return err
	}
	_, err = s.sheetService.UpdateSheetForUserWithSource(userID, existing, next, nil, "ai", action, summary)
	return err
}

// writeToolArgumentAliases lists argument names executors accept besides the
// ones declared in their schema.
var writeToolArgumentAliases = map[string][]string{
	"insert_row":               {"values"},
	"set_cell_format":          {"type", "column_type", "columnType", "currency_code"},
	"preview_spreadsheet_plan": {"workbook_id", "sheet_ids", "prompt"},
	"preview_erp_action":       {"action"},
}

// checkWriteToolArguments rejects a write whose top-level arguments are not
// part of the tool's schema. A misspelled argument used to be ignored
// silently, so the write ran with defaults (e.g. a row inserted at the top
// without its values) and still reported success.
func checkWriteToolArguments(definition openAIToolDefinition, args map[string]any) error {
	properties, _ := definition.Function.Parameters["properties"].(map[string]any)
	allowed := make(map[string]bool, len(properties))
	for key := range properties {
		allowed[key] = true
	}
	for _, alias := range writeToolArgumentAliases[definition.Function.Name] {
		allowed[alias] = true
	}
	unknown := make([]string, 0)
	for key := range args {
		if !strings.HasPrefix(key, "_") && !allowed[key] {
			unknown = append(unknown, key)
		}
	}
	if len(unknown) == 0 {
		return nil
	}
	sort.Strings(unknown)
	names := make([]string, 0, len(properties))
	for key := range properties {
		names = append(names, key)
	}
	sort.Strings(names)
	return fmt.Errorf("未执行：%s 不支持参数 %s；可用参数：%s", definition.Function.Name, strings.Join(unknown, ", "), strings.Join(names, ", "))
}

func previewCellText(value any) string {
	if value == nil {
		return ""
	}
	text := strings.NewReplacer("\t", " ", "\r", " ", "\n", " ").Replace(fmt.Sprint(value))
	if runes := []rune(text); len(runes) > agentSheetPreviewCellRune {
		text = string(runes[:agentSheetPreviewCellRune]) + "…"
	}
	return text
}

// previewSheetIDs picks the sheets worth previewing: the selection's sheet,
// then the sheets the employee pinned, or the only sheet of the workbook.
func previewSheetIDs(chatContext *ChatContext, workbookSheetIDs []int64) []int64 {
	ids := make([]int64, 0, agentSheetPreviewSheets)
	seen := map[int64]bool{}
	add := func(id int64) {
		if id > 0 && !seen[id] && len(ids) < agentSheetPreviewSheets {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	if chatContext.Selection != nil {
		add(chatContext.Selection.SheetID)
	}
	for _, id := range chatContext.SheetIDs {
		add(id)
	}
	if len(ids) == 0 && len(workbookSheetIDs) == 1 {
		add(workbookSheetIDs[0])
	}
	return ids
}
