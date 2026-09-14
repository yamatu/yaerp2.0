package service

import (
	"fmt"

	"yaerp/internal/model"
)

// permissionLookupCache memoises the user and folder scoped queries that the
// permission checks share. A cache belongs to a single operation - listing a
// page of workbooks, walking a folder tree - and is discarded afterwards, so it
// cannot serve a stale decision: nothing it reads is expected to change while
// one request is being answered, and the next request reads everything again.
type permissionLookupCache struct {
	roles          map[int64][]model.Role
	roleIDs        map[int64][]int64
	admin          map[int64]bool
	visibleFolders map[int64]map[int64]bool
	folderAccess   map[folderAccessKey]*folderAccessResult
	shareLevels    map[folderShareKey]string
	workbookSheets map[int64][]model.Sheet
	workbooksById  map[int64]*model.Workbook
	departments    map[int64][]int64
}

// getPermissionMatrixCached mirrors PermissionService.GetPermissionMatrix but
// shares the sheet, workbook, department and folder lookups through the scope.
func (s *PermissionService) getPermissionMatrixCached(sheetID int64, userID int64, cache *permissionLookupCache) (*model.PermissionMatrix, error) {
	roles, roleIDs, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return nil, err
	}

	for _, role := range roles {
		if role.Code == "admin" {
			return fullAccessMatrix(), nil
		}
	}
	if s.sheetOverride != nil {
		handled, matrix, err := s.sheetOverride(userID, sheetID)
		if err != nil {
			return nil, err
		}
		if handled {
			if matrix == nil {
				return emptyPermissionMatrix(), nil
			}
			ensurePermissionMatrixLayers(matrix)
			return matrix, nil
		}
	}

	sheet, err := s.sheetRepo.GetSheet(sheetID)
	if err != nil {
		return nil, fmt.Errorf("failed to get sheet: %w", err)
	}
	if err := applySheetLifecycleState(sheet); err != nil {
		return nil, err
	}

	workbook, err := s.getWorkbookCached(sheet.WorkbookID, cache)
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
	ensurePermissionMatrixLayers(matrix)
	departmentIDs, err := s.departmentIDsCached(userID, cache)
	if err != nil {
		return nil, fmt.Errorf("failed to load user departments: %w", err)
	}
	_, protections, _, err := parseSheetConfigProtection(sheet.Config)
	if err != nil {
		return nil, fmt.Errorf("failed to load visual protection rules: %w", err)
	}
	departmentSet := int64Set(departmentIDs)
	hasVisualWhitelistAccess := protectionWhitelistHasAccess(protections, userID, departmentSet)
	employeeSheetPerms, departmentSheetPerms, err := s.permRepo.GetPrincipalSheetPermissionsForAccess(sheetID, userID, departmentIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to load principal sheet permissions: %w", err)
	}
	for _, permission := range departmentSheetPerms {
		mergeSheetPermission(&matrix.Sheet, permission)
	}
	employeeCellPerms, departmentCellPerms, err := s.permRepo.GetPrincipalCellPermissionsForAccess(sheetID, userID, departmentIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to load principal range permissions: %w", err)
	}
	userPrincipalSheetPerms := employeeSheetPerms
	userPrincipalCellPerms := employeeCellPerms
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
		access, err := s.resolveFolderAccessCached(*workbook.FolderID, userID, roleIDs, cache)
		if err != nil {
			return nil, fmt.Errorf("failed to check folder access: %w", err)
		}
		if !workbook.IsPublic && !access.CanView && !hasAnyDirectUserSheetPermission(userPerm) &&
			!hasPrincipalAccess(departmentSheetPerms, departmentCellPerms) &&
			!hasPrincipalAccess(userPrincipalSheetPerms, userPrincipalCellPerms) &&
			!hasVisualWhitelistAccess {
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
		matrix.ExplicitUserSheetRule = true
	}

	matrix.DefaultPermission = defaultCellPermission(matrix.Sheet)
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, departmentCellPerms, false)
	mergePrincipalCellPermissions(&matrix.UserOverrides, userPrincipalCellPerms, true)
	mergeProtectionWhitelistPermissions(matrix, protections, userID, departmentSet)
	if !matrix.ExplicitUserSheetRule {
		elevateMatrixForScopedPermissions(matrix)
	}

	applyWorkbookStateToPermissionMatrix(workbook, matrix)
	applySheetStateToPermissionMatrix(sheet, matrix)

	return matrix, nil
}

