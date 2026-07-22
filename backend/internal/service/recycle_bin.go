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
	repo                  *repo.RecycleBinRepo
	permService           *PermissionService
	uploadService         *UploadService
	tradeOrderChangedHook func(orderID int64)
}

func NewRecycleBinService(recycleRepo *repo.RecycleBinRepo, permService *PermissionService, uploadService *UploadService) *RecycleBinService {
	return &RecycleBinService{repo: recycleRepo, permService: permService, uploadService: uploadService}
}

func (s *RecycleBinService) List(userID int64) (*model.RecycleBinContents, error) {
	isAdmin, err := s.permService.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	folders, workbooks, tradeOrders, err := s.repo.List(userID, isAdmin)
	if err != nil {
		return nil, err
	}
	paymentProofs := make([]model.DeletedTradePaymentProof, 0)
	if isAdmin {
		paymentProofs, err = s.repo.ListDeletedTradePaymentProofs()
		if err != nil {
			return nil, err
		}
		for index := range paymentProofs {
			paymentProofs[index].AttachmentURL, _ = s.uploadService.GetFileURL(paymentProofs[index].AttachmentID)
			paymentProofs[index].ThumbnailURL = s.uploadService.GetThumbnailURL(paymentProofs[index].AttachmentID, 320)
		}
	}
	return &model.RecycleBinContents{
		Folders: folders, Workbooks: workbooks, TradeOrders: tradeOrders,
		TradePaymentProofs: paymentProofs, RetentionDays: RecycleBinRetentionDays,
	}, nil
}

func (s *RecycleBinService) SetTradeOrderChangedHook(hook func(orderID int64)) {
	s.tradeOrderChangedHook = hook
}

func (s *RecycleBinService) RestoreTradeOrder(userID, orderID int64) error {
	if err := s.requireAdmin(userID); err != nil {
		return err
	}
	if _, err := s.repo.GetDeletedTradeOrder(orderID); err != nil {
		return err
	}
	if err := s.repo.RestoreTradeOrder(orderID, userID); err != nil {
		return err
	}
	if s.tradeOrderChangedHook != nil {
		s.tradeOrderChangedHook(orderID)
	}
	return nil
}

func (s *RecycleBinService) DeleteTradeOrderPermanently(userID, orderID int64) error {
	if err := s.requireAdmin(userID); err != nil {
		return err
	}
	if _, err := s.repo.GetDeletedTradeOrder(orderID); err != nil {
		return err
	}
	if err := s.repo.DeleteTradeOrderPermanently(orderID); err != nil {
		return err
	}
	if s.tradeOrderChangedHook != nil {
		s.tradeOrderChangedHook(orderID)
	}
	return nil
}

func (s *RecycleBinService) RestoreTradePaymentProof(userID, proofID int64) error {
	if err := s.requireAdmin(userID); err != nil {
		return err
	}
	proof, err := s.repo.GetDeletedTradePaymentProof(proofID)
	if err != nil {
		return err
	}
	if err := s.repo.RestoreTradePaymentProof(proofID); err != nil {
		return err
	}
	if s.tradeOrderChangedHook != nil {
		s.tradeOrderChangedHook(proof.OrderID)
	}
	return nil
}

func (s *RecycleBinService) DeleteTradePaymentProofPermanently(userID, proofID int64) error {
	if err := s.requireAdmin(userID); err != nil {
		return err
	}
	proof, err := s.repo.GetDeletedTradePaymentProof(proofID)
	if err != nil {
		return err
	}
	if err := s.uploadService.DeleteFile(proof.AttachmentID); err != nil {
		if deleteErr := s.repo.DeleteTradePaymentProofPermanently(proofID); deleteErr != nil {
			return deleteErr
		}
	}
	if s.tradeOrderChangedHook != nil {
		s.tradeOrderChangedHook(proof.OrderID)
	}
	return nil
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

func (s *RecycleBinService) requireAdmin(userID int64) error {
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
	attachmentIDs, err := s.repo.ListExpiredTradePaymentProofAttachmentIDs(cutoff)
	if err != nil {
		return 0, err
	}
	var removedAttachments int64
	for _, attachmentID := range attachmentIDs {
		if err := s.uploadService.DeleteFile(attachmentID); err != nil {
			log.Printf("recycle bin cleanup could not remove payment proof attachment %d: %v", attachmentID, err)
			continue
		}
		removedAttachments++
	}
	removedResources, err := s.repo.PurgeDeletedBefore(cutoff)
	return removedAttachments + removedResources, err
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
