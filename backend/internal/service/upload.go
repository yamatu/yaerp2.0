package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
	miniopkg "yaerp/pkg/minio"

	"github.com/disintegration/imaging"
	_ "golang.org/x/image/webp"
)

type UploadService struct {
	minioClient    *miniopkg.Client
	attachmentRepo *repo.AttachmentRepo
	channelRepo    *repo.ChannelRepo
	fileURLSecret  string
}

var (
	ErrInvalidFileSignature       = errors.New("invalid file signature")
	ErrGalleryImageMoveDenied     = errors.New("没有权限移动选中的图库图片")
	ErrGalleryDirectoryEditDenied = errors.New("没有目标图库目录的编辑权限")
)

const maxReplacementImageBytes int64 = 40 << 20

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
	hasher := sha256.New()
	reader := io.TeeReader(file, hasher)

	ctx := context.Background()
	if err := s.minioClient.Upload(ctx, objectKey, reader, header.Size, contentType); err != nil {
		return nil, fmt.Errorf("failed to upload file: %w", err)
	}

	attachment := &model.Attachment{
		Filename:    header.Filename,
		MimeType:    contentType,
		Size:        header.Size,
		Bucket:      "yaerp",
		ObjectKey:   objectKey,
		ContentHash: hex.EncodeToString(hasher.Sum(nil)),
		UploaderID:  userID,
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
	contentHash := sha256.Sum256(data)

	ctx := context.Background()
	if err := s.minioClient.Upload(ctx, objectKey, reader, int64(len(data)), contentType); err != nil {
		return nil, "", fmt.Errorf("failed to upload generated file: %w", err)
	}

	attachment := &model.Attachment{
		Filename:    filename,
		MimeType:    contentType,
		Size:        int64(len(data)),
		Bucket:      "yaerp",
		ObjectKey:   objectKey,
		ContentHash: hex.EncodeToString(contentHash[:]),
		UploaderID:  userID,
	}

	if err := s.attachmentRepo.Create(attachment); err != nil {
		_ = s.minioClient.Delete(ctx, objectKey)
		return nil, "", fmt.Errorf("failed to save generated attachment: %w", err)
	}

	return attachment, s.attachmentAccessURL(attachment), nil
}

func (s *UploadService) GetFileURL(attachmentID int64) (string, error) {
	attachment, err := s.attachmentRepo.GetByID(attachmentID)
	if err != nil {
		return "", fmt.Errorf("attachment not found: %w", err)
	}

	return s.attachmentAccessURL(attachment), nil
}

type AttachmentWithURL struct {
	model.Attachment
	URL          string `json:"url"`
	ThumbnailURL string `json:"thumbnail_url,omitempty"`
	CanManage    bool   `json:"can_manage"`
}

func (s *UploadService) GetAttachment(id int64) (*model.Attachment, error) {
	return s.attachmentRepo.GetByID(id)
}

func (s *UploadService) GetThumbnailURL(id int64, size int) string {
	attachment, err := s.attachmentRepo.GetByID(id)
	if err != nil {
		return ""
	}
	if size <= 0 {
		size = 320
	}
	return s.thumbnailAccessURL(attachment, size)
}

func (s *UploadService) RenameAttachment(id int64, filename string) (*AttachmentWithURL, error) {
	if err := s.attachmentRepo.UpdateFilename(id, filename); err != nil {
		return nil, err
	}
	attachment, err := s.attachmentRepo.GetByID(id)
	if err != nil {
		return nil, err
	}
	return s.attachmentWithURLs(attachment), nil
}

