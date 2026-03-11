package service

import (
	"fmt"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type folderAccessResult struct {
	AccessLevel string
	CanView     bool
	CanWrite    bool
	CanManage   bool
}

type PermissionService struct {
	permRepo   *repo.PermissionRepo
	userRepo   *repo.UserRepo
	sheetRepo  *repo.SheetRepo
	folderRepo *repo.FolderRepo
}

func NewPermissionService(permRepo *repo.PermissionRepo, userRepo *repo.UserRepo, sheetRepo *repo.SheetRepo, folderRepo *repo.FolderRepo) *PermissionService {
	return &PermissionService{permRepo: permRepo, userRepo: userRepo, sheetRepo: sheetRepo, folderRepo: folderRepo}
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

func (s *PermissionService) SetUserSheetPermission(req *model.SetUserSheetPermissionRequest) error {
	perm := &model.UserSheetPermission{
		SheetID:   req.SheetID,
		UserID:    req.UserID,
		CanView:   req.CanView || req.CanEdit || req.CanDelete || req.CanExport,
		CanEdit:   req.CanEdit,
		CanDelete: req.CanDelete,
		CanExport: req.CanExport,
	}
	return s.permRepo.SetUserSheetPermission(perm)
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
	roles, roleIDs, err := s.getUserRoles(userID)
	if err != nil {
		return nil, err
	}

	for _, role := range roles {
		if role.Code == "admin" {
			return fullAccessMatrix(), nil
		}
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sheet: %w", err)
	}

	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workbook: %w", err)
	}

	if workbook.OwnerID == userID {
		return fullAccessMatrix(), nil
	}

	matrix, err := s.permRepo.GetPermissionMatrix(sheetID, roleIDs)
	if err != nil {
		return nil, err
	}

	userPerm, err := s.permRepo.GetUserSheetPermission(sheetID, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load direct user permission: %w", err)
	}

	if workbook.FolderID != nil {
		access, err := s.resolveFolderAccess(*workbook.FolderID, userID, roleIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to check folder access: %w", err)
		}
		if !access.CanView && !hasAnyDirectUserSheetPermission(userPerm) {
			return emptyPermissionMatrix(), nil
		}
		if access.CanView {
			matrix.Sheet.CanView = true
		}
	}

	if userPerm != nil {
		matrix.Sheet.CanView = matrix.Sheet.CanView || userPerm.CanView
		matrix.Sheet.CanEdit = matrix.Sheet.CanEdit || userPerm.CanEdit
		matrix.Sheet.CanDelete = matrix.Sheet.CanDelete || userPerm.CanDelete
		matrix.Sheet.CanExport = matrix.Sheet.CanExport || userPerm.CanExport
	}

	return matrix, nil
}

func (s *PermissionService) GetPermissionMatrixForRole(sheetID, roleID int64) (*model.PermissionMatrix, error) {
	return s.permRepo.GetPermissionMatrix(sheetID, []int64{roleID})
}

func (s *PermissionService) GetUserSheetPermission(sheetID, userID int64) (*model.UserSheetPermission, error) {
	return s.permRepo.GetUserSheetPermission(sheetID, userID)
}

func (s *PermissionService) ListUserSheetPermissions(sheetID int64) ([]model.UserSheetPermission, error) {
	return s.permRepo.ListUserSheetPermissions(sheetID)
}

func (s *PermissionService) IsAdmin(userID int64) (bool, error) {
	roles, _, err := s.getUserRoles(userID)
	if err != nil {
		return false, err
	}

	for _, role := range roles {
		if role.Code == "admin" {
			return true, nil
		}
	}

	return false, nil
}

func (s *PermissionService) CanManageWorkbook(workbook *model.Workbook, userID int64) (bool, error) {
	if workbook.OwnerID == userID {
		return true, nil
	}

	return s.IsAdmin(userID)
}

func (s *PermissionService) CanViewWorkbook(workbook *model.Workbook, userID int64) (bool, error) {
	canManage, err := s.CanManageWorkbook(workbook, userID)
	if err != nil {
		return false, err
	}
	if canManage {
		return true, nil
	}

	if workbook.FolderID != nil {
		hasFolderAccess, err := s.HasFolderViewAccess(*workbook.FolderID, userID)
		if err != nil {
			return false, err
		}
		if hasFolderAccess {
			return true, nil
		}
	}

	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbook.ID)
	if err != nil {
		return false, fmt.Errorf("failed to load workbook sheets: %w", err)
	}

	for _, sheet := range sheets {
		matrix, err := s.GetPermissionMatrix(sheet.ID, userID)
		if err != nil {
			return false, err
		}
		if matrix.Sheet.CanView {
			return true, nil
		}
	}

	return false, nil
}

func (s *PermissionService) CanManageFolder(folder *model.Folder, userID int64) (bool, error) {
	if folder.OwnerID == userID {
		return true, nil
	}

	return s.IsAdmin(userID)
}

