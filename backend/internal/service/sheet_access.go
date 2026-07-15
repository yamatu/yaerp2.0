package service

import (
	"encoding/json"
	"fmt"

	"yaerp/internal/model"
)

type sheetCellAccessCache struct {
	isAdmin       bool
	matrix        *model.PermissionMatrix
	protections   protectionMaps
	legacyLocks   map[string]bool
	departmentIDs map[int64]struct{}
}

func newSheetCellAccessCache(permService *PermissionService, userID, sheetID int64, config json.RawMessage, includeProtection bool) (*sheetCellAccessCache, error) {
	isAdmin, err := permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}

	cache := &sheetCellAccessCache{isAdmin: isAdmin}
	if isAdmin {
		return cache, nil
	}

	matrix, err := permService.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return nil, err
	}
	cache.matrix = matrix
	departmentIDs, err := permService.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, err
	}
	cache.departmentIDs = int64Set(departmentIDs)

	if includeProtection {
		_, protections, legacyLocks, err := parseSheetConfigProtection(config)
		if err != nil {
			return nil, err
		}
		cache.protections = protections
		cache.legacyLocks = legacyLocks
	}

	return cache, nil
}

func (c *sheetCellAccessCache) allowsCell(columnKey string, worksheetRowIndex int, requiredPerm string) bool {
	if c == nil || c.isAdmin {
		return true
	}
	if c.matrix == nil {
		return false
	}
	return permissionMatrixAllowsCell(c.matrix, columnKey, worksheetRowIndex-1, requiredPerm)
}

func (c *sheetCellAccessCache) checkProtection(columnKey string, worksheetRowIndex int, userID int64) (bool, string) {
	if c == nil || c.isAdmin {
		return false, ""
	}

	dataRowIndex := worksheetRowIndex - 1
	if dataRowIndex < -1 {
		return false, ""
	}

	checks := []struct {
		scope string
		info  protectionOwner
	}{
		{scope: "cell", info: c.protections.Cells[fmt.Sprintf("%d:%s", dataRowIndex, columnKey)]},
		{scope: "row", info: c.protections.Rows[fmt.Sprintf("%d", dataRowIndex)]},
		{scope: "column", info: c.protections.Columns[columnKey]},
	}

	for _, check := range checks {
		if check.info.OwnerID == 0 || check.info.OwnerID == userID || protectionAllowsUser(check.info, userID, c.departmentIDs) {
			continue
		}
		return true, buildProtectionMessage(check.scope, check.info.OwnerName, dataRowIndex, columnKey)
	}

	legacyKey := fmt.Sprintf("%d:%s", dataRowIndex, columnKey)
	if c.legacyLocks[legacyKey] {
		return true, fmt.Sprintf("单元格 %s%d 已被保护", columnKey, dataRowIndex+2)
	}

	return false, ""
}

func permissionMatrixAllowsCell(matrix *model.PermissionMatrix, columnKey string, rowIndex int, requiredPerm string) bool {
	if matrix == nil {
		return false
	}
	// Principal precedence is resolved before range specificity: a user's
	// explicit exception must be able to override a department-wide rule.
	if permission, exists := scopedPermissionValue(matrix.UserOverrides, columnKey, rowIndex); exists {
		return permissionSatisfies(permission, requiredPerm)
	}
	if permission, exists := scopedPermissionValue(matrix.DepartmentOverrides, columnKey, rowIndex); exists {
		return permissionSatisfies(permission, requiredPerm)
	}
	base := model.ScopedPermissionLayer{Rows: matrix.Rows, Columns: matrix.Columns, Cells: matrix.Cells}
	if permission, exists := scopedPermissionValue(base, columnKey, rowIndex); exists {
		return permissionSatisfies(permission, requiredPerm)
	}
	if matrix.DefaultPermission != "" {
		return permissionSatisfies(matrix.DefaultPermission, requiredPerm)
	}

	switch requiredPerm {
	case "read":
		return matrix.Sheet.CanView
	case "write":
		return matrix.Sheet.CanEdit
	default:
		return false
	}
}

func scopedPermissionValue(layer model.ScopedPermissionLayer, columnKey string, rowIndex int) (string, bool) {
	cellKey := fmt.Sprintf("%d:%s", rowIndex, columnKey)
	if cellPerm, ok := layer.Cells[cellKey]; ok {
		return cellPerm, true
	}

	rowKey := fmt.Sprintf("%d", rowIndex)
	if rowPerm, ok := layer.Rows[rowKey]; ok {
		return rowPerm, true
	}

	if colPerm, ok := layer.Columns[columnKey]; ok {
		return colPerm, true
	}
	return "", false
}