func (s *PermissionService) getWorkbookCached(workbookID int64, cache *permissionLookupCache) (*model.Workbook, error) {
	if cache != nil {
		if workbook, ok := cache.workbooksById[workbookID]; ok {
			return workbook, nil
		}
	}

	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return nil, err
	}

	if cache != nil {
		if cache.workbooksById == nil {
			cache.workbooksById = map[int64]*model.Workbook{}
		}
		cache.workbooksById[workbookID] = workbook
	}

	return workbook, nil
}

func (s *PermissionService) departmentIDsCached(userID int64, cache *permissionLookupCache) ([]int64, error) {
	if cache != nil {
		if ids, ok := cache.departments[userID]; ok {
			return ids, nil
		}
	}

	ids, err := s.departmentRepo.GetUserDepartmentIDs(userID)
	if err != nil {
		return nil, err
	}

	if cache != nil {
		if cache.departments == nil {
			cache.departments = map[int64][]int64{}
		}
		cache.departments[userID] = ids
	}

	return ids, nil
}

type folderAccessKey struct {
	userID   int64
	folderID int64
}

type folderShareKey struct {
	userID   int64
	folderID int64
}

// AccessScope reuses one lookup cache across every permission check of a single
// operation. Checking N workbooks or folders one by one used to repeat the same
// role, folder visibility and ancestor path queries N times; the scope runs
// each of them once.
//
// A scope is not safe for concurrent use and must not outlive the operation
// that created it.
type AccessScope struct {
	service *PermissionService
	cache   permissionLookupCache
}

// NewAccessScope creates a scope for one operation.
func (s *PermissionService) NewAccessScope() *AccessScope {
	return &AccessScope{service: s}
}

// IsAdmin reports whether the user has the admin role.
func (sc *AccessScope) IsAdmin(userID int64) (bool, error) {
	return sc.service.isAdminCached(userID, &sc.cache)
}

// PermissionMatrix resolves a sheet permission matrix, reusing the sheet,
// workbook and department lookups across the operation.
func (sc *AccessScope) PermissionMatrix(sheetID, userID int64) (*model.PermissionMatrix, error) {
	return sc.service.getPermissionMatrixCached(sheetID, userID, &sc.cache)
}

// CanViewWorkbook reports whether the user may open the workbook.
func (sc *AccessScope) CanViewWorkbook(workbook *model.Workbook, userID int64) (bool, error) {
	return sc.service.canViewWorkbookCached(workbook, userID, &sc.cache)
}

// CanManageWorkbook reports whether the user may change the workbook itself.
func (sc *AccessScope) CanManageWorkbook(workbook *model.Workbook, userID int64) (bool, error) {
	return sc.service.canManageWorkbookCached(workbook, userID, &sc.cache)
}

// Workbook returns the workbook row, sharing the scope cache so a caller that
// already touched it does not read it again.
func (sc *AccessScope) Workbook(workbookID int64) (*model.Workbook, error) {
	return sc.service.getWorkbookCached(workbookID, &sc.cache)
}

// DepartmentIDs returns the departments of the user, sharing the scope cache
// with the permission checks that already ran.
func (sc *AccessScope) DepartmentIDs(userID int64) ([]int64, error) {
	return sc.service.departmentIDsCached(userID, &sc.cache)
}

// HasFolderViewAccess reports whether the user may see the folder.
func (sc *AccessScope) HasFolderViewAccess(folderID, userID int64) (bool, error) {
	return sc.service.hasFolderViewAccessCached(folderID, userID, &sc.cache)
}

// CanWriteFolder reports whether the user may add content to the folder.
func (sc *AccessScope) CanWriteFolder(folderID, userID int64) (bool, error) {
	return sc.service.canWriteFolderCached(folderID, userID, &sc.cache)
}

// AttachFolderAccess fills the folder's access level and capabilities.
func (sc *AccessScope) AttachFolderAccess(folder *model.Folder, userID int64) error {
	return sc.service.attachFolderAccessCached(folder, userID, &sc.cache)
}

