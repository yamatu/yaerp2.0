package service

import (
	"yaerp/internal/model"
	"yaerp/internal/repo"
)

type FolderService struct {
	folderRepo *repo.FolderRepo
	userRepo   *repo.UserRepo
}

func NewFolderService(folderRepo *repo.FolderRepo, userRepo *repo.UserRepo) *FolderService {
	return &FolderService{
		folderRepo: folderRepo,
		userRepo:   userRepo,
	}
}

func (s *FolderService) Create(folder *model.Folder) error {
	return s.folderRepo.Create(folder)
}

func (s *FolderService) Get(id int64) (*model.Folder, error) {
	return s.folderRepo.GetByID(id)
}

func (s *FolderService) Update(folder *model.Folder) error {
	return s.folderRepo.Update(folder)
}

func (s *FolderService) Delete(id int64) error {
	return s.folderRepo.Delete(id)
}

func (s *FolderService) ListContents(parentID *int64, userID int64) (*model.FolderContents, error) {
	folders, err := s.folderRepo.ListSubFolders(parentID)
	if err != nil {
		return nil, err
	}

	workbooks, err := s.folderRepo.ListWorkbooksInFolder(parentID)
	if err != nil {
		return nil, err
	}

	// Check if user is admin - admins see everything
	roles, err := s.userRepo.GetUserRoles(userID)
	if err != nil {
		return nil, err
	}

	isAdmin := false
	roleIDs := make([]int64, 0, len(roles))
	for _, role := range roles {
		roleIDs = append(roleIDs, role.ID)
		if role.Code == "admin" {
			isAdmin = true
		}
	}

	if isAdmin {
		return &model.FolderContents{
			Folders:   folders,
			Workbooks: workbooks,
		}, nil
	}

	// Filter folders by visibility rules
	visibleMap, err := s.folderRepo.GetVisibleFolderIDs(roleIDs)
	if err != nil {
		return nil, err
	}

	filteredFolders := make([]model.Folder, 0, len(folders))
	for _, folder := range folders {
		hasRules, err := s.folderRepo.HasVisibilityRules(folder.ID)
		if err != nil {
			return nil, err
		}
		// If no visibility rules exist, folder is visible to all
		if !hasRules || visibleMap[folder.ID] {
			filteredFolders = append(filteredFolders, folder)
		}
	}

	return &model.FolderContents{
		Folders:   filteredFolders,
		Workbooks: workbooks,
	}, nil
}

func (s *FolderService) MoveWorkbook(workbookID int64, folderID *int64) error {
	return s.folderRepo.MoveWorkbook(workbookID, folderID)
}

func (s *FolderService) SetVisibility(folderID int64, entries []model.FolderVisibility) error {
	return s.folderRepo.SetVisibility(folderID, entries)
}

func (s *FolderService) GetBreadcrumb(folderID int64) ([]model.Folder, error) {
	return s.folderRepo.GetAncestorPath(folderID)
}
