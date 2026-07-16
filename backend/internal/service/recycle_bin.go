package service

import (
	"context"
	"errors"
	"log"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const RecycleBinRetentionDays = 30

var ErrRecycleBinAccessDenied = errors.New("recycle bin access denied")

type RecycleBinService struct {
	repo        *repo.RecycleBinRepo
	permService *PermissionService
}

func NewRecycleBinService(recycleRepo *repo.RecycleBinRepo, permService *PermissionService) *RecycleBinService {
	return &RecycleBinService{repo: recycleRepo, permService: permService}
}

func (s *RecycleBinService) List(userID int64) (*model.RecycleBinContents, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	folders, workbooks, err := s.repo.List(userID, isAdmin)
	if err != nil {
		return nil, err
	}
	return &model.RecycleBinContents{
		Folders:       folders,
		Workbooks:     workbooks,
		RetentionDays: RecycleBinRetentionDays,
	}, nil
}

func (s *RecycleBinService) RestoreWorkbook(userID, workbookID int64) error {
	workbook, err := s.repo.GetDeletedWorkbook(workbookID)
	if err != nil {
		return err
	}
	if err := s.authorize(userID, workbook.OwnerID, workbook.DeletedByID); err != nil {
		return err
	}
	return s.repo.RestoreWorkbook(workbookID)
}

func (s *RecycleBinService) RestoreFolder(userID, folderID int64) error {
	folder, err := s.repo.GetDeletedFolder(folderID)
	if err != nil {
		return err
	}
	if err := s.authorize(userID, folder.OwnerID, folder.DeletedByID); err != nil {
		return err
	}
	return s.repo.RestoreFolder(folder)
}

func (s *RecycleBinService) DeleteWorkbookPermanently(userID, workbookID int64) error {
	workbook, err := s.repo.GetDeletedWorkbook(workbookID)
	if err != nil {
		return err
	}
	if err := s.authorize(userID, workbook.OwnerID, workbook.DeletedByID); err != nil {
		return err
	}
	return s.repo.DeleteWorkbookPermanently(workbookID)
}

func (s *RecycleBinService) DeleteFolderPermanently(userID, folderID int64) error {
	folder, err := s.repo.GetDeletedFolder(folderID)
	if err != nil {
		return err
	}
	if err := s.authorize(userID, folder.OwnerID, folder.DeletedByID); err != nil {
		return err
	}
	return s.repo.DeleteFolderPermanently(folder)
}

func (s *RecycleBinService) authorize(userID, ownerID int64, deletedByID *int64) error {
	if userID == ownerID || (deletedByID != nil && userID == *deletedByID) {
		return nil
	}
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return ErrRecycleBinAccessDenied
	}
	return nil
}

func (s *RecycleBinService) CleanupExpired() (int64, error) {
	cutoff := time.Now().AddDate(0, 0, -RecycleBinRetentionDays)
	return s.repo.PurgeDeletedBefore(cutoff)
}

func (s *RecycleBinService) StartCleanup(ctx context.Context, interval time.Duration) {
	run := func() {
		removed, err := s.CleanupExpired()
		if err != nil {
			log.Printf("recycle bin cleanup failed: %v", err)
			return
		}
		if removed > 0 {
			log.Printf("recycle bin cleanup removed %d expired resources", removed)
		}
	}

	run()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			run()
		}
	}
}
