package service

import (
	"bytes"
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
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	miniopkg "yaerp/pkg/minio"
)

type UploadService struct {
	minioClient    *miniopkg.Client
	attachmentRepo *repo.AttachmentRepo
	channelRepo    *repo.ChannelRepo
	fileURLSecret  string
}

var ErrInvalidFileSignature = errors.New("invalid file signature")

func NewUploadService(minioClient *miniopkg.Client, attachmentRepo *repo.AttachmentRepo, channelRepo *repo.ChannelRepo, fileURLSecret string) *UploadService {
	return &UploadService{
		minioClient:    minioClient,
		attachmentRepo: attachmentRepo,
		channelRepo:    channelRepo,
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

func (s *UploadService) UploadBytes(filename, contentType string, data []byte, userID int64) (*model.Attachment, string, error) {
	objectKey := fmt.Sprintf("uploads/%d/%d%s", userID, time.Now().UnixNano(), filepath.Ext(filename))
	reader := bytes.NewReader(data)

	ctx := context.Background()
	if err := s.minioClient.Upload(ctx, objectKey, reader, int64(len(data)), contentType); err != nil {
		return nil, "", fmt.Errorf("failed to upload generated file: %w", err)
	}

	attachment := &model.Attachment{
		Filename:   filename,
		MimeType:   contentType,
		Size:       int64(len(data)),
		Bucket:     "yaerp",
		ObjectKey:  objectKey,
		UploaderID: userID,
	}

	if err := s.attachmentRepo.Create(attachment); err != nil {
		_ = s.minioClient.Delete(ctx, objectKey)
		return nil, "", fmt.Errorf("failed to save generated attachment: %w", err)
	}

	return attachment, s.buildFileAccessURL(attachment.ID), nil
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

func (s *UploadService) GetAttachment(id int64) (*model.Attachment, error) {
	return s.attachmentRepo.GetByID(id)
}

func (s *UploadService) RenameAttachment(id int64, filename string) (*AttachmentWithURL, error) {
	if err := s.attachmentRepo.UpdateFilename(id, filename); err != nil {
		return nil, err
	}
	attachment, err := s.attachmentRepo.GetByID(id)
	if err != nil {
		return nil, err
	}
	return &AttachmentWithURL{Attachment: *attachment, URL: s.buildFileAccessURL(id)}, nil
}

func (s *UploadService) ListImages(userID int64, page, size int) ([]*AttachmentWithURL, int64, error) {
	return s.ListImagesFiltered(userID, page, size, nil, nil)
}

func (s *UploadService) ListImagesFiltered(userID int64, page, size int, directoryID *int64, channelID *int64) ([]*AttachmentWithURL, int64, error) {
	list, total, err := s.attachmentRepo.ListAccessibleByMimePrefixFiltered("image/", page, size, userID, directoryID, channelID)
	if err != nil {
		return nil, 0, err
	}

	result := make([]*AttachmentWithURL, 0, len(list))
	for _, a := range list {
		result = append(result, &AttachmentWithURL{Attachment: *a, URL: s.buildFileAccessURL(a.ID)})
	}
	return result, total, nil
}

func (s *UploadService) CreateGalleryDirectory(userID int64, name string, channelID *int64, visibility *string) (*model.GalleryDirectory, error) {
	if s.channelRepo == nil {
		return nil, fmt.Errorf("gallery directory service is unavailable")
	}
	directoryVisibility := "private"
	if channelID != nil {
		allowed, err := s.channelRepo.IsChannelMember(*channelID, userID)
		if err != nil {
			return nil, err
		}
		if !allowed {
			return nil, fmt.Errorf("channel access denied")
		}
		directoryVisibility = "channel"
	}
	if visibility != nil && strings.TrimSpace(*visibility) != "" {
		directoryVisibility = strings.ToLower(strings.TrimSpace(*visibility))
	}
	if !isValidGalleryVisibility(directoryVisibility) {
		return nil, fmt.Errorf("invalid gallery visibility")
	}
	directory := &model.GalleryDirectory{Name: strings.TrimSpace(name), OwnerID: userID, ChannelID: channelID, Visibility: directoryVisibility, CanManage: true, CanEdit: true}
	if directory.Name == "" {
		return nil, fmt.Errorf("directory name is required")
	}
	if err := s.channelRepo.CreateGalleryDirectory(directory); err != nil {
		return nil, err
	}
	return directory, nil
}

func (s *UploadService) ListGalleryDirectories(userID int64, channelID *int64) ([]model.GalleryDirectory, error) {
	if s.channelRepo == nil {
		return nil, fmt.Errorf("gallery directory service is unavailable")
	}
	return s.channelRepo.ListGalleryDirectories(userID, channelID)
}

func (s *UploadService) SaveImageToGallery(attachmentID int64, directoryID *int64, channelID *int64, savedBy int64) error {
	if s.channelRepo == nil {
		return nil
	}
	if channelID != nil {
		allowed, err := s.channelRepo.IsChannelMember(*channelID, savedBy)
		if err != nil {
			return err
		}
		if !allowed {
			return fmt.Errorf("channel access denied")
		}
	}
	if directoryID != nil {
		directory, err := s.channelRepo.GetGalleryDirectory(*directoryID)
		if err != nil {
			return fmt.Errorf("gallery directory not found: %w", err)
		}
		canEdit, err := s.channelRepo.CanEditGalleryDirectory(*directoryID, savedBy)
		if err != nil {
			return err
		}
		if !canEdit {
			return fmt.Errorf("gallery directory access denied")
		}
		if directory.ChannelID != nil && channelID != nil && *directory.ChannelID != *channelID {
			return fmt.Errorf("gallery directory does not belong to selected channel")
		}
	}
	return s.channelRepo.SaveGalleryImage(attachmentID, directoryID, channelID, savedBy)
}

func (s *UploadService) CanAccessGalleryImage(userID, attachmentID int64) (bool, error) {
	if s.channelRepo == nil {
		return false, nil
	}
	return s.channelRepo.CanAccessGalleryImage(attachmentID, userID)
}

func (s *UploadService) GetGalleryDirectoryAccess(userID, directoryID int64) (*model.GalleryDirectoryAccess, error) {
	if s.channelRepo == nil {
		return nil, fmt.Errorf("gallery directory service is unavailable")
	}
	allowed, err := s.channelRepo.CanManageGalleryDirectory(directoryID, userID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("gallery directory manage denied")
	}
	return s.channelRepo.GetGalleryDirectoryAccess(directoryID)
}

func (s *UploadService) UpdateGalleryDirectoryAccess(userID, directoryID int64, req *model.GalleryDirectoryAccessRequest) (*model.GalleryDirectoryAccess, error) {
	if s.channelRepo == nil {
		return nil, fmt.Errorf("gallery directory service is unavailable")
	}
	visibility := strings.ToLower(strings.TrimSpace(req.Visibility))
	if !isValidGalleryVisibility(visibility) {
		return nil, fmt.Errorf("invalid gallery visibility")
	}
	allowed, err := s.channelRepo.CanManageGalleryDirectory(directoryID, userID)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, fmt.Errorf("gallery directory manage denied")
	}
	if err := s.channelRepo.UpdateGalleryDirectoryAccess(directoryID, visibility, req.ViewUserIDs, req.EditUserIDs); err != nil {
		return nil, err
	}
	return s.channelRepo.GetGalleryDirectoryAccess(directoryID)
}

func isValidGalleryVisibility(value string) bool {
	return value == "private" || value == "channel" || value == "public"
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

	return s.OpenStoredFile(attachmentID)
}

func (s *UploadService) OpenStoredFile(attachmentID int64) (*model.Attachment, io.ReadCloser, error) {
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
