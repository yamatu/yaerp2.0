package service

import (
	"fmt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type PermissionService struct {
	permRepo *repo.PermissionRepo
	userRepo *repo.UserRepo
}

func NewPermissionService(permRepo *repo.PermissionRepo, userRepo *repo.UserRepo) *PermissionService {
	return &PermissionService{permRepo: permRepo, userRepo: userRepo}
}

func (s *PermissionService) SetSheetPermission(req *model.SetSheetPermissionRequest) error {
	perm := &model.SheetPermission{
		SheetID:   req.SheetID,
		RoleID:    req.RoleID,
		CanView:   req.CanView,
		CanEdit:   req.CanEdit,
		CanDelete: req.CanDelete,
		CanExport: req.CanExport,
	}
	return s.permRepo.SetSheetPermission(perm)
}

func (s *PermissionService) SetCellPermission(req *model.SetCellPermissionRequest) error {
	perm := &model.CellPermission{
		SheetID:    req.SheetID,
		RoleID:     req.RoleID,
		ColumnKey:  req.ColumnKey,
		RowIndex:   req.RowIndex,
		Permission: req.Permission,
	}
	return s.permRepo.SetCellPermission(perm)
}

func (s *PermissionService) GetPermissionMatrix(sheetID int64, userID int64) (*model.PermissionMatrix, error) {
	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to get user roles: %w", err)
	}

	roleIDs := make([]int64, len(roles))
	for i, r := range roles {
		roleIDs[i] = r.ID
	}

	// Admin role gets full access
	for _, r := range roles {
		if r.Code == "admin" {
			return &model.PermissionMatrix{
				Sheet: model.SheetPerm{
					CanView: true, CanEdit: true, CanDelete: true, CanExport: true,
				},
				Columns: make(map[string]string),
				Cells:   make(map[string]string),
			}, nil
		}
	}

	return s.permRepo.GetPermissionMatrix(sheetID, roleIDs)
}

func (s *PermissionService) IsAdmin(userID int64) (bool, error) {
	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return false, fmt.Errorf("failed to get user roles: %w", err)
	}

	for _, role := range roles {
		if role.Code == "admin" {
			return true, nil
		}
	}

	return false, nil
}

func (s *PermissionService) CheckCellPermission(sheetID int64, userID int64, col string, row int, requiredPerm string) (bool, error) {
	matrix, err := s.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return false, err
	}

	// Check cell-specific permission first
	cellKey := fmt.Sprintf("%d:%s", row, col)
	if cellPerm, ok := matrix.Cells[cellKey]; ok {
		return permissionSatisfies(cellPerm, requiredPerm), nil
	}

	// Check column permission
	if colPerm, ok := matrix.Columns[col]; ok {
		return permissionSatisfies(colPerm, requiredPerm), nil
	}

	// Fall back to sheet-level
	switch requiredPerm {
	case "read":
		return matrix.Sheet.CanView, nil
	case "write":
		return matrix.Sheet.CanEdit, nil
	default:
		return false, nil
	}
}

func permissionSatisfies(has, needs string) bool {
	levels := map[string]int{"none": 0, "read": 1, "write": 2}
	return levels[has] >= levels[needs]
}
