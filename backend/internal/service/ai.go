package service

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"

	"yaerp/config"
	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type AIService struct {
	cfg             *config.Config
	db              *sql.DB
	sheetRepo       *repo.SheetRepo
	sheetService    *SheetService
	permService     *PermissionService
	uploadService   *UploadService
	scheduleService *AIScheduleService
	tools           map[string]ToolFunc
}

func NewAIService(cfg *config.Config, db *sql.DB, sheetRepo *repo.SheetRepo, sheetService *SheetService, permService *PermissionService, uploadService *UploadService, scheduleService *AIScheduleService) *AIService {
	service := &AIService{
		cfg:             cfg,
		db:              db,
		sheetRepo:       sheetRepo,
		sheetService:    sheetService,
		permService:     permService,
		uploadService:   uploadService,
		scheduleService: scheduleService,
	}
	service.tools = service.buildToolRegistry()
	return service
}

type ChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type ChatRequest struct {
	Messages []ChatMessage `json:"messages" binding:"required"`
}

type ChatResponse struct {
	Reply             string                 `json:"reply"`
	Model             string                 `json:"model"`
	TouchedSheetIDs   []int64                `json:"touched_sheet_ids,omitempty"`
	PendingOperations []SpreadsheetOperation `json:"pending_operations,omitempty"`
	ToolTraces        []ChatToolTrace        `json:"tool_traces,omitempty"`
}

type ChatToolTrace struct {
	Name            string      `json:"name"`
	Status          string      `json:"status"`
	Summary         string      `json:"summary,omitempty"`
	Data            interface{} `json:"data,omitempty"`
	TouchedSheetIDs []int64     `json:"touched_sheet_ids,omitempty"`
}

type AIConfigStatus struct {
	Configured bool   `json:"configured"`
	Endpoint   string `json:"endpoint"`
	Model      string `json:"model"`
}

type SpreadsheetPlanRequest struct {
	WorkbookID int64   `json:"workbook_id" binding:"required"`
	SheetIDs   []int64 `json:"sheet_ids" binding:"required,min=1"`
	Prompt     string  `json:"prompt" binding:"required"`
}

type SpreadsheetOperation struct {
	Kind                 string                 `json:"kind,omitempty"`
	SheetID              int64                  `json:"sheet_id"`
	SheetName            string                 `json:"sheet_name"`
	Row                  int                    `json:"row,omitempty"`
	ColumnKey            string                 `json:"column_key,omitempty"`
	ColumnName           string                 `json:"column_name,omitempty"`
	CurrentValue         interface{}            `json:"current_value,omitempty"`
	Value                interface{}            `json:"value,omitempty"`
	Reason               string                 `json:"reason,omitempty"`
	RowValues            map[string]interface{} `json:"row_values,omitempty"`
	ColumnType           string                 `json:"column_type,omitempty"`
	InsertAfterColumnKey string                 `json:"insert_after_column_key,omitempty"`
	StartRow             *int                   `json:"start_row,omitempty"`
	EndRow               *int                   `json:"end_row,omitempty"`
	FormulaTemplate      string                 `json:"formula_template,omitempty"`
}

type SpreadsheetPlanResponse struct {
	Reply      string                 `json:"reply"`
	Model      string                 `json:"model"`
	Operations []SpreadsheetOperation `json:"operations"`
}

type SpreadsheetApplyRequest struct {
	Operations []SpreadsheetOperation `json:"operations" binding:"required,min=1"`
}

// GetConfig returns the current AI configuration status (non-sensitive).
func (s *AIService) GetConfig() *AIConfigStatus {
	endpoint, model := s.getActiveConfig()
	return &AIConfigStatus{
		Configured: endpoint != "",
		Endpoint:   endpoint,
		Model:      model,
	}
}

