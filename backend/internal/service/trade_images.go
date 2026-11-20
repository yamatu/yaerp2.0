package service

import (
	"database/sql"
	"errors"
	"fmt"
	"mime/multipart"

	"yaerp/internal/model"
)

// tradeImageRights is what the user may do with the pictures of an order
// they can see.
func (s *TradeService) tradeImageRights(userID, orderID int64) (*model.TradeOrderAccess, error) {
	order, err := s.repo.GetOrder(orderID, userID, true)
	if err != nil {
		return nil, sql.ErrNoRows
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !s.canViewTradeOrder(userID, order, access) {
		return nil, sql.ErrNoRows
	}
	return s.orderAccessForUser(userID, order, access)
}

// DeleteInspectionPhoto removes a wrong inspection photo from the order; the
// picture itself stays in the gallery.
func (s *TradeService) DeleteInspectionPhoto(userID, orderID, photoID int64) error {
	rights, err := s.tradeImageRights(userID, orderID)
	if err != nil {
		return err
	}
	uploadedBy, err := s.repo.InspectionPhotoUploader(orderID, photoID)
	if err != nil {
		return err
	}
	if !rights.CanManageInspectionPhotos && uploadedBy != userID {
		return fmt.Errorf("只有上传人、质检负责人或业务负责人可以删除质检照片")
	}
	if err := s.repo.DeleteInspectionPhoto(orderID, photoID); err != nil {
		return err
	}
	s.notifyOrderUpdated(orderID)
	return nil
}

// ReplaceTradeImage saves a rotated or flipped version of a picture that
// belongs to the order (a product picture or an inspection photo).
func (s *TradeService) ReplaceTradeImage(userID, orderID, attachmentID int64, file multipart.File, header *multipart.FileHeader) error {
	rights, err := s.tradeImageRights(userID, orderID)
	if err != nil {
		return err
	}
	source, uploadedBy, err := s.repo.TradeImageSource(orderID, attachmentID)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("图片不属于当前业务单")
	}
	if err != nil {
		return err
	}
	allowed := rights.CanManageItemImages
	if source == "inspection" {
		allowed = rights.CanManageInspectionPhotos || uploadedBy == userID
	}
	if !allowed {
		return fmt.Errorf("当前账号不能修改这张图片")
	}
	if _, err := s.uploadSvc.ReplaceImageContent(attachmentID, file, header); err != nil {
		return err
	}
	s.notifyOrderUpdated(orderID)
	return nil
}
