package service

import (
	"fmt"
	"strings"

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
	matrices       map[sheetPermissionLookupKey]*model.PermissionMatrix
}

type sheetPermissionLookupKey struct {
	SheetID int64
	UserID  int64
}

// getPermissionMatrixCached mirrors PermissionService.GetPermissionMatrix but
// shares the sheet, workbook, department and folder lookups through the scope.
func (s *PermissionService) getPermissionMatrixCached(sheetID int64, userID int64, cache *permissionLookupCache) (*model.PermissionMatrix, error) {
	key := sheetPermissionLookupKey{SheetID: sheetID, UserID: userID}
	if cache != nil {
		if matrix, ok := cache.matrices[key]; ok {
			return matrix, nil
		}
	}
	matrix, err := s.loadPermissionMatrixScoped(sheetID, userID, cache)
	if err == nil && cache != nil {
		if cache.matrices == nil {
			cache.matrices = make(map[sheetPermissionLookupKey]*model.PermissionMatrix)
		}
		cache.matrices[key] = matrix
	}
	return matrix, err
}

func (s *PermissionService) loadPermissionMatrixScoped(sheetID int64, userID int64, cache *permissionLookupCache) (*model.PermissionMatrix, error) {
	roles, roleIDs, err := s.getUserRolesCached(userID, cache)
	if err != nil {
		return nil, err
	}

	for _, role := range roles {
		if role.Code == "admin" {
			matrix := fullAccessMatrix()
			matrix.Grants = []model.PermissionGrant{grantFromSheetPerm("admin", 0, matrix.Sheet, false, "管理员不受表格权限限制")}
			return matrix, nil
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

	// Access resolution needs lifecycle/protection rules, not every cell value.
	sheet, err := s.sheetRepo.GetSearchSheet(sheetID)
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
		matrix := emptyPermissionMatrix()
		matrix.Grants = []model.PermissionGrant{{Source: "hidden", Replaces: true, Note: "工作簿已隐藏，只有管理员可见"}}
		return matrix, nil
	}

	if workbook.OwnerID == userID {
		matrix := fullAccessMatrix()
		matrix.Grants = []model.PermissionGrant{grantFromSheetPerm("owner", 0, matrix.Sheet, false, "工作簿创建者拥有全部权限")}
		recordStateGrant(matrix, workbook, sheet)
		return matrix, nil
	}

	matrix, err := s.permRepo.GetPermissionMatrix(sheetID, roleIDs)
	if err != nil {
		return nil, err
	}
	ensurePermissionMatrixLayers(matrix)
	if sheetPermGrantsAnything(matrix.Sheet) {
		matrix.Grants = append(matrix.Grants, grantFromSheetPerm("legacy_role", 0, matrix.Sheet, false, "旧版按角色设置的整表权限"))
	}
	if legacyRanges := len(matrix.Rows) + len(matrix.Columns) + len(matrix.Cells); legacyRanges > 0 {
		matrix.Grants = append(matrix.Grants, model.PermissionGrant{Source: "legacy_role_ranges", Note: fmt.Sprintf("%d 条旧版角色区域规则", legacyRanges)})
	}
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
		matrix.Grants = append(matrix.Grants, model.PermissionGrant{
			Source: "department", PrincipalID: permission.PrincipalID,
			CanView: permission.CanView, CanEdit: permission.CanEdit, CanDelete: permission.CanDelete, CanExport: permission.CanExport,
		})
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
		matrix.Grants = append(matrix.Grants, model.PermissionGrant{Source: "public", CanView: true, CanEdit: true, CanExport: true, Note: "公共工作簿"})
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
			denied := emptyPermissionMatrix()
			denied.Grants = []model.PermissionGrant{{Source: "folder_denied", Replaces: true, Note: "工作簿所在文件夹未共享给该员工，且没有任何单独授权"}}
			return denied, nil
		}
		if access.CanView {
			matrix.Sheet.CanView = true
			matrix.Grants = append(matrix.Grants, model.PermissionGrant{Source: "folder", CanView: true, Note: "所在文件夹已共享"})
		}
	}

	if userPerm != nil {
		matrix.Sheet.CanView = matrix.Sheet.CanView || userPerm.CanView
		matrix.Sheet.CanEdit = matrix.Sheet.CanEdit || userPerm.CanEdit
		matrix.Sheet.CanDelete = matrix.Sheet.CanDelete || userPerm.CanDelete
		matrix.Sheet.CanExport = matrix.Sheet.CanExport || userPerm.CanExport
		if hasAnyDirectUserSheetPermission(userPerm) {
			matrix.Grants = append(matrix.Grants, model.PermissionGrant{
				Source: "legacy_user", CanView: userPerm.CanView, CanEdit: userPerm.CanEdit, CanDelete: userPerm.CanDelete, CanExport: userPerm.CanExport,
				Note: "旧版单独授予该员工的整表权限",
			})
		}
	}
	if len(userPrincipalSheetPerms) > 0 {
		permission := userPrincipalSheetPerms[0]
		matrix.Sheet = model.SheetPerm{
			CanView: permission.CanView, CanEdit: permission.CanEdit,
			CanDelete: permission.CanDelete, CanExport: permission.CanExport,
		}
		matrix.ExplicitUserSheetRule = true
		matrix.Grants = append(matrix.Grants, grantFromSheetPerm("user", permission.PrincipalID, matrix.Sheet, true, "个人整表规则会覆盖上面所有来源（含公共表和文件夹共享）"))
	}

	matrix.DefaultPermission = defaultCellPermission(matrix.Sheet)
	mergePrincipalCellPermissions(&matrix.DepartmentOverrides, departmentCellPerms, false)
	mergePrincipalCellPermissions(&matrix.UserOverrides, userPrincipalCellPerms, true)
	ownerIsAdmin := func(ownerID int64) bool {
		roles, _, err := s.getUserRolesCached(ownerID, cache)
		if err != nil {
			return false
		}
		for _, role := range roles {
			if role.Code == "admin" {
				return true
			}
		}
		return false
	}
	mergeProtectionWhitelistPermissions(matrix, protections, userID, departmentSet, ownerIsAdmin)
	if !matrix.ExplicitUserSheetRule {
		beforeScoped := matrix.Sheet
		elevateMatrixForScopedPermissions(matrix)
		if matrix.Sheet != beforeScoped {
			matrix.Grants = append(matrix.Grants, grantFromSheetPerm("scoped", 0, matrix.Sheet, false, "区域规则或保护例外名单开放了部分单元格"))
		}
	}

	recordStateGrant(matrix, workbook, sheet)

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

	sheets, err := s.sheetRepo.GetSearchSheets(workbookID)
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

