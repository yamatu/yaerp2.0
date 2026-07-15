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
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, []model.PrincipalCellPermission{
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
	row := 0
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, []model.PrincipalCellPermission{
		{ColumnKey: "customer", RowIndex: &row, Permission: "read"},
	}, false)
	mergePrincipalCellPermissions(&matrix.UserOverrides, []model.PrincipalCellPermission{
		{RowIndex: &row, Permission: "none"},
	}, true)

	if permissionMatrixAllowsCell(matrix, "customer", 0, "read") {
		t.Fatal("employee row deny must override a more specific department cell grant")
	}
}

func TestEmployeeGrantOverridesDepartmentDenyAcrossScopes(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.DefaultPermission = "read"
	row := 0
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, []model.PrincipalCellPermission{
		{ColumnKey: "supplier", RowIndex: &row, Permission: "none"},
	}, false)
	mergePrincipalCellPermissions(&matrix.UserOverrides, []model.PrincipalCellPermission{
		{ColumnKey: "supplier", Permission: "read"},
	}, true)

	if !permissionMatrixAllowsCell(matrix, "supplier", 0, "read") {
		t.Fatal("employee column grant must override a department cell deny")
	}
}

func TestDepartmentOverrideBeatsRolePermission(t *testing.T) {
	matrix := fullAccessMatrix()
	matrix.DepartmentOverrides.Rows["0"] = "none"

	if permissionMatrixAllowsCell(matrix, "customer", 0, "read") {
		t.Fatal("department row mask must override role-level write access")
	}
}

func TestDepartmentConflictUsesMostRestrictiveSameScopeRule(t *testing.T) {
	matrix := emptyPermissionMatrix()
	matrix.DefaultPermission = "none"
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, []model.PrincipalCellPermission{
		{ColumnKey: "supplier", Permission: "read"},
		{ColumnKey: "supplier", Permission: "none"},
	}, false)

	if permissionMatrixAllowsCell(matrix, "supplier", 0, "read") {
		t.Fatal("an explicit department deny must win conflicting same-scope department grants")
	}
}