// UpdateConfig persists AI config to the settings table.
// If apiKey is empty, the existing key is preserved (not overwritten).
func (s *AIService) UpdateConfig(endpoint, apiKey, model string) error {
	settings := map[string]string{
		"ai_endpoint": endpoint,
		"ai_model":    model,
	}
	// Only update api_key if a new value is provided
	if apiKey != "" {
		settings["ai_api_key"] = apiKey
	}
	for key, value := range settings {
		_, err := s.db.Exec(
			`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
			 ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
			key, value,
		)
		if err != nil {
			return fmt.Errorf("save setting %s: %w", key, err)
		}
	}
	return nil
}

// Chat sends messages to the OpenAI-compatible API and returns the response.
func (s *AIService) Chat(userID int64, messages []ChatMessage) (*ChatResponse, error) {
	return s.chatWithTools(userID, messages)
}

func (s *AIService) PreviewSpreadsheetPlan(req *SpreadsheetPlanRequest) (*SpreadsheetPlanResponse, error) {
	endpoint, model := s.getActiveConfig()
	apiKey := s.getAPIKey()

	if endpoint == "" || apiKey == "" {
		return nil, fmt.Errorf("AI is not configured. Please set the API endpoint and key in admin settings")
	}

	contextPayload, sheetMeta, err := s.buildSpreadsheetContext(req.WorkbookID, req.SheetIDs)
	if err != nil {
		return nil, err
	}

	messages := []ChatMessage{
		{
			Role: "system",
			Content: "你是 YaERP 表格批处理助手。你必须只返回 JSON 对象，不要输出 Markdown、解释文字或代码块。" +
				` 返回格式必须是 {"reply":"中文回复","operations":[{"kind":"update_cell","sheet_id":1,"sheet_name":"工作表","row":0,"column_key":"status","value":"已完成","reason":"更新原因"}]}` +
				`。支持的 kind: update_cell、insert_row、delete_row、insert_column、fill_formula。` +
				` update_cell 使用 row(0-based 数据行) + column_key + value；` +
				` insert_row 使用 row(插入后的目标数据行索引) + row_values；` +
				` delete_row 使用 row(需要删除的 0-based 数据行索引)；` +
				` insert_column 使用 column_key + column_name + column_type，可选 insert_after_column_key；` +
				` fill_formula 使用 column_key + start_row + end_row + formula_template，formula_template 里可使用 {{row}} 表示当前 Excel 行号（第一条数据是 2）。` +
				" column_key 必须严格使用上下文中的列 key；只能修改已提供的工作表；如果用户没有要求修改表格，operations 返回空数组。",
		},
		{
			Role:    "user",
			Content: fmt.Sprintf("用户需求：%s\n\n以下是管理员选中的工作簿数据范围(JSON)：\n%s", req.Prompt, contextPayload),
		},
	}

	apiResp, err := s.callChatCompletion(endpoint, apiKey, model, messages)
	if err != nil {
		return nil, err
	}

	parsed, err := parseSpreadsheetPlan(apiResp.Reply)
	if err != nil {
		return nil, err
	}

	parsed.Model = apiResp.Model
	parsed.Operations = enrichSpreadsheetOperations(parsed.Operations, sheetMeta)
	return parsed, nil
}

func (s *AIService) ApplySpreadsheetPlan(userID int64, operations []SpreadsheetOperation) error {
	_, err := s.executeSpreadsheetOperations(userID, operations)
	return err
}

func (s *AIService) callChatCompletion(endpoint, apiKey, model string, messages []ChatMessage) (*ChatResponse, error) {
	requestBody := map[string]interface{}{
		"model":    model,
		"messages": messages,
	}

	body, err := json.Marshal(requestBody)
	if err != nil {
		return nil, fmt.Errorf("marshal request: %w", err)
	}

	chatURL := strings.TrimRight(endpoint, "/")
	if !strings.HasSuffix(chatURL, "/chat/completions") {
		chatURL += "/chat/completions"
	}

	req, err := http.NewRequest("POST", chatURL, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+apiKey)

	client := &http.Client{Timeout: 60 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("API request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("read response: %w", err)
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("API returned status %d: %s", resp.StatusCode, string(respBody))
	}

	var apiResp struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Model string `json:"model"`
	}

	if err := json.Unmarshal(respBody, &apiResp); err != nil {
		return nil, fmt.Errorf("parse response: %w", err)
	}

	if len(apiResp.Choices) == 0 {
		return nil, fmt.Errorf("no response from AI model")
	}

	return &ChatResponse{Reply: apiResp.Choices[0].Message.Content, Model: apiResp.Model}, nil
}

func (s *AIService) buildSpreadsheetContext(workbookID int64, sheetIDs []int64) (string, map[int64]sheetPreviewMeta, error) {
	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return "", nil, err
	}

	allSheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return "", nil, err
	}

	selected := make(map[int64]struct{}, len(sheetIDs))
	for _, sheetID := range sheetIDs {
		selected[sheetID] = struct{}{}
	}

	meta := make(map[int64]sheetPreviewMeta)
	payload := map[string]interface{}{
		"workbook": map[string]interface{}{
			"id":   workbook.ID,
			"name": workbook.Name,
		},
		"sheets": make([]map[string]interface{}, 0, len(sheetIDs)),
	}

	sheetsPayload := make([]map[string]interface{}, 0, len(sheetIDs))
	for _, sheet := range allSheets {
		if _, ok := selected[sheet.ID]; !ok {
			continue
		}

		rows, err := s.sheetRepo.GetRows(sheet.ID)
		if err != nil {
			return "", nil, fmt.Errorf("load rows for sheet %d: %w", sheet.ID, err)
		}
		rowBase := getSheetRowBase(rows)

		columns := make([]sheetPreviewColumn, 0)
		if len(sheet.Columns) > 0 {
			_ = json.Unmarshal(sheet.Columns, &columns)
		}

		rowItems := make([]map[string]interface{}, 0, len(rows))
		currentValues := make(map[string]interface{})
		for index, row := range rows {
			if index >= 200 {
				break
			}

			data := make(map[string]interface{})
			_ = json.Unmarshal(row.Data, &data)
			normalizedRowIndex := row.RowIndex - rowBase
			rowItems = append(rowItems, map[string]interface{}{
				"row":         normalizedRowIndex,
				"source_row":  row.RowIndex,
				"display_row": normalizedRowIndex + 2,
				"data":        data,
			})
			for key, value := range data {
				currentValues[fmt.Sprintf("%d:%s", normalizedRowIndex, key)] = value
			}
		}

		columnNames := make(map[string]string)
		for _, column := range columns {
			columnNames[column.Key] = column.Name
		}

		meta[sheet.ID] = sheetPreviewMeta{
			SheetName:     sheet.Name,
			ColumnNames:   columnNames,
			CurrentValues: currentValues,
		}

		sheetsPayload = append(sheetsPayload, map[string]interface{}{
			"sheet_id":   sheet.ID,
			"sheet_name": sheet.Name,
			"columns":    columns,
			"row_base":   rowBase,
			"rows":       rowItems,
		})
	}

	if len(sheetsPayload) == 0 {
		return "", nil, fmt.Errorf("no selected sheets found in workbook")
	}

	sort.Slice(sheetsPayload, func(i, j int) bool {
		return fmt.Sprintf("%v", sheetsPayload[i]["sheet_id"]) < fmt.Sprintf("%v", sheetsPayload[j]["sheet_id"])
	})
	payload["sheets"] = sheetsPayload

	contextBytes, err := json.MarshalIndent(payload, "", "  ")
	if err != nil {
		return "", nil, fmt.Errorf("marshal spreadsheet context: %w", err)
	}

	return string(contextBytes), meta, nil
}

func parseSpreadsheetPlan(reply string) (*SpreadsheetPlanResponse, error) {
	content := strings.TrimSpace(reply)
	if strings.HasPrefix(content, "```") {
		content = strings.TrimPrefix(content, "```")
		content = strings.TrimSpace(strings.TrimPrefix(content, "json"))
		content = strings.TrimSpace(strings.TrimSuffix(content, "```"))
	}

	start := strings.Index(content, "{")
	end := strings.LastIndex(content, "}")
	if start >= 0 && end > start {
		content = content[start : end+1]
	}

	var parsed SpreadsheetPlanResponse
	if err := json.Unmarshal([]byte(content), &parsed); err != nil {
		return nil, fmt.Errorf("AI 未返回可解析的 JSON 结果: %w", err)
	}

	return &parsed, nil
}

func normalizeSpreadsheetOperation(operation SpreadsheetOperation) SpreadsheetOperation {
	if strings.TrimSpace(operation.Kind) == "" {
		operation.Kind = "update_cell"
	}
	return operation
}

func getSheetRowBase(rows []model.Row) int {
	if len(rows) == 0 {
		return 0
	}
	base := rows[0].RowIndex
	for _, row := range rows[1:] {
		if row.RowIndex < base {
			base = row.RowIndex
		}
	}
	if base < 0 {
		return 0
	}
	return base
}

func parseSheetColumns(raw json.RawMessage) ([]sheetColumnPayload, error) {
	if len(raw) == 0 {
		return []sheetColumnPayload{}, nil
	}
	var columns []sheetColumnPayload
	if err := json.Unmarshal(raw, &columns); err != nil {
		return nil, fmt.Errorf("parse sheet columns: %w", err)
	}
	return columns, nil
}

func expandFormulaTemplate(template string, rowIndex int) string {
	rowNumber := strconv.Itoa(rowIndex + 2)
	dataRowNumber := strconv.Itoa(rowIndex + 1)
	result := strings.ReplaceAll(template, "{{row}}", rowNumber)
	result = strings.ReplaceAll(result, "{{data_row}}", dataRowNumber)
	return result
}

func firstNonEmpty(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

type sheetPreviewColumn struct {
	Key  string `json:"key"`
	Name string `json:"name"`
	Type string `json:"type"`
}

type sheetPreviewMeta struct {
	SheetName     string
	ColumnNames   map[string]string
	CurrentValues map[string]interface{}
}

type sheetColumnPayload struct {
	Key            string                 `json:"key"`
	Name           string                 `json:"name"`
	Type           string                 `json:"type"`
	Width          int                    `json:"width,omitempty"`
	Required       bool                   `json:"required,omitempty"`
	Validation     map[string]interface{} `json:"validation,omitempty"`
	Formula        string                 `json:"formula,omitempty"`
	Options        []string               `json:"options,omitempty"`
	CurrencyCode   string                 `json:"currencyCode,omitempty"`
	CurrencySource string                 `json:"currencySource,omitempty"`
}

func enrichSpreadsheetOperations(operations []SpreadsheetOperation, meta map[int64]sheetPreviewMeta) []SpreadsheetOperation {
	result := make([]SpreadsheetOperation, 0, len(operations))
	for _, operation := range operations {
		sheetMeta, ok := meta[operation.SheetID]
		if !ok {
			continue
		}
		if operation.SheetName == "" {
			operation.SheetName = sheetMeta.SheetName
		}
		if operation.ColumnName == "" {
			operation.ColumnName = sheetMeta.ColumnNames[operation.ColumnKey]
		}
		if currentValue, ok := sheetMeta.CurrentValues[fmt.Sprintf("%d:%s", operation.Row, operation.ColumnKey)]; ok {
			operation.CurrentValue = currentValue
		}
		result = append(result, operation)
	}

	sort.Slice(result, func(i, j int) bool {
		if result[i].SheetID == result[j].SheetID {
			if result[i].Row == result[j].Row {
				return result[i].ColumnKey < result[j].ColumnKey
			}
			return result[i].Row < result[j].Row
		}
		return result[i].SheetID < result[j].SheetID
	})

	return result
}

func (s *AIService) applySpreadsheetOperation(userID int64, operation SpreadsheetOperation) error {
	switch operation.Kind {
	case "insert_row":
		return s.applyInsertRowOperation(userID, operation)
	case "delete_row":
		return s.applyDeleteRowOperation(userID, operation)
	case "insert_column":
		return s.applyInsertColumnOperation(userID, operation)
	case "fill_formula":
		return s.applyFillFormulaOperation(userID, operation)
	default:
		return s.applyCellUpdateOperation(userID, operation)
	}
}

func (s *AIService) applyCellUpdateOperation(userID int64, operation SpreadsheetOperation) error {
	if strings.TrimSpace(operation.ColumnKey) == "" || operation.Row < 0 {
		return fmt.Errorf("invalid update_cell operation")
	}

	rawValue, err := json.Marshal(operation.Value)
	if err != nil {
		return fmt.Errorf("marshal row data: %w", err)
	}

	if err := s.sheetService.UpdateCells(userID, []model.CellUpdate{{SheetID: operation.SheetID, Row: operation.Row, Col: operation.ColumnKey, Value: rawValue}}); err != nil {
		return fmt.Errorf("apply spreadsheet operation: %w", err)
	}

	return nil
}

func (s *AIService) applyInsertRowOperation(userID int64, operation SpreadsheetOperation) error {
	if operation.Row < 0 {
		return fmt.Errorf("invalid insert_row row index")
	}

	if err := s.sheetService.InsertRow(userID, operation.SheetID, operation.Row-1); err != nil {
		return fmt.Errorf("insert row: %w", err)
	}

	rowValues := operation.RowValues
	if rowValues == nil {
		rowValues = map[string]interface{}{}
	}
	if len(rowValues) == 0 {
		return nil
	}

	changes := make([]model.CellUpdate, 0, len(rowValues))
	for key, value := range rowValues {
		rawValue, err := json.Marshal(value)
		if err != nil {
			return fmt.Errorf("marshal inserted row value: %w", err)
		}
		changes = append(changes, model.CellUpdate{
			SheetID: operation.SheetID,
			Row:     operation.Row,
			Col:     key,
			Value:   rawValue,
		})
	}

	if err := s.sheetService.UpdateCells(userID, changes); err != nil {
		return fmt.Errorf("persist inserted row: %w", err)
	}

	return nil
}

func (s *AIService) applyDeleteRowOperation(userID int64, operation SpreadsheetOperation) error {
	if operation.Row < 0 {
		return fmt.Errorf("invalid delete_row row index")
	}

	if err := s.sheetService.DeleteRow(userID, operation.SheetID, operation.Row); err != nil {
		return fmt.Errorf("delete row: %w", err)
	}

	return nil
}

func (s *AIService) applyInsertColumnOperation(userID int64, operation SpreadsheetOperation) error {
	sheet, err := s.sheetRepo.GetSheet(operation.SheetID)
	if err != nil {
		return fmt.Errorf("load target sheet: %w", err)
	}

	columns, err := parseSheetColumns(sheet.Columns)
	if err != nil {
		return err
	}
	if operation.ColumnKey == "" {
		return fmt.Errorf("insert_column requires column_key")
	}

	insertIndex := len(columns)
	if operation.InsertAfterColumnKey != "" {
		for index, column := range columns {
			if column.Key == operation.InsertAfterColumnKey {
				insertIndex = index + 1
				break
			}
		}
	}

	newColumn := sheetColumnPayload{
		Key:   operation.ColumnKey,
		Name:  firstNonEmpty(operation.ColumnName, operation.ColumnKey),
		Type:  firstNonEmpty(operation.ColumnType, "text"),
		Width: 140,
	}
	columns = append(columns, sheetColumnPayload{})
	copy(columns[insertIndex+1:], columns[insertIndex:])
	columns[insertIndex] = newColumn

	nextColumns, err := json.Marshal(columns)
	if err != nil {
		return fmt.Errorf("marshal inserted column metadata: %w", err)
	}
	sheet.Columns = nextColumns
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return fmt.Errorf("persist inserted column: %w", err)
	}

	rows, err := s.sheetRepo.GetRows(operation.SheetID)
	if err != nil {
		return fmt.Errorf("load rows after column insert: %w", err)
	}
	for _, row := range rows {
		data := make(map[string]interface{})
		if err := json.Unmarshal(row.Data, &data); err != nil {
			data = make(map[string]interface{})
		}

		if operation.FormulaTemplate != "" {
			data[operation.ColumnKey] = expandFormulaTemplate(operation.FormulaTemplate, row.RowIndex)
		} else if operation.Value != nil {
			data[operation.ColumnKey] = operation.Value
		}

		encoded, err := json.Marshal(data)
		if err != nil {
			return fmt.Errorf("marshal inserted column row data: %w", err)
		}
		if err := s.sheetRepo.UpsertRow(operation.SheetID, row.RowIndex, encoded, userID); err != nil {
			return fmt.Errorf("apply inserted column values: %w", err)
		}
	}

	return nil
}

func (s *AIService) applyFillFormulaOperation(userID int64, operation SpreadsheetOperation) error {
	if strings.TrimSpace(operation.ColumnKey) == "" || strings.TrimSpace(operation.FormulaTemplate) == "" {
		return fmt.Errorf("fill_formula requires column_key and formula_template")
	}

	rows, err := s.sheetRepo.GetRows(operation.SheetID)
	if err != nil {
		return fmt.Errorf("load rows for formula fill: %w", err)
	}

	startRow := 0
	if operation.StartRow != nil {
		startRow = *operation.StartRow
	}
	endRow := startRow
	if operation.EndRow != nil {
		endRow = *operation.EndRow
	} else {
		for _, row := range rows {
			if row.RowIndex > endRow {
				endRow = row.RowIndex
			}
		}
	}
	if endRow < startRow {
		endRow = startRow
	}

	rowMap := make(map[int]map[string]interface{})
	for _, row := range rows {
		data := make(map[string]interface{})
		if err := json.Unmarshal(row.Data, &data); err != nil {
			data = make(map[string]interface{})
		}
		rowMap[row.RowIndex] = data
	}

	for rowIndex := startRow; rowIndex <= endRow; rowIndex++ {
		data := rowMap[rowIndex]
		if data == nil {
			data = make(map[string]interface{})
		}
		data[operation.ColumnKey] = expandFormulaTemplate(operation.FormulaTemplate, rowIndex)
		encoded, err := json.Marshal(data)
		if err != nil {
			return fmt.Errorf("marshal formula fill row data: %w", err)
		}
		if err := s.sheetRepo.UpsertRow(operation.SheetID, rowIndex, encoded, userID); err != nil {
			return fmt.Errorf("apply formula fill: %w", err)
		}
	}

	return nil
}

func (s *AIService) invalidateSheetSnapshot(sheet *model.Sheet) error {
	if len(sheet.Config) == 0 {
		return nil
	}

	var payload map[string]interface{}
	if err := json.Unmarshal(sheet.Config, &payload); err != nil {
		return nil
	}

	delete(payload, "univerSheetData")
	delete(payload, "univerStyles")

	nextConfig, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal invalidated sheet config: %w", err)
	}

	sheet.Config = nextConfig
	if err := s.sheetRepo.UpdateSheet(sheet); err != nil {
		return fmt.Errorf("persist invalidated sheet config: %w", err)
	}

	return nil
}

