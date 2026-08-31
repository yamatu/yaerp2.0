package service

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

var ErrFolderAccessDenied = errors.New("folder access denied")
var ErrFolderManageDenied = errors.New("folder manage denied")

type FolderService struct {
	folderRepo  *repo.FolderRepo
	userRepo    *repo.UserRepo
	sheetRepo   *repo.SheetRepo
	permService *PermissionService
}

func NewFolderService(folderRepo *repo.FolderRepo, userRepo *repo.UserRepo, sheetRepo *repo.SheetRepo, permService *PermissionService) *FolderService {
	return &FolderService{
		folderRepo:  folderRepo,
		userRepo:    userRepo,
		sheetRepo:   sheetRepo,
		permService: permService,
	}
}

func (s *FolderService) CreateForUser(userID int64, folder *model.Folder) error {
	if folder.ParentID != nil {
		canWrite, err := s.permService.CanWriteFolder(*folder.ParentID, userID)
		if err != nil {
			return err
		}
		if !canWrite {
			return ErrFolderManageDenied
		}
	}

	return s.folderRepo.Create(folder)
}

func (s *FolderService) Get(id int64) (*model.Folder, error) {
	return s.folderRepo.GetByID(id)
}

func (s *FolderService) UpdateForUser(userID int64, folder *model.Folder) error {
	existing, err := s.folderRepo.GetByID(folder.ID)
	if err != nil {
		return err
	}

	canManage, err := s.permService.CanManageFolder(existing, userID)
	if err != nil {
		return err
	}
	if !canManage {
		return ErrFolderManageDenied
	}

	return s.folderRepo.Update(folder)
}

func (s *FolderService) DeleteForUser(userID, id int64) error {
	folder, err := s.folderRepo.GetByID(id)
	if err != nil {
		return err
	}

	canManage, err := s.permService.CanManageFolder(folder, userID)
	if err != nil {
		return err
	}
	if !canManage {
		return ErrFolderManageDenied
	}

	return s.folderRepo.SoftDelete(id, userID)
}

func (s *FolderService) ListContents(parentID *int64, userID int64) (*model.FolderContents, error) {
	if parentID != nil {
		hasAccess, err := s.permService.HasFolderViewAccess(*parentID, userID)
		if err != nil {
			return nil, err
		}
		if !hasAccess {
			return nil, ErrFolderAccessDenied
		}
	}

	folders, err := s.folderRepo.ListSubFolders(parentID)
	if err != nil {
		return nil, err
	}

	workbooks, err := s.folderRepo.ListWorkbooksInFolder(parentID)
	if err != nil {
		return nil, err
	}

	filteredFolders := make([]model.Folder, 0, len(folders))
	for _, folder := range folders {
		hasAccess, err := s.permService.HasFolderViewAccess(folder.ID, userID)
		if err != nil {
			return nil, err
		}
		if hasAccess {
			if err := s.permService.AttachFolderAccess(&folder, userID); err != nil {
				return nil, err
			}
			filteredFolders = append(filteredFolders, folder)
		}
	}

	filteredWorkbooks := make([]model.Workbook, 0, len(workbooks))
	for _, workbook := range workbooks {
		canView, err := s.permService.CanViewWorkbook(&workbook, userID)
		if err != nil {
			return nil, err
		}
		if canView {
			filteredWorkbooks = append(filteredWorkbooks, workbook)
		}
	}

	return &model.FolderContents{
		Folders:   filteredFolders,
		Workbooks: filteredWorkbooks,
	}, nil
}

func (s *FolderService) ListWritableOptionsForUser(userID int64) ([]model.FolderOption, error) {
	folders, err := s.folderRepo.ListAllActive()
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]model.Folder, len(folders))
	for _, folder := range folders {
		byID[folder.ID] = folder
	}

	pathFor := func(folder model.Folder) string {
		parts := make([]string, 0, 4)
		seen := make(map[int64]struct{})
		current := folder
		for {
			if _, duplicate := seen[current.ID]; duplicate {
				break
			}
			seen[current.ID] = struct{}{}
			parts = append(parts, strings.TrimSpace(current.Name))
			if current.ParentID == nil {
				break
			}
			parent, ok := byID[*current.ParentID]
			if !ok {
				break
			}
			current = parent
		}
		for left, right := 0, len(parts)-1; left < right; left, right = left+1, right-1 {
			parts[left], parts[right] = parts[right], parts[left]
		}
		return strings.Join(parts, " / ")
	}

	options := make([]model.FolderOption, 0, len(folders))
	for _, folder := range folders {
		canWrite, err := s.permService.CanWriteFolder(folder.ID, userID)
		if err != nil {
			return nil, err
		}
		if !canWrite {
			continue
		}
		options = append(options, model.FolderOption{
			ID: folder.ID, Name: folder.Name, Path: pathFor(folder), ParentID: folder.ParentID,
			OwnerID: folder.OwnerID, CanWrite: true,
		})
	}
	sort.Slice(options, func(i, j int) bool {
		return strings.ToLower(options[i].Path) < strings.ToLower(options[j].Path)
	})
	return options, nil
}

