package service

import (
	"fmt"
	"strings"

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
	permRepo       *repo.PermissionRepo
	userRepo       *repo.UserRepo
	sheetRepo      *repo.SheetRepo
	folderRepo     *repo.FolderRepo
	departmentRepo *repo.DepartmentRepo
}

func NewPermissionService(permRepo *repo.PermissionRepo, userRepo *repo.UserRepo, sheetRepo *repo.SheetRepo, folderRepo *repo.FolderRepo, departmentRepo *repo.DepartmentRepo) *PermissionService {
	return &PermissionService{permRepo: permRepo, userRepo: userRepo, sheetRepo: sheetRepo, folderRepo: folderRepo, departmentRepo: departmentRepo}
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

func (s *PermissionService) SetPrincipalSheetPermission(req *model.SetPrincipalSheetPermissionRequest) error {
	if err := s.validatePrincipal(req.PrincipalType, req.PrincipalID); err != nil {
		return err
	}
	permission := &model.PrincipalSheetPermission{
		SheetID: req.SheetID, PrincipalType: req.PrincipalType, PrincipalID: req.PrincipalID,
		CanView: req.CanView || req.CanEdit || req.CanDelete || req.CanExport,
		CanEdit: req.CanEdit, CanDelete: req.CanDelete, CanExport: req.CanExport,
	}
	return s.permRepo.SetPrincipalSheetPermission(permission)
}

func (s *PermissionService) SetPrincipalCellPermission(req *model.SetPrincipalCellPermissionRequest) error {
	if err := s.validatePrincipal(req.PrincipalType, req.PrincipalID); err != nil {
		return err
	}
	if strings.TrimSpace(req.ColumnKey) == "" && req.RowIndex == nil {
		return fmt.Errorf("row_index or column_key is required")
	}
	permission := &model.PrincipalCellPermission{
		SheetID: req.SheetID, PrincipalType: req.PrincipalType, PrincipalID: req.PrincipalID,
		ColumnKey: strings.TrimSpace(req.ColumnKey), RowIndex: req.RowIndex, Permission: req.Permission,
	}
	return s.permRepo.SetPrincipalCellPermission(permission)
}

func (s *PermissionService) DeletePrincipalCellPermission(id int64) error {
	if id <= 0 {
		return fmt.Errorf("invalid range permission id")
	}
	return s.permRepo.DeletePrincipalCellPermission(id)
}

func (s *PermissionService) GetPrincipalPermissionConfig(sheetID int64, principalType string, principalID int64) (*model.PrincipalPermissionConfig, error) {
	if err := s.validatePrincipal(principalType, principalID); err != nil {
		return nil, err
	}
	return s.permRepo.GetPrincipalPermissionConfig(sheetID, principalType, principalID)
}

func (s *PermissionService) ValidateEditableUsers(userIDs []int64) error {
	seen := make(map[int64]struct{}, len(userIDs))
	for _, userID := range userIDs {
		if userID <= 0 {
			return fmt.Errorf("invalid editable user id %d", userID)
		}
		if _, exists := seen[userID]; exists {
			continue
		}
		seen[userID] = struct{}{}
		user, err := s.userRepo.GetByID(userID)
		if err != nil {
			return fmt.Errorf("load editable user %d: %w", userID, err)
		}
		if user == nil || user.Status != 1 {
			return fmt.Errorf("editable user %d does not exist or is disabled", userID)
		}
	}
	return nil
}

func (s *PermissionService) ValidateDepartments(departmentIDs []int64) error {
	seen := make(map[int64]struct{}, len(departmentIDs))
	for _, departmentID := range departmentIDs {
		if departmentID <= 0 {
			return fmt.Errorf("invalid department id %d", departmentID)
		}
		if _, exists := seen[departmentID]; exists {
			continue
		}
		seen[departmentID] = struct{}{}
		department, err := s.departmentRepo.GetByID(departmentID)
		if err != nil {
			return fmt.Errorf("load department %d: %w", departmentID, err)
		}
		if department == nil {
			return fmt.Errorf("department %d does not exist", departmentID)
		}
	}
	return nil
}

func (s *PermissionService) GetUserDepartmentIDs(userID int64) ([]int64, error) {
	return s.departmentRepo.GetUserDepartmentIDs(userID)
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
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, err
	}

	workbook, err := s.sheetRepo.GetWorkbook(sheet.WorkbookID)
	if err != nil {
		return nil, fmt.Errorf("failed to get workbook: %w", err)
	}
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return nil, err
	}
	if workbook.IsHidden {
		return emptyPermissionMatrix(), nil
	}

	if workbook.OwnerID == userID {
		matrix := fullAccessMatrix()
		applyWorkbookStateToPermissionMatrix(workbook, matrix)
		applySheetStateToPermissionMatrix(sheet, matrix)
		return matrix, nil
	}

	matrix, err := s.permRepo.GetPermissionMatrix(sheetID, roleIDs)
	if err != nil {
		return nil, err
	}
	departmentIDs, err := s.departmentRepo.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, fmt.Errorf("failed to load user departments: %w", err)
	}
	departmentSheetPerms, err := s.permRepo.GetPrincipalSheetPermissions(sheetID, "department", departmentIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to load department sheet permissions: %w", err)
	}
	for _, permission := range departmentSheetPerms {
		mergeSheetPermission(&matrix.Sheet, permission)
	}
	departmentCellPerms, err := s.permRepo.GetPrincipalCellPermissions(sheetID, "department", departmentIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to load department range permissions: %w", err)
	}
	userPrincipalSheetPerms, err := s.permRepo.GetPrincipalSheetPermissions(sheetID, "user", []int64{userID})
	if err != nil {
		return nil, fmt.Errorf("failed to load employee sheet permission: %w", err)
	}
	userPrincipalCellPerms, err := s.permRepo.GetPrincipalCellPermissions(sheetID, "user", []int64{userID})
	if err != nil {
		return nil, fmt.Errorf("failed to load employee range permissions: %w", err)
	}
	if workbook.IsPublic {
		matrix.Sheet.CanView = true
		matrix.Sheet.CanEdit = true
		matrix.Sheet.CanExport = true
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
		if !workbook.IsPublic && !access.CanView && !hasAnyDirectUserSheetPermission(userPerm) &&
			!hasPrincipalAccess(departmentSheetPerms, departmentCellPerms) &&
			!hasPrincipalAccess(userPrincipalSheetPerms, userPrincipalCellPerms) {
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
	if len(userPrincipalSheetPerms) > 0 {
		permission := userPrincipalSheetPerms[0]
		matrix.Sheet = model.SheetPerm{
			CanView: permission.CanView, CanEdit: permission.CanEdit,
			CanDelete: permission.CanDelete, CanExport: permission.CanExport,
		}
	}

	matrix.DefaultPermission = defaultCellPermission(matrix.Sheet)
	mergePrincipalCellPermissions(matrix, departmentCellPerms, false)
	mergePrincipalCellPermissions(matrix, userPrincipalCellPerms, true)
	elevateMatrixForScopedPermissions(matrix)

	applyWorkbookStateToPermissionMatrix(workbook, matrix)
	applySheetStateToPermissionMatrix(sheet, matrix)

	return matrix, nil
}

func (s *PermissionService) GetPermissionMatrixForRole(sheetID, roleID int64) (*model.PermissionMatrix, error) {
	matrix, err := s.permRepo.GetPermissionMatrix(sheetID, []int64{roleID})
	if err != nil {
		return nil, err
	}
	matrix.DefaultPermission = defaultCellPermission(matrix.Sheet)
	return matrix, nil
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
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return false, err
	}
	isAdmin, err := s.IsAdmin(userID)
	if err != nil {
		return false, err
	}
	if isAdmin {
		return true, nil
	}
	if workbook.IsHidden {
		return false, nil
	}
	if workbook.IsPublic {
		return true, nil
	}

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

	return permissionMatrixAllowsCell(matrix, col, row, requiredPerm), nil
}