func (s *PermissionService) getUserRolesCached(userID int64, cache *permissionLookupCache) ([]model.Role, []int64, error) {
	if cache != nil {
		if roles, ok := cache.roles[userID]; ok {
			return roles, cache.roleIDs[userID], nil
		}
	}

	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to get user roles: %w", err)
	}

	roleIDs := make([]int64, 0, len(roles))
	for _, role := range roles {
		roleIDs = append(roleIDs, role.ID)
	}

	if cache != nil {
		if cache.roles == nil {
			cache.roles = map[int64][]model.Role{}
			cache.roleIDs = map[int64][]int64{}
		}
		cache.roles[userID] = roles
		cache.roleIDs[userID] = roleIDs
	}

	return roles, roleIDs, nil
}

func (s *PermissionService) isAdminCached(userID int64, cache *permissionLookupCache) (bool, error) {
	if cache != nil {
		if isAdmin, ok := cache.admin[userID]; ok {
			return isAdmin, nil
		}
	}

	roles, _, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return false, err
	}

	isAdmin := false
	for _, role := range roles {
		if role.Code == "admin" {
			isAdmin = true
			break
		}
	}

	if cache != nil {
		if cache.admin == nil {
			cache.admin = map[int64]bool{}
		}
		cache.admin[userID] = isAdmin
	}

	return isAdmin, nil
}

func (s *PermissionService) canManageWorkbookCached(workbook *model.Workbook, userID int64, cache *permissionLookupCache) (bool, error) {
	isAdmin, err := s.isAdminCached(userID, cache)
	if err != nil {
		return false, err
	}
	if isAdmin {
		return true, nil
	}
	if s.workbookOverride != nil {
		handled, allowed, overrideErr := s.workbookOverride(userID, workbook.ID, "manage")
		if overrideErr != nil {
			return false, overrideErr
		}
		if handled {
			return allowed, nil
		}
	}
	if workbook.OwnerID == userID {
		return true, nil
	}

	return false, nil
}

func (s *PermissionService) canViewWorkbookCached(workbook *model.Workbook, userID int64, cache *permissionLookupCache) (bool, error) {
	if err := applyWorkbookLifecycleState(workbook); err != nil {
		return false, err
	}
	isAdmin, err := s.isAdminCached(userID, cache)
	if err != nil {
		return false, err
	}
	if isAdmin {
		return true, nil
	}
	if workbook.IsHidden {
		return false, nil
	}
	if s.workbookOverride != nil {
		handled, allowed, overrideErr := s.workbookOverride(userID, workbook.ID, "view")
		if overrideErr != nil {
			return false, overrideErr
		}
		if handled {
			return allowed, nil
		}
	}
	if workbook.IsPublic {
		return true, nil
	}

	canManage, err := s.canManageWorkbookCached(workbook, userID, cache)
	if err != nil {
		return false, err
	}
	if canManage {
		return true, nil
	}

	if workbook.FolderID != nil {
		hasFolderAccess, err := s.hasFolderViewAccessCached(*workbook.FolderID, userID, cache)
		if err != nil {
			return false, err
		}
		if hasFolderAccess {
			return true, nil
		}
	}

	sheets, err := s.getSheetsByWorkbookCached(workbook.ID, cache)
	if err != nil {
		return false, err
	}

	for _, sheet := range sheets {
		matrix, err := s.getPermissionMatrixCached(sheet.ID, userID, cache)
		if err != nil {
			return false, err
		}
		if matrix.Sheet.CanView {
			return true, nil
		}
	}

	return false, nil
}

func (s *PermissionService) getSheetsByWorkbookCached(workbookID int64, cache *permissionLookupCache) ([]model.Sheet, error) {
	if cache != nil {
		if sheets, ok := cache.workbookSheets[workbookID]; ok {
			return sheets, nil
		}
	}

	sheets, err := s.sheetRepo.GetSheetsByWorkbook(workbookID)
	if err != nil {
		return nil, fmt.Errorf("failed to load workbook sheets: %w", err)
	}

	if cache != nil {
		if cache.workbookSheets == nil {
			cache.workbookSheets = map[int64][]model.Sheet{}
		}
		cache.workbookSheets[workbookID] = sheets
	}

	return sheets, nil
}