func (s *FolderService) MoveWorkbookForUser(userID, workbookID int64, folderID *int64) error {
	workbook, err := s.sheetRepo.GetWorkbook(workbookID)
	if err != nil {
		return err
	}

	canManageWorkbook, err := s.permService.CanManageWorkbook(workbook, userID)
	if err != nil {
		return err
	}
	if !canManageWorkbook {
		return ErrWorkbookAccessDenied
	}

	if folderID != nil {
		canWriteFolder, err := s.permService.CanWriteFolder(*folderID, userID)
		if err != nil {
			return err
		}
		if !canWriteFolder {
			return ErrFolderManageDenied
		}
	}

	return s.folderRepo.MoveWorkbook(workbookID, folderID)
}

func (s *FolderService) SetVisibility(folderID int64, entries []model.FolderVisibility) error {
	return s.folderRepo.SetVisibility(folderID, entries)
}

func (s *FolderService) SetSharesForUser(userID, folderID int64, shares []model.FolderShareEntry) error {
	folder, err := s.folderRepo.GetByID(folderID)
	if err != nil {
		return err
	}

	canManage, err := s.permService.CanManageFolder(folder, userID)
	if err != nil {
		return err
	}
	if !canManage {
		return ErrFolderManageDenied
	}

	normalizedShares := make([]model.FolderShareEntry, 0, len(shares))
	seen := make(map[int64]struct{}, len(shares))
	for _, share := range shares {
		if share.UserID == 0 || share.UserID == userID || share.UserID == folder.OwnerID {
			continue
		}
		if _, ok := seen[share.UserID]; ok {
			continue
		}

		user, err := s.userRepo.GetByID(share.UserID)
		if err != nil {
			return err
		}
		if user == nil {
			return fmt.Errorf("user %d not found", share.UserID)
		}
		if user.Status != 1 {
			return fmt.Errorf("user %d is disabled", share.UserID)
		}
		if share.AccessLevel != "view" && share.AccessLevel != "edit" {
			return fmt.Errorf("unsupported access level %q", share.AccessLevel)
		}

		seen[share.UserID] = struct{}{}
		normalizedShares = append(normalizedShares, share)
	}

	return s.folderRepo.SetShares(folderID, normalizedShares)
}

func (s *FolderService) GetSharesForUser(userID, folderID int64) ([]model.FolderShareUser, error) {
	folder, err := s.folderRepo.GetByID(folderID)
	if err != nil {
		return nil, err
	}

	canManage, err := s.permService.CanManageFolder(folder, userID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, ErrFolderManageDenied
	}

	return s.folderRepo.ListShares(folderID)
}

func (s *FolderService) GetBreadcrumbForUser(userID, folderID int64) ([]model.Folder, error) {
	hasAccess, err := s.permService.HasFolderViewAccess(folderID, userID)
	if err != nil {
		return nil, err
	}
	if !hasAccess {
		return nil, ErrFolderAccessDenied
	}

	path, err := s.folderRepo.GetAncestorPath(folderID)
	if err != nil {
		return nil, err
	}

	for i := range path {
		if err := s.permService.AttachFolderAccess(&path[i], userID); err != nil {
			return nil, err
		}
	}

	return path, nil
}

func (s *FolderService) ListDirectlySharedForUser(userID int64) ([]model.Folder, error) {
	folders, err := s.folderRepo.ListDirectlySharedFolders(userID)
	if err != nil {
		return nil, err
	}

	for i := range folders {
		if err := s.permService.AttachFolderAccess(&folders[i], userID); err != nil {
			return nil, err
		}
	}

	return folders, nil
}

func (s *FolderService) ListShareableUsersForUser(userID, folderID int64) ([]model.User, error) {
	folder, err := s.folderRepo.GetByID(folderID)
	if err != nil {
		return nil, err
	}

	canManage, err := s.permService.CanManageFolder(folder, userID)
	if err != nil {
		return nil, err
	}
	if !canManage {
		return nil, ErrFolderManageDenied
	}

	users, _, err := s.userRepo.List(1, 1000)
	if err != nil {
		return nil, err
	}

	result := make([]model.User, 0, len(users))
	for _, user := range users {
		if user.ID == userID || user.ID == folder.OwnerID || user.Status != 1 {
			continue
		}
		result = append(result, model.User{
			ID:       user.ID,
			Username: user.Username,
			Email:    user.Email,
			Status:   user.Status,
		})
	}

	return result, nil
}
