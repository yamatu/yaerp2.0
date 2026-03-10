package service

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	miniopkg "yaerp/pkg/minio"
)

type UploadService struct {
	minioClient    *miniopkg.Client
	attachmentRepo *repo.AttachmentRepo
	fileURLSecret  string
}

var ErrInvalidFileSignature = errors.New("invalid file signature")

func NewUploadService(minioClient *miniopkg.Client, attachmentRepo *repo.AttachmentRepo, fileURLSecret string) *UploadService {
	return &UploadService{
		minioClient:    minioClient,
		attachmentRepo: attachmentRepo,
		fileURLSecret:  fileURLSecret,
	}
}

func (s *UploadService) Upload(file multipart.File, header *multipart.FileHeader, userID int64) (*model.Attachment, error) {
	ext := filepath.Ext(header.Filename)
	objectKey := fmt.Sprintf("uploads/%d/%d%s", userID, time.Now().UnixNano(), ext)
	contentType := header.Header.Get("Content-Type")

	ctx := context.Background()
	if err := s.minioClient.Upload(ctx, objectKey, file, header.Size, contentType); err != nil {
		return nil, fmt.Errorf("failed to upload file: %w", err)
	}

	attachment := &model.Attachment{
		Filename:   header.Filename,
		MimeType:   contentType,
		Size:       header.Size,
		Bucket:     "yaerp",
		ObjectKey:  objectKey,
		UploaderID: userID,
	}

	if err := s.attachmentRepo.Create(attachment); err != nil {
		_ = s.minioClient.Delete(ctx, objectKey)
		return nil, fmt.Errorf("failed to save attachment: %w", err)
	}

	return attachment, nil
}

func (s *UploadService) GetFileURL(attachmentID int64) (string, error) {
	if _, err := s.attachmentRepo.GetByID(attachmentID); err != nil {
		return "", fmt.Errorf("attachment not found: %w", err)
	}

	return s.buildFileAccessURL(attachmentID), nil
}

type AttachmentWithURL struct {
	model.Attachment
	URL string `json:"url"`
}

func (s *UploadService) ListImages(page, size int) ([]*AttachmentWithURL, int64, error) {
	list, total, err := s.attachmentRepo.ListByMimePrefix("image/", page, size)
	if err != nil {
		return nil, 0, err
	}

	result := make([]*AttachmentWithURL, 0, len(list))
	for _, a := range list {
		result = append(result, &AttachmentWithURL{Attachment: *a, URL: s.buildFileAccessURL(a.ID)})
	}
	return result, total, nil
}

func (s *UploadService) DeleteFile(id int64) error {
	a, err := s.attachmentRepo.Delete(id)
	if err != nil {
		return fmt.Errorf("attachment not found: %w", err)
	}
	ctx := context.Background()
	_ = s.minioClient.Delete(ctx, a.ObjectKey)
	return nil
}

func (s *UploadService) OpenFile(attachmentID int64, signature string) (*model.Attachment, io.ReadCloser, error) {
	if !s.isValidSignature(attachmentID, signature) {
		return nil, nil, ErrInvalidFileSignature
	}

	attachment, err := s.attachmentRepo.GetByID(attachmentID)
	if err != nil {
		return nil, nil, fmt.Errorf("attachment not found: %w", err)
	}

	reader, err := s.minioClient.GetObject(context.Background(), attachment.ObjectKey)
	if err != nil {
		return nil, nil, fmt.Errorf("failed to open attachment: %w", err)
	}

	return attachment, reader, nil
}

func (s *UploadService) buildFileAccessURL(attachmentID int64) string {
	return fmt.Sprintf("/api/files/%d/content?signature=%s", attachmentID, s.signAttachmentID(attachmentID))
}

func (s *UploadService) signAttachmentID(attachmentID int64) string {
	mac := hmac.New(sha256.New, []byte(s.fileURLSecret))
	_, _ = mac.Write([]byte(fmt.Sprintf("attachment:%d", attachmentID)))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *UploadService) isValidSignature(attachmentID int64, signature string) bool {
	expected := s.signAttachmentID(attachmentID)
	return subtle.ConstantTimeCompare([]byte(expected), []byte(signature)) == 1
}