func (s *PermissionService) hasFolderViewAccessCached(folderID, userID int64, cache *permissionLookupCache) (bool, error) {
	_, roleIDs, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return false, err
	}

	access, err := s.resolveFolderAccessCached(folderID, userID, roleIDs, cache)
	if err != nil {
		return false, err
	}

	return access.CanView, nil
}

func (s *PermissionService) canWriteFolderCached(folderID, userID int64, cache *permissionLookupCache) (bool, error) {
	_, roleIDs, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return false, err
	}

	access, err := s.resolveFolderAccessCached(folderID, userID, roleIDs, cache)
	if err != nil {
		return false, err
	}

	return access.CanWrite, nil
}

func (s *PermissionService) attachFolderAccessCached(folder *model.Folder, userID int64, cache *permissionLookupCache) error {
	_, roleIDs, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return err
	}

	access, err := s.resolveFolderAccessCached(folder.ID, userID, roleIDs, cache)
	if err != nil {
		return err
	}

	folder.AccessLevel = access.AccessLevel
	folder.CanWrite = access.CanWrite
	folder.CanManage = access.CanManage
	return nil
}

func (s *PermissionService) resolveFolderAccessCached(folderID, userID int64, roleIDs []int64, cache *permissionLookupCache) (*folderAccessResult, error) {
	if cache != nil {
		if cached, ok := cache.folderAccess[folderAccessKey{userID: userID, folderID: folderID}]; ok {
			copied := *cached
			return &copied, nil
		}
	}

	isAdmin, err := s.isAdminCached(userID, cache)
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
		visibleMap, err = s.visibleFolderIDsCached(userID, roleIDs, cache)
		if err != nil {
			return nil, err
		}
	}

	result, err := resolveFolderAccessFromPath(folderID, userID, path, visibleMap, func(ancestorID int64) (string, error) {
		return s.shareAccessLevelCached(ancestorID, userID, cache)
	})
	if err != nil {
		return nil, err
	}

	if cache != nil {
		if cache.folderAccess == nil {
			cache.folderAccess = map[folderAccessKey]*folderAccessResult{}
		}
		cached := *result
		cache.folderAccess[folderAccessKey{userID: userID, folderID: folderID}] = &cached
	}

	return result, nil
}

// resolveFolderAccessFromPath holds the folder access rules themselves: a folder
// is visible to its owner, to anybody holding a share further up the chain, and
// to roles the folder was published to; the level is the strongest of those.
// Ancestors are expected from root to the folder itself. Keeping it separate
// from the repository lookups keeps the rules testable on their own.
func resolveFolderAccessFromPath(
	folderID, userID int64,
	path []model.Folder,
	visibleFolderIDs map[int64]bool,
	shareLevelOf func(folderID int64) (string, error),
) (*folderAccessResult, error) {
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

		shareLevel, err := shareLevelOf(folder.ID)
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

		if folder.ID == folderID && visibleFolderIDs[folder.ID] {
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

func (s *PermissionService) visibleFolderIDsCached(userID int64, roleIDs []int64, cache *permissionLookupCache) (map[int64]bool, error) {
	if cache != nil {
		if visible, ok := cache.visibleFolders[userID]; ok {
			return visible, nil
		}
	}

	visible, err := s.folderRepo.GetVisibleFolderIDs(roleIDs)
	if err != nil {
		return nil, fmt.Errorf("failed to load folder visibility: %w", err)
	}

	if cache != nil {
		if cache.visibleFolders == nil {
			cache.visibleFolders = map[int64]map[int64]bool{}
		}
		cache.visibleFolders[userID] = visible
	}

	return visible, nil
}

func (s *PermissionService) shareAccessLevelCached(folderID, userID int64, cache *permissionLookupCache) (string, error) {
	if cache != nil {
		if level, ok := cache.shareLevels[folderShareKey{userID: userID, folderID: folderID}]; ok {
			return level, nil
		}
	}

	level, err := s.folderRepo.GetShareAccessLevel(folderID, userID)
	if err != nil {
		return "", err
	}

	if cache != nil {
		if cache.shareLevels == nil {
			cache.shareLevels = map[folderShareKey]string{}
		}
		cache.shareLevels[folderShareKey{userID: userID, folderID: folderID}] = level
	}

	return level, nil
}