func (s *PermissionService) validatePrincipal(principalType string, principalID int64) error {
	if principalID <= 0 {
		return fmt.Errorf("invalid principal id")
	}
	switch principalType {
	case "department":
		return s.ValidateDepartments([]int64{principalID})
	case "user":
		return s.ValidateEditableUsers([]int64{principalID})
	default:
		return fmt.Errorf("unsupported principal type")
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

func mergeSheetPermission(target *model.SheetPerm, permission model.PrincipalSheetPermission) {
	if target == nil {
		return
	}
	target.CanView = target.CanView || permission.CanView
	target.CanEdit = target.CanEdit || permission.CanEdit
	target.CanDelete = target.CanDelete || permission.CanDelete
	target.CanExport = target.CanExport || permission.CanExport
}

func defaultCellPermission(permission model.SheetPerm) string {
	if permission.CanEdit {
		return "write"
	}
	if permission.CanView {
		return "read"
	}
	return "none"
}

func mergePrincipalCellPermissions(matrix *model.PermissionMatrix, permissions []model.PrincipalCellPermission, override bool) {
	if matrix == nil {
		return
	}
	for _, permission := range permissions {
		columnKey := strings.TrimSpace(permission.ColumnKey)
		var target map[string]string
		var key string
		switch {
		case permission.RowIndex != nil && columnKey != "":
			target = matrix.Cells
			key = fmt.Sprintf("%d:%s", *permission.RowIndex, columnKey)
		case permission.RowIndex != nil:
			target = matrix.Rows
			key = fmt.Sprintf("%d", *permission.RowIndex)
		case columnKey != "":
			target = matrix.Columns
			key = columnKey
		default:
			continue
		}
		if override {
			target[key] = permission.Permission
		} else {
			target[key] = bestPermissionValue(target[key], permission.Permission)
		}
	}
}

func bestPermissionValue(current, next string) string {
	levels := map[string]int{"": -1, "none": 0, "read": 1, "write": 2}
	if levels[next] > levels[current] {
		return next
	}
	return current
}

func elevateMatrixForScopedPermissions(matrix *model.PermissionMatrix) {
	if matrix == nil {
		return
	}
	for _, permissions := range []map[string]string{matrix.Rows, matrix.Columns, matrix.Cells} {
		for _, permission := range permissions {
			if permissionSatisfies(permission, "read") {
				matrix.Sheet.CanView = true
			}
			if permissionSatisfies(permission, "write") {
				matrix.Sheet.CanEdit = true
			}
		}
	}
}

func hasPrincipalAccess(sheetPermissions []model.PrincipalSheetPermission, cellPermissions []model.PrincipalCellPermission) bool {
	for _, permission := range sheetPermissions {
		if permission.CanView || permission.CanEdit || permission.CanDelete || permission.CanExport {
			return true
		}
	}
	for _, permission := range cellPermissions {
		if permission.Permission == "read" || permission.Permission == "write" {
			return true
		}
	}
	return false
}

func emptyPermissionMatrix() *model.PermissionMatrix {
	return &model.PermissionMatrix{
		Sheet:             model.SheetPerm{},
		DefaultPermission: "none",
		Rows:              make(map[string]string),
		Columns:           make(map[string]string),
		Cells:             make(map[string]string),
	}
}

func hasAnyDirectUserSheetPermission(perm *model.UserSheetPermission) bool {
	if perm == nil {
		return false
	}

	return perm.CanView || perm.CanEdit || perm.CanDelete || perm.CanExport
}

func applySheetStateToPermissionMatrix(sheet *model.Sheet, matrix *model.PermissionMatrix) {
	if sheet == nil || matrix == nil {
		return
	}
	if sheet.IsHidden {
		matrix.Sheet.CanView = false
		matrix.Sheet.CanEdit = false
		matrix.Sheet.CanDelete = false
		matrix.Sheet.CanExport = false
		matrix.DefaultPermission = "none"
		setAllScopedPermissions(matrix, "none")
		return
	}
	if sheet.IsLocked || sheet.IsArchived {
		matrix.Sheet.CanEdit = false
		matrix.Sheet.CanDelete = false
		if matrix.DefaultPermission == "write" {
			matrix.DefaultPermission = "read"
		}
		downgradeScopedWritePermissions(matrix)
	}
}

func setAllScopedPermissions(matrix *model.PermissionMatrix, permission string) {
	if matrix == nil {
		return
	}
	for _, permissions := range []map[string]string{matrix.Rows, matrix.Columns, matrix.Cells} {
		for key := range permissions {
			permissions[key] = permission
		}
	}
}

func downgradeScopedWritePermissions(matrix *model.PermissionMatrix) {
	if matrix == nil {
		return
	}
	for _, permissions := range []map[string]string{matrix.Rows, matrix.Columns, matrix.Cells} {
		for key, permission := range permissions {
			if permission == "write" {
				permissions[key] = "read"
			}
		}
	}
}

func fullAccessMatrix() *model.PermissionMatrix {
	return &model.PermissionMatrix{
		Sheet: model.SheetPerm{
			CanView: true, CanEdit: true, CanDelete: true, CanExport: true,
		},
		DefaultPermission: "write",
		Rows:              make(map[string]string),
		Columns:           make(map[string]string),
		Cells:             make(map[string]string),
	}
}