func (s *UploadService) ReplaceImageContent(id int64, file multipart.File, header *multipart.FileHeader) (*AttachmentWithURL, error) {
	attachment, err := s.attachmentRepo.GetByID(id)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		return nil, fmt.Errorf("attachment is not an image")
	}

	data, err := io.ReadAll(io.LimitReader(file, maxReplacementImageBytes+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read replacement image: %w", err)
	}
	if int64(len(data)) > maxReplacementImageBytes {
		return nil, fmt.Errorf("图片不能超过 40MB")
	}
	if len(data) == 0 {
		return nil, fmt.Errorf("图片内容不能为空")
	}

	contentType := http.DetectContentType(data)
	if !isSupportedReplacementImageType(contentType) {
		return nil, fmt.Errorf("仅支持 JPEG、PNG、WebP 或 GIF 图片")
	}
	filename := normalizedReplacementImageFilename(header.Filename, attachment.Filename, contentType)
	contentHash := sha256.Sum256(data)
	objectKey := fmt.Sprintf("uploads/%d/%d%s", attachment.UploaderID, time.Now().UnixNano(), filepath.Ext(filename))
	ctx := context.Background()
	if err := s.minioClient.Upload(ctx, objectKey, bytes.NewReader(data), int64(len(data)), contentType); err != nil {
		return nil, fmt.Errorf("failed to upload replacement image: %w", err)
	}

	hashValue := hex.EncodeToString(contentHash[:])
	if err := s.attachmentRepo.ReplaceContent(attachment.ID, filename, contentType, int64(len(data)), objectKey, hashValue); err != nil {
		_ = s.minioClient.Delete(ctx, objectKey)
		return nil, fmt.Errorf("failed to save replacement image: %w", err)
	}
	_ = s.minioClient.Delete(ctx, attachment.ObjectKey)

	updated, err := s.attachmentRepo.GetByID(attachment.ID)
	if err != nil {
		return nil, err
	}
	s.purgeAttachmentThumbnails(updated.ID)
	return s.attachmentWithURLs(updated), nil
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
	allManageable := false
	if s.channelRepo != nil && len(list) > 0 {
		attachmentIDs := make([]int64, 0, len(list))
		for _, attachment := range list {
			attachmentIDs = append(attachmentIDs, attachment.ID)
		}
		if count, countErr := s.channelRepo.CountManageableGalleryImages(attachmentIDs, userID); countErr == nil {
			allManageable = count == int64(len(list))
		}
	}
	for _, a := range list {
		item := s.attachmentWithURLs(a)
		item.CanManage = allManageable
		if s.channelRepo != nil && !allManageable {
			item.CanManage, _ = s.channelRepo.CanManageGalleryImage(a.ID, userID)
		}
		result = append(result, item)
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

func (s *UploadService) DeleteGalleryDirectory(directoryID int64) error {
	if s.channelRepo == nil {
		return fmt.Errorf("gallery directory service is unavailable")
	}
	if err := s.channelRepo.DeleteGalleryDirectory(directoryID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return fmt.Errorf("图库目录不存在")
		}
		return err
	}
	return nil
}

func normalizeGalleryMoveAttachmentIDs(input []int64) ([]int64, error) {
	if len(input) == 0 {
		return nil, fmt.Errorf("请至少选择一张图片")
	}
	if len(input) > 5000 {
		return nil, fmt.Errorf("单次最多移动 5000 张图片")
	}
	seen := make(map[int64]struct{}, len(input))
	ids := make([]int64, 0, len(input))
	for _, id := range input {
		if id <= 0 {
			return nil, fmt.Errorf("图片 ID 无效")
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	return ids, nil
}

func (s *UploadService) MoveGalleryImages(userID int64, req *model.GalleryImagesMoveRequest) (*model.GalleryImagesMoveResult, error) {
	if s.channelRepo == nil {
		return nil, fmt.Errorf("gallery directory service is unavailable")
	}
	if req == nil || req.DirectoryID <= 0 {
		return nil, fmt.Errorf("请选择目标图库目录")
	}
	attachmentIDs, err := normalizeGalleryMoveAttachmentIDs(req.AttachmentIDs)
	if err != nil {
		return nil, err
	}
	directory, err := s.channelRepo.GetGalleryDirectory(req.DirectoryID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("目标图库目录不存在")
		}
		return nil, err
	}
	canEdit, err := s.channelRepo.CanEditGalleryDirectory(directory.ID, userID)
	if err != nil {
		return nil, err
	}
	if !canEdit {
		return nil, ErrGalleryDirectoryEditDenied
	}
	manageableCount, err := s.channelRepo.CountManageableGalleryImages(attachmentIDs, userID)
	if err != nil {
		return nil, err
	}
	if manageableCount != int64(len(attachmentIDs)) {
		return nil, ErrGalleryImageMoveDenied
	}
	movedCount, duplicatesRemoved, err := s.channelRepo.MoveGalleryImages(attachmentIDs, directory.ID, userID)
	if err != nil {
		return nil, err
	}
	return &model.GalleryImagesMoveResult{
		DirectoryID:       directory.ID,
		MovedCount:        movedCount,
		DuplicatesRemoved: duplicatesRemoved,
	}, nil
}

func (s *UploadService) SaveImageToGallery(attachmentID int64, directoryID *int64, channelID *int64, savedBy int64) error {
	_, _, err := s.SaveImageToGalleryDeduplicated(attachmentID, directoryID, channelID, savedBy)
	return err
}

func (s *UploadService) SaveImageToGalleryDeduplicated(attachmentID int64, directoryID *int64, channelID *int64, savedBy int64) (int64, bool, error) {
	if s.channelRepo == nil {
		return attachmentID, false, nil
	}
	if channelID != nil {
		allowed, err := s.channelRepo.IsChannelMember(*channelID, savedBy)
		if err != nil {
			return 0, false, err
		}
		if !allowed {
			return 0, false, fmt.Errorf("channel access denied")
		}
	}
	if directoryID != nil {
		directory, err := s.channelRepo.GetGalleryDirectory(*directoryID)
		if err != nil {
			return 0, false, fmt.Errorf("gallery directory not found: %w", err)
		}
		canEdit, err := s.channelRepo.CanEditGalleryDirectory(*directoryID, savedBy)
		if err != nil {
			return 0, false, err
		}
		if !canEdit {
			return 0, false, fmt.Errorf("gallery directory access denied")
		}
		if directory.ChannelID != nil && channelID != nil && *directory.ChannelID != *channelID {
			return 0, false, fmt.Errorf("gallery directory does not belong to selected channel")
		}
	}
	attachment, err := s.ensureContentHash(attachmentID)
	if err != nil {
		return 0, false, err
	}
	return s.channelRepo.SaveGalleryImage(attachmentID, directoryID, channelID, savedBy, attachment.ContentHash)
}

func (s *UploadService) BackfillGalleryContentHashes() (int, int64, error) {
	attachments, err := s.attachmentRepo.ListGalleryAttachmentsMissingHash()
	if err != nil {
		return 0, 0, err
	}
	updated := 0
	var firstErr error
	for _, attachment := range attachments {
		if _, err := s.ensureContentHash(attachment.ID); err != nil {
			if firstErr == nil {
				firstErr = fmt.Errorf("hash gallery attachment %d: %w", attachment.ID, err)
			}
			continue
		}
		updated++
	}
	removed, err := s.channelRepo.DeleteDuplicateGalleryImages()
	if err != nil && firstErr == nil {
		firstErr = err
	}
	return updated, removed, firstErr
}

func (s *UploadService) ensureContentHash(attachmentID int64) (*model.Attachment, error) {
	attachment, err := s.attachmentRepo.GetByID(attachmentID)
	if err != nil {
		return nil, err
	}
	if attachment.ContentHash != "" {
		return attachment, nil
	}
	data, err := s.minioClient.GetObjectBytes(context.Background(), attachment.ObjectKey)
	if err != nil {
		return nil, fmt.Errorf("failed to hash attachment: %w", err)
	}
	sum := sha256.Sum256(data)
	attachment.ContentHash = hex.EncodeToString(sum[:])
	if err := s.attachmentRepo.UpdateContentHash(attachment.ID, attachment.ContentHash); err != nil {
		return nil, err
	}
	return attachment, nil
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
	s.purgeAttachmentThumbnails(id)
	return nil
}

func (s *UploadService) OpenThumbnail(attachmentID int64, signature string, requestedSize int) ([]byte, string, error) {
	if !s.isValidSignature(attachmentID, signature) {
		return nil, "", ErrInvalidFileSignature
	}
	attachment, err := s.ensureContentHash(attachmentID)
	if err != nil {
		return nil, "", err
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		return nil, "", fmt.Errorf("attachment is not an image")
	}
	size := normalizeThumbnailSize(requestedSize)
	objectKey := thumbnailObjectKey(attachment, size)
	ctx := context.Background()
	if cached, cachedErr := s.minioClient.GetObjectBytes(ctx, objectKey); cachedErr == nil && len(cached) > 0 {
		return cached, "image/jpeg", nil
	}

	original, err := s.minioClient.GetObjectBytes(ctx, attachment.ObjectKey)
	if err != nil {
		return nil, "", fmt.Errorf("failed to read thumbnail source: %w", err)
	}
	thumbnail, err := buildCompressedThumbnail(original, size)
	if err != nil {
		// Keep uncommon browser-supported formats usable even when the Go image
		// decoder cannot resize them (for example HEIC on Safari).
		return original, attachment.MimeType, nil
	}
	if err := s.minioClient.Upload(ctx, objectKey, bytes.NewReader(thumbnail), int64(len(thumbnail)), "image/jpeg"); err != nil {
		return thumbnail, "image/jpeg", nil
	}
	return thumbnail, "image/jpeg", nil
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

func (s *UploadService) attachmentAccessURL(attachment *model.Attachment) string {
	url := s.buildFileAccessURL(attachment.ID)
	if attachment.ContentHash == "" {
		return url
	}
	version := attachment.ContentHash
	if len(version) > 16 {
		version = version[:16]
	}
	return url + "&v=" + version
}

func (s *UploadService) attachmentWithURLs(attachment *model.Attachment) *AttachmentWithURL {
	return &AttachmentWithURL{
		Attachment:   *attachment,
		URL:          s.attachmentAccessURL(attachment),
		ThumbnailURL: s.thumbnailAccessURL(attachment, 320),
	}
}

func (s *UploadService) thumbnailAccessURL(attachment *model.Attachment, size int) string {
	url := fmt.Sprintf(
		"/api/files/%d/thumbnail?signature=%s&size=%d",
		attachment.ID,
		s.signAttachmentID(attachment.ID),
		normalizeThumbnailSize(size),
	)
	if attachment.ContentHash == "" {
		return url
	}
	version := attachment.ContentHash
	if len(version) > 16 {
		version = version[:16]
	}
	return url + "&v=" + version
}

func normalizeThumbnailSize(size int) int {
	switch {
	case size <= 160:
		return 160
	case size <= 320:
		return 320
	case size <= 640:
		return 640
	default:
		return 960
	}
}

func thumbnailObjectKey(attachment *model.Attachment, size int) string {
	version := attachment.ContentHash
	if len(version) > 20 {
		version = version[:20]
	}
	if version == "" {
		version = "unversioned"
	}
	return fmt.Sprintf("thumbnails/%d/%s-%d.jpg", attachment.ID, version, normalizeThumbnailSize(size))
}

func buildCompressedThumbnail(data []byte, size int) ([]byte, error) {
	source, err := imaging.Decode(bytes.NewReader(data), imaging.AutoOrientation(true))
	if err != nil {
		return nil, err
	}
	thumbnail := imaging.Fit(source, normalizeThumbnailSize(size), normalizeThumbnailSize(size), imaging.Lanczos)
	background := imaging.New(thumbnail.Bounds().Dx(), thumbnail.Bounds().Dy(), color.NRGBA{R: 255, G: 255, B: 255, A: 255})
	thumbnail = imaging.Overlay(background, thumbnail, image.Pt(0, 0), 1)
	var buffer bytes.Buffer
	if err := imaging.Encode(&buffer, thumbnail, imaging.JPEG, imaging.JPEGQuality(76)); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func (s *UploadService) purgeAttachmentThumbnails(attachmentID int64) {
	ctx := context.Background()
	keys, err := s.minioClient.ListObjectKeys(ctx, fmt.Sprintf("thumbnails/%d/", attachmentID))
	if err != nil {
		return
	}
	for _, key := range keys {
		_ = s.minioClient.Delete(ctx, key)
	}
}

func isSupportedReplacementImageType(contentType string) bool {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg", "image/png", "image/webp", "image/gif":
		return true
	default:
		return false
	}
}

func normalizedReplacementImageFilename(candidate, fallback, contentType string) string {
	filename := filepath.Base(strings.ReplaceAll(strings.TrimSpace(candidate), `\`, "/"))
	if filename == "" || filename == "." {
		filename = filepath.Base(strings.ReplaceAll(strings.TrimSpace(fallback), `\`, "/"))
	}
	base := strings.TrimSuffix(filename, filepath.Ext(filename))
	if base == "" || base == "." {
		base = "image"
	}
	extension := replacementImageExtension(contentType)
	currentExtension := strings.ToLower(filepath.Ext(filename))
	if replacementImageExtensionMatches(currentExtension, contentType) {
		extension = currentExtension
	}
	return base + extension
}

func replacementImageExtension(contentType string) string {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg":
		return ".jpg"
	case "image/webp":
		return ".webp"
	case "image/gif":
		return ".gif"
	default:
		return ".png"
	}
}

func replacementImageExtensionMatches(extension, contentType string) bool {
	switch strings.ToLower(strings.TrimSpace(contentType)) {
	case "image/jpeg":
		return extension == ".jpg" || extension == ".jpeg"
	case "image/png":
		return extension == ".png"
	case "image/webp":
		return extension == ".webp"
	case "image/gif":
		return extension == ".gif"
	default:
		return false
	}
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
