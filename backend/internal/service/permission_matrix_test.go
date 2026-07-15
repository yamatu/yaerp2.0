package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestScopedPermissionKeepsRestrictedDefault(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.Sheet.CanView = true
	matrix.DefaultPermission = "read"
	row := 0
	mergePrincipalCellPermissions(matrix, []model.PrincipalCellPermission{
		{ColumnKey: "amount", RowIndex: &row, Permission: "write"},
		{ColumnKey: "secret", Permission: "none"},
	}, false)
	elevateMatrixForScopedPermissions(matrix)

	if !matrix.Sheet.CanEdit {
		t.Fatal("scoped write permission must enable the edit endpoint")
	}
	if !permissionMatrixAllowsCell(matrix, "amount", 0, "write") {
		t.Fatal("explicit cell write permission should allow editing")
	}
	if permissionMatrixAllowsCell(matrix, "other", 0, "write") {
		t.Fatal("unconfigured cells must keep the read-only default")
	}
	if permissionMatrixAllowsCell(matrix, "secret", 0, "read") {
		t.Fatal("none permission must hide the column")
	}
}

func TestEmployeeScopeOverridesDepartmentScope(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.DefaultPermission = "read"
	mergePrincipalCellPermissions(matrix, []model.PrincipalCellPermission{
		{ColumnKey: "salary", Permission: "write"},
	}, false)
	mergePrincipalCellPermissions(matrix, []model.PrincipalCellPermission{
		{ColumnKey: "salary", Permission: "none"},
	}, true)

	if permissionMatrixAllowsCell(matrix, "salary", 0, "read") {
		t.Fatal("employee-specific deny must override the department write rule")
	}
}
