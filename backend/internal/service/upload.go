package service

import (
	"context"
	"fmt"
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
}

func NewUploadService(minioClient *miniopkg.Client, attachmentRepo *repo.AttachmentRepo) *UploadService {
	return &UploadService{
		minioClient:    minioClient,
		attachmentRepo: attachmentRepo,
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
	attachment, err := s.attachmentRepo.GetByID(attachmentID)
	if err != nil {
		return "", fmt.Errorf("attachment not found: %w", err)
	}

	ctx := context.Background()
	url, err := s.minioClient.GetPresignedURL(ctx, attachment.ObjectKey, time.Hour)
	if err != nil {
		return "", fmt.Errorf("failed to generate URL: %w", err)
	}

	return url, nil
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

	ctx := context.Background()
	result := make([]*AttachmentWithURL, 0, len(list))
	for _, a := range list {
		url, _ := s.minioClient.GetPresignedURL(ctx, a.ObjectKey, time.Hour)
		result = append(result, &AttachmentWithURL{Attachment: *a, URL: url})
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