func (s *PermissionService) CanWriteFolder(folderID, userID int64) (bool, error) {
	_, roleIDs, err := s.getUserRoles(userID)
	if err != nil {
		return false, err
	}

	access, err := s.resolveFolderAccess(folderID, userID, roleIDs)
	if err != nil {
		return false, err
	}

	return access.CanWrite, nil
}

func (s *PermissionService) HasFolderViewAccess(folderID, userID int64) (bool, error) {
	_, roleIDs, err := s.getUserRoles(userID)
	if err != nil {
		return false, err
	}

	access, err := s.resolveFolderAccess(folderID, userID, roleIDs)
	if err != nil {
		return false, err
	}

	return access.CanView, nil
}

func (s *PermissionService) AttachFolderAccess(folder *model.Folder, userID int64) error {
	_, roleIDs, err := s.getUserRoles(userID)
	if err != nil {
		return err
	}

	access, err := s.resolveFolderAccess(folder.ID, userID, roleIDs)
	if err != nil {
		return err
	}

	folder.AccessLevel = access.AccessLevel
	folder.CanWrite = access.CanWrite
	folder.CanManage = access.CanManage
	return nil
}

func (s *PermissionService) CheckCellPermission(sheetID int64, userID int64, col string, row int, requiredPerm string) (bool, error) {
	matrix, err := s.GetPermissionMatrix(sheetID, userID)
	if err != nil {
		return false, err
	}

	cellKey := fmt.Sprintf("%d:%s", row, col)
	if cellPerm, ok := matrix.Cells[cellKey]; ok {
		return permissionSatisfies(cellPerm, requiredPerm), nil
	}

	if colPerm, ok := matrix.Columns[col]; ok {
		return permissionSatisfies(colPerm, requiredPerm), nil
	}

	switch requiredPerm {
	case "read":
		return matrix.Sheet.CanView, nil
	case "write":
		return matrix.Sheet.CanEdit, nil
	default:
		return false, nil
	}
}

func (s *PermissionService) getUserRoles(userID int64) ([]model.Role, []int64, error) {
	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get user roles: %w", err)
	}

	roleIDs := make([]int64, 0, len(roles))
	for _, role := range roles {
		roleIDs = append(roleIDs, role.ID)
	}

	return roles, roleIDs, nil
}

func (s *PermissionService) resolveFolderAccess(folderID, userID int64, roleIDs []int64) (*folderAccessResult, error) {
	isAdmin, err := s.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin {
		return &folderAccessResult{AccessLevel: "admin", CanView: true, CanWrite: true, CanManage: true}, nil
	}

	path, err := s.folderRepo.GetAncestorPath(folderID)
	if err != nil {
		return nil, fmt.Errorf("failed to load folder path: %w", err)
	}

	visibleMap := map[int64]bool{}
	if len(roleIDs) > 0 {
		visibleMap, err = s.folderRepo.GetVisibleFolderIDs(roleIDs)
		if err != nil {
			return nil, fmt.Errorf("failed to load folder visibility: %w", err)
		}
	}

	result := &folderAccessResult{AccessLevel: "", CanView: false, CanWrite: false, CanManage: false}
	for _, folder := range path {
		if folder.OwnerID == userID {
			result.CanView = true
			result.CanWrite = true
			if folder.ID == folderID {
				result.CanManage = true
				result.AccessLevel = "owner"
			} else if result.AccessLevel == "" || result.AccessLevel == "view" {
				result.AccessLevel = "edit"
			}
			continue
		}

		shareLevel, err := s.folderRepo.GetShareAccessLevel(folder.ID, userID)
		if err != nil {
			return nil, err
		}
		switch shareLevel {
		case "edit":
			result.CanView = true
			result.CanWrite = true
			if result.AccessLevel == "" || result.AccessLevel == "view" {
				result.AccessLevel = "edit"
			}
		case "view":
			result.CanView = true
			if result.AccessLevel == "" {
				result.AccessLevel = "view"
			}
		}

		if folder.ID == folderID && visibleMap[folder.ID] {
			result.CanView = true
			if result.AccessLevel == "" {
				result.AccessLevel = "view"
			}
		}
	}

	if !result.CanView {
		result.AccessLevel = ""
	}

	return result, nil
}

func permissionSatisfies(has, needs string) bool {
	levels := map[string]int{"none": 0, "read": 1, "write": 2}
	return levels[has] >= levels[needs]
}

func emptyPermissionMatrix() *model.PermissionMatrix {
	return &model.PermissionMatrix{
		Sheet:   model.SheetPerm{},
		Columns: make(map[string]string),
		Cells:   make(map[string]string),
	}
}

func hasAnyDirectUserSheetPermission(perm *model.UserSheetPermission) bool {
	if perm == nil {
		return false
	}

	return perm.CanView || perm.CanEdit || perm.CanDelete || perm.CanExport
}

func fullAccessMatrix() *model.PermissionMatrix {
	return &model.PermissionMatrix{
		Sheet: model.SheetPerm{
			CanView: true, CanEdit: true, CanDelete: true, CanExport: true,
		},
		Columns: make(map[string]string),
		Cells:   make(map[string]string),
	}
}
