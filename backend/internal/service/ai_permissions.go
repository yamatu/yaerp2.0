package service

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"yaerp/internal/model"
)

const (
	// Permission snapshots are answers to "what may I do?", so they stay small:
	// the agent only needs enough detail to avoid proposing denied actions.
	maxPermissionOverviewWorkbooks = 20
	maxPermissionOverviewSheets    = 60
)

// BuildUserPermissionSnapshot exposes the permission overview to the HTTP layer.
func (s *AIService) BuildUserPermissionSnapshot(userID int64) (map[string]any, error) {
	return s.buildUserPermissionSnapshot(userID)
}

// buildUserPermissionSnapshot describes what the current account is allowed to
// see and do. Both the ERP agent (through the `get_my_permissions` tool) and the
// web client (through `GET /api/me/permissions`) read the same structure, so the
// assistant can never describe a capability the account does not actually have.
func (s *AIService) buildUserPermissionSnapshot(userID int64) (map[string]any, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}

	roleCodes := make([]string, 0, 4)
	roleNames := make([]string, 0, 4)
	if roles, _, roleErr := s.permService.getUserRoles(userID); roleErr == nil {
		for _, role := range roles {
			roleCodes = append(roleCodes, role.Code)
			roleNames = append(roleNames, role.Name)
		}
	}
	sort.Strings(roleCodes)
	sort.Strings(roleNames)

	workbooks, _, err := s.sheetService.ListWorkbooks(userID, 1, maxPermissionOverviewWorkbooks)
	if err != nil {
		return nil, err
	}

	// One scope for the whole overview: the role, the folder visibility and the
	// workbook rows are read once instead of once per workbook and sheet.
	scope := s.permService.NewAccessScope()

	items := make([]map[string]any, 0, len(workbooks))
	truncatedSheets := false
	totalSheets := 0
	for _, workbook := range workbooks {
		detail, detailErr := s.sheetService.getWorkbook(workbook.ID, userID, scope)
		if detailErr != nil {
			continue
		}
		accessLevel := "granted"
		if isAdmin {
			accessLevel = "admin"
		} else if detail.OwnerID == userID {
			accessLevel = "owner"
		}

		sheets := make([]map[string]any, 0, len(detail.Sheets))
		for _, sheet := range detail.Sheets {
			totalSheets++
			if len(sheets) >= maxPermissionOverviewSheets {
				truncatedSheets = true
				break
			}
			sheets = append(sheets, s.buildSheetPermissionEntry(userID, sheet, scope))
		}

		entry := map[string]any{
			"workbook_id":   detail.ID,
			"workbook_name": detail.Name,
			"owner_name":    detail.OwnerName,
			"access_level":  accessLevel,
			"sheet_count":   len(detail.Sheets),
			"sheets":        sheets,
		}
		if detail.IsLocked {
			entry["is_locked"] = true
		}
		if detail.IsHidden {
			entry["is_hidden"] = true
		}
		items = append(items, entry)
	}

	snapshot := map[string]any{
		"user_id":        userID,
		"is_admin":       isAdmin,
		"role_codes":     roleCodes,
		"role_names":     roleNames,
		"features":       s.buildFeatureAccess(isAdmin),
		"workbook_note":  s.buildWorkbookAccessNote(isAdmin),
		"workbooks":      items,
		"workbook_total": len(items),
		"sheet_total":    totalSheets,
	}
	if truncatedSheets {
		snapshot["note"] = fmt.Sprintf("部分工作表的清单已省略，单个工作簿最多展示 %d 个工作表。", maxPermissionOverviewSheets)
	}
	return snapshot, nil
}

// buildSheetPermissionEntry reduces a sheet permission matrix to the facts an
// agent must respect before proposing a write.
func (s *AIService) buildSheetPermissionEntry(userID int64, sheet model.Sheet, scope *AccessScope) map[string]any {
	entry := map[string]any{
		"sheet_id":   sheet.ID,
		"sheet_name": sheet.Name,
		"can_view":   false,
		"can_edit":   false,
	}
	matrix, err := scope.PermissionMatrix(sheet.ID, userID)
	if err != nil || matrix == nil {
		return entry
	}

	entry["can_view"] = matrix.Sheet.CanView
	entry["can_edit"] = matrix.Sheet.CanEdit
	entry["can_delete"] = matrix.Sheet.CanDelete
	entry["can_export"] = matrix.Sheet.CanExport

	writableColumns, readOnlyColumns, deniedColumns := classifyColumnPermissions(matrix.Columns)
	if len(writableColumns) > 0 {
		entry["writable_columns"] = writableColumns
	}
	if len(readOnlyColumns) > 0 {
		entry["readonly_columns"] = readOnlyColumns
	}
	if len(deniedColumns) > 0 {
		entry["hidden_columns"] = deniedColumns
	}
	if rules, count := classifyRowPermissions(matrix.Rows); count > 0 {
		entry["row_rule_count"] = count
		entry["row_rules"] = rules
	}
	if cells, count := classifyCellPermissions(matrix.Cells); count > 0 {
		entry["cell_rule_count"] = count
		entry["cell_rules"] = cells
	}
	if matrix.DefaultPermission != "" {
		entry["default_cell_permission"] = matrix.DefaultPermission
	}
	if override := describeOverrideLayer(matrix.UserOverrides); override != "" {
		entry["user_override"] = override
	}
	if override := describeOverrideLayer(matrix.DepartmentOverrides); override != "" {
		entry["department_override"] = override
	}
	return entry
}