// getActiveConfig returns endpoint and model, preferring DB settings over env vars.
func (s *AIService) getActiveConfig() (string, string) {
	endpoint := s.getSetting("ai_endpoint")
	if endpoint == "" {
		endpoint = s.cfg.AI.Endpoint
	}

	model := s.getSetting("ai_model")
	if model == "" {
		model = s.cfg.AI.Model
	}

	return endpoint, model
}

func (s *AIService) getAPIKey() string {
	key := s.getSetting("ai_api_key")
	if key == "" {
		key = s.cfg.AI.APIKey
	}
	return key
}

func (s *AIService) getSetting(key string) string {
	var value string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = $1`, key).Scan(&value)
	if err != nil {
		return ""
	}
	return value
}

// buildUserContext creates a summary of user's accessible data.
func (s *AIService) buildUserContext(userID int64) string {
	snapshot, err := s.buildUserContextSnapshot(userID, 20)
	if err != nil {
		return "无法加载用户数据。"
	}

	workbooks, _ := snapshot["workbooks"].([]map[string]any)
	if len(workbooks) == 0 {
		return "用户暂无可访问工作簿。"
	}

	var builder strings.Builder
	for _, workbook := range workbooks {
		builder.WriteString(fmt.Sprintf("工作簿「%v」(ID:%v)：\n", workbook["workbook_name"], workbook["workbook_id"]))
		sheets, _ := workbook["sheets"].([]map[string]any)
		for _, sheet := range sheets {
			columns, _ := sheet["columns"].([]sheetColumnPayload)
			builder.WriteString(fmt.Sprintf("  - 工作表「%v」(ID:%v, %d 列)\n", sheet["sheet_name"], sheet["sheet_id"], len(columns)))
		}
		builder.WriteString("\n")
	}

	return strings.TrimSpace(builder.String())
}