func grantFromSheetPerm(source string, principalID int64, perm model.SheetPerm, replaces bool, note string) model.PermissionGrant {
	return model.PermissionGrant{
		Source: source, PrincipalID: principalID,
		CanView: perm.CanView, CanEdit: perm.CanEdit, CanDelete: perm.CanDelete, CanExport: perm.CanExport,
		Replaces: replaces, Note: note,
	}
}

func sheetPermGrantsAnything(perm model.SheetPerm) bool {
	return perm.CanView || perm.CanEdit || perm.CanDelete || perm.CanExport
}

// recordStateGrant applies the workbook and sheet lifecycle states and notes
// when they took rights away.
func recordStateGrant(matrix *model.PermissionMatrix, workbook *model.Workbook, sheet *model.Sheet) {
	before := matrix.Sheet
	applyWorkbookStateToPermissionMatrix(workbook, matrix)
	applySheetStateToPermissionMatrix(sheet, matrix)
	if matrix.Sheet == before {
		return
	}
	reasons := make([]string, 0, 3)
	if workbook != nil && workbook.IsLocked {
		reasons = append(reasons, "工作簿已锁定")
	}
	if sheet != nil && sheet.IsHidden {
		reasons = append(reasons, "工作表已隐藏")
	}
	if sheet != nil && sheet.IsLocked {
		reasons = append(reasons, "工作表已锁定")
	}
	if sheet != nil && sheet.IsArchived {
		reasons = append(reasons, "工作表已归档")
	}
	matrix.Grants = append(matrix.Grants, grantFromSheetPerm("state", 0, matrix.Sheet, true, strings.Join(reasons, "、")))
}