func classifyColumnPermissions(columns map[string]string) (writable []string, readOnly []string, denied []string) {
	keys := make([]string, 0, len(columns))
	for key := range columns {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		switch normalizePermissionVerb(columns[key]) {
		case "write":
			writable = append(writable, key)
		case "read":
			readOnly = append(readOnly, key)
		case "none":
			denied = append(denied, key)
		}
	}
	return writable, readOnly, denied
}

func classifyRowPermissions(rows map[string]string) ([]map[string]string, int) {
	if len(rows) == 0 {
		return nil, 0
	}
	keys := make([]string, 0, len(rows))
	for key := range rows {
		keys = append(keys, key)
	}
	sort.Sort(rowKeySorter(keys))
	rules := make([]map[string]string, 0, min(len(keys), 30))
	for _, key := range keys {
		verb := normalizePermissionVerb(rows[key])
		if verb == "" {
			continue
		}
		if len(rules) < 30 {
			rules = append(rules, map[string]string{"row": key, "permission": verb})
		}
	}
	return rules, len(keys)
}

func classifyCellPermissions(cells map[string]string) ([]map[string]string, int) {
	if len(cells) == 0 {
		return nil, 0
	}
	keys := make([]string, 0, len(cells))
	for key := range cells {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	rules := make([]map[string]string, 0, min(len(keys), 30))
	for _, key := range keys {
		verb := normalizePermissionVerb(cells[key])
		if verb == "" {
			continue
		}
		if len(rules) < 30 {
			rules = append(rules, map[string]string{"cell": key, "permission": verb})
		}
	}
	return rules, len(keys)
}

func describeOverrideLayer(layer model.ScopedPermissionLayer) string {
	parts := make([]string, 0, 3)
	if len(layer.Columns) > 0 {
		parts = append(parts, fmt.Sprintf("%d 列", len(layer.Columns)))
	}
	if len(layer.Rows) > 0 {
		parts = append(parts, fmt.Sprintf("%d 行", len(layer.Rows)))
	}
	if len(layer.Cells) > 0 {
		parts = append(parts, fmt.Sprintf("%d 单元格", len(layer.Cells)))
	}
	return strings.Join(parts, "、")
}

func normalizePermissionVerb(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "write", "edit", "rw", "readwrite", "read_write":
		return "write"
	case "read", "readonly", "read_only", "view":
		return "read"
	case "none", "deny", "denied", "hidden":
		return "none"
	default:
		return ""
	}
}

type rowKeySorter []string

func (keys rowKeySorter) Len() int      { return len(keys) }
func (keys rowKeySorter) Swap(i, j int) { keys[i], keys[j] = keys[j], keys[i] }
func (keys rowKeySorter) Less(i, j int) bool {
	left, leftErr := strconv.Atoi(keys[i])
	right, rightErr := strconv.Atoi(keys[j])
	if leftErr == nil && rightErr == nil {
		return left < right
	}
	if leftErr == nil {
		return true
	}
	if rightErr == nil {
		return false
	}
	return keys[i] < keys[j]
}

// buildFeatureAccess lists the application capabilities, following exactly the
// rules the HTTP layer enforces (admin group vs. authenticated group).
func (s *AIService) buildFeatureAccess(isAdmin bool) map[string]any {
	adminOnly := []string{
		"manage_users",
		"manage_roles",
		"manage_permissions",
		"manage_departments",
		"manage_folders",
		"manage_workbooks",
		"configure_ai",
		"configure_whatsapp",
		"configure_mail",
		"manage_backup",
		"manage_recycle_bin",
	}
	features := map[string]any{
		"use_ai_assistant": true,
		"create_workbook":  true,
		"import_export":    true,
		"use_trade_center": true,
		"use_mail":         true,
		"use_channels":     true,
		"view_permissions": true,
		"admin_console":    isAdmin,
	}
	for _, name := range adminOnly {
		features[name] = isAdmin
	}
	return features
}

func (s *AIService) buildWorkbookAccessNote(isAdmin bool) string {
	if isAdmin {
		return "管理员可以访问所有工作簿和工作表。"
	}
	return "只能访问被授权或自己创建的工作簿；写入还受工作表/行列/单元格权限限制。"
}

func (s *AIService) toolGetMyPermissions(userID int64, args map[string]any) (*toolExecutionResult, error) {
	snapshot, err := s.buildUserPermissionSnapshot(userID)
	if err != nil {
		return nil, err
	}
	return &toolExecutionResult{Data: snapshot, Summary: "已获取当前账号的权限与可执行功能"}, nil
}
