package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"yaerp/internal/model"
)

const (
	channelBackupVersion       = 1
	channelBackupMaxMessages   = 10000
	channelBackupMaxFileBytes  = 25 << 20
	channelBackupMaxTotalBytes = 100 << 20
)

type channelBackupSnapshot struct {
	Version   int                       `json:"version"`
	Channel   channelBackupChannel      `json:"channel"`
	CreatedAt time.Time                 `json:"created_at"`
	Messages  []channelBackupMessage    `json:"messages"`
	Files     []channelBackupAttachment `json:"files"`
}

type channelBackupChannel struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

type channelBackupMessage struct {
	OriginalID int64 `json:"original_id"`
	model.ChannelMessage
}

type channelBackupAttachment struct {
	OriginalID int64  `json:"original_id"`
	Filename   string `json:"filename"`
	MimeType   string `json:"mime_type"`
	Data       string `json:"data"`
}

func (s *ChannelService) CreateBackup(userID, channelID int64) (*model.ChannelBackup, error) {
	channel, err := s.requireChannelManage(userID, channelID)
	if err != nil {
		return nil, err
	}
	messages, err := s.channelRepo.ListAllMessages(channelID)
	if err != nil {
		return nil, err
	}
	if len(messages) > channelBackupMaxMessages {
		return nil, fmt.Errorf("单次最多备份 %d 条频道消息", channelBackupMaxMessages)
	}

	snapshot := channelBackupSnapshot{
		Version:   channelBackupVersion,
		Channel:   channelBackupChannel{ID: channel.ID, Name: channel.Name},
		CreatedAt: time.Now(),
		Messages:  make([]channelBackupMessage, 0, len(messages)),
		Files:     make([]channelBackupAttachment, 0),
	}
	if channel.Description != nil {
		snapshot.Channel.Description = *channel.Description
	}
	seenAttachments := make(map[int64]struct{})
	totalFileBytes := 0
	for _, message := range messages {
		message.AttachmentURL = ""
		snapshot.Messages = append(snapshot.Messages, channelBackupMessage{OriginalID: message.ID, ChannelMessage: message})
		if message.AttachmentID == nil {
			continue
		}
		attachmentID := *message.AttachmentID
		if _, exists := seenAttachments[attachmentID]; exists {
			continue
		}
		seenAttachments[attachmentID] = struct{}{}
		attachment, reader, openErr := s.uploadSvc.OpenStoredFile(attachmentID)
		if openErr != nil {
			return nil, fmt.Errorf("读取附件 %d 失败: %w", attachmentID, openErr)
		}
		data, readErr := io.ReadAll(io.LimitReader(reader, channelBackupMaxFileBytes+1))
		_ = reader.Close()
		if readErr != nil {
			return nil, readErr
		}
		if len(data) > channelBackupMaxFileBytes {
			return nil, fmt.Errorf("附件 %s 超过 25MB，无法加入频道备份", attachment.Filename)
		}
		totalFileBytes += len(data)
		if totalFileBytes > channelBackupMaxTotalBytes {
			return nil, fmt.Errorf("频道附件总量超过 100MB，请分批备份")
		}
		snapshot.Files = append(snapshot.Files, channelBackupAttachment{
			OriginalID: attachmentID,
			Filename:   attachment.Filename,
			MimeType:   attachment.MimeType,
			Data:       base64.StdEncoding.EncodeToString(data),
		})
	}

	data, err := json.Marshal(snapshot)
	if err != nil {
		return nil, err
	}
	if _, err := validateChannelBackupSnapshot(&snapshot); err != nil {
		return nil, fmt.Errorf("备份校验失败: %w", err)
	}
	checksumBytes := sha256.Sum256(data)
	checksum := hex.EncodeToString(checksumBytes[:])
	verifiedAt := time.Now()
	filename := fmt.Sprintf("%s-%s.yaerp-channel-backup.json", sanitizeBackupFilename(channel.Name), time.Now().Format("20060102-150405"))
	attachment, _, err := s.uploadSvc.UploadBytes(filename, "application/json", data, userID)
	if err != nil {
		return nil, err
	}
	backup := &model.ChannelBackup{
		SourceChannelID: &channelID, SourceChannelName: channel.Name, CreatedBy: &userID,
		Filename: filename, AttachmentID: attachment.ID, MessageCount: len(messages), Size: int64(len(data)),
		Checksum: checksum, SnapshotVersion: channelBackupVersion, VerifiedAt: &verifiedAt,
	}
	if err := s.channelRepo.CreateBackup(backup); err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	created, err := s.channelRepo.GetBackup(backup.ID)
	if err != nil {
		return nil, err
	}
	created.DownloadURL, _ = s.uploadSvc.GetFileURL(attachment.ID)
	return created, nil
}

func (s *ChannelService) ListBackups(userID int64) ([]model.ChannelBackup, error) {
	isAdmin, err := s.permSvc.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	backups, err := s.channelRepo.ListBackups(userID, isAdmin)
	if err != nil {
		return nil, err
	}
	for index := range backups {
		backups[index].DownloadURL, _ = s.uploadSvc.GetFileURL(backups[index].AttachmentID)
	}
	return backups, nil
}

func (s *ChannelService) ListBackupRestores(userID, backupID int64) ([]model.ChannelBackupRestore, error) {
	if _, err := s.accessibleBackup(userID, backupID); err != nil {
		return nil, err
	}
	return s.channelRepo.ListBackupRestores(backupID)
}

func (s *ChannelService) RestoreBackup(userID, targetChannelID, backupID int64) (*model.ChannelBackupRestore, error) {
	targetChannel, err := s.requireChannelManage(userID, targetChannelID)
	if err != nil {
		return nil, err
	}
	backup, err := s.accessibleBackup(userID, backupID)
	if err != nil {
		return nil, err
	}
	_, reader, err := s.uploadSvc.OpenStoredFile(backup.AttachmentID)
	if err != nil {
		return nil, err
	}
	data, readErr := io.ReadAll(io.LimitReader(reader, (channelBackupMaxTotalBytes*2)+1))
	_ = reader.Close()
	if readErr != nil {
		return nil, readErr
	}
	if len(data) > channelBackupMaxTotalBytes*2 {
		return nil, fmt.Errorf("备份文件过大")
	}
	var snapshot channelBackupSnapshot
	if err := json.Unmarshal(data, &snapshot); err != nil {
		return nil, fmt.Errorf("备份文件格式无效: %w", err)
	}
	if snapshot.Version != channelBackupVersion {
		return nil, fmt.Errorf("不支持的频道备份版本: %d", snapshot.Version)
	}
	if len(snapshot.Messages) > channelBackupMaxMessages {
		return nil, fmt.Errorf("备份消息数量超过限制")
	}
	decodedFiles, err := validateChannelBackupSnapshot(&snapshot)
	if err != nil {
		return nil, fmt.Errorf("备份内容校验失败: %w", err)
	}
	checksumBytes := sha256.Sum256(data)
	checksum := hex.EncodeToString(checksumBytes[:])
	if strings.TrimSpace(backup.Checksum) != "" && !strings.EqualFold(strings.TrimSpace(backup.Checksum), checksum) {
		return nil, fmt.Errorf("备份文件完整性校验失败，文件可能已损坏或被修改")
	}
	if err := s.channelRepo.MarkBackupVerified(backupID, checksum, snapshot.Version); err != nil {
		return nil, fmt.Errorf("记录备份校验状态失败: %w", err)
	}

	attachmentMap := make(map[int64]int64, len(snapshot.Files))
	uploadedAttachmentIDs := make([]int64, 0, len(snapshot.Files))
	cleanupUploads := true
	defer func() {
		if !cleanupUploads {
			return
		}
		for _, attachmentID := range uploadedAttachmentIDs {
			_ = s.uploadSvc.DeleteFile(attachmentID)
		}
	}()
	for _, file := range snapshot.Files {
		decoded := decodedFiles[file.OriginalID]
		attachment, _, err := s.uploadSvc.UploadBytes(file.Filename, file.MimeType, decoded, userID)
		if err != nil {
			return nil, err
		}
		attachmentMap[file.OriginalID] = attachment.ID
		uploadedAttachmentIDs = append(uploadedAttachmentIDs, attachment.ID)
	}

	restoreItems := make([]model.ChannelRestoreMessage, 0, len(snapshot.Messages))
	for _, item := range snapshot.Messages {
		message := item.ChannelMessage
		originalReplyToMessageID := message.ReplyToMessageID
		originalForwardedMessageID := message.ForwardedFromMessageID
		message.ID = 0
		message.ChannelID = targetChannelID
		message.ExternalAccountID = nil
		message.ExternalMessageID = nil
		message.RecalledBy = nil
		if message.AttachmentID != nil {
			if restoredID, ok := attachmentMap[*message.AttachmentID]; ok {
				message.AttachmentID = &restoredID
			} else {
				message.AttachmentID = nil
			}
		}
		message.ReplyToMessageID = nil
		message.ForwardedFromMessageID = nil
		if message.CreatedAt.IsZero() {
			message.CreatedAt = time.Now()
		}
		restoreItems = append(restoreItems, model.ChannelRestoreMessage{
			OriginalID: item.OriginalID, OriginalReplyToMessageID: originalReplyToMessageID,
			OriginalForwardedMessageID: originalForwardedMessageID, Message: message,
		})
	}
	restore := &model.ChannelBackupRestore{
		BackupID: backupID, TargetChannelID: &targetChannelID, TargetName: targetChannel.Name,
		RestoredBy: &userID, MessageCount: len(restoreItems),
	}
	if user, userErr := s.userRepo.GetByID(userID); userErr == nil && user != nil {
		restore.RestoredByName = user.Username
	}
	if err := s.channelRepo.RestoreBackupSnapshot(restoreItems, restore); err != nil {
		return nil, fmt.Errorf("恢复备份事务失败: %w", err)
	}
	cleanupUploads = false
	s.notifyMessageChanged(&model.ChannelMessage{ChannelID: targetChannelID})
	return restore, nil
}

func validateChannelBackupSnapshot(snapshot *channelBackupSnapshot) (map[int64][]byte, error) {
	if snapshot == nil {
		return nil, fmt.Errorf("备份内容为空")
	}
	if snapshot.Version != channelBackupVersion {
		return nil, fmt.Errorf("不支持的备份版本 %d", snapshot.Version)
	}
	if len(snapshot.Messages) > channelBackupMaxMessages {
		return nil, fmt.Errorf("消息数量超过 %d 条", channelBackupMaxMessages)
	}
	decodedFiles := make(map[int64][]byte, len(snapshot.Files))
	totalBytes := 0
	for _, file := range snapshot.Files {
		if file.OriginalID <= 0 {
			return nil, fmt.Errorf("附件标识无效")
		}
		if _, exists := decodedFiles[file.OriginalID]; exists {
			return nil, fmt.Errorf("附件 %d 重复", file.OriginalID)
		}
		if strings.TrimSpace(file.Filename) == "" || strings.TrimSpace(file.MimeType) == "" {
			return nil, fmt.Errorf("附件 %d 元数据不完整", file.OriginalID)
		}
		decoded, err := base64.StdEncoding.DecodeString(file.Data)
		if err != nil {
			return nil, fmt.Errorf("附件 %s 数据损坏", file.Filename)
		}
		if len(decoded) > channelBackupMaxFileBytes {
			return nil, fmt.Errorf("附件 %s 超过 25MB", file.Filename)
		}
		totalBytes += len(decoded)
		if totalBytes > channelBackupMaxTotalBytes {
			return nil, fmt.Errorf("附件总量超过 100MB")
		}
		decodedFiles[file.OriginalID] = decoded
	}
	messageIDs := make(map[int64]struct{}, len(snapshot.Messages))
	for _, item := range snapshot.Messages {
		if item.OriginalID <= 0 {
			return nil, fmt.Errorf("消息标识无效")
		}
		if _, exists := messageIDs[item.OriginalID]; exists {
			return nil, fmt.Errorf("消息 %d 重复", item.OriginalID)
		}
		messageIDs[item.OriginalID] = struct{}{}
		if item.AttachmentID != nil {
			if _, exists := decodedFiles[*item.AttachmentID]; !exists {
				return nil, fmt.Errorf("消息 %d 引用的附件不存在", item.OriginalID)
			}
		}
	}
	return decodedFiles, nil
}

func (s *ChannelService) DeleteBackup(userID, backupID int64) error {
	backup, err := s.accessibleBackup(userID, backupID)
	if err != nil {
		return err
	}
	isAdmin, err := s.permSvc.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin && (backup.CreatedBy == nil || *backup.CreatedBy != userID) {
		return ErrChannelManageDenied
	}
	attachmentID, err := s.channelRepo.DeleteBackup(backupID)
	if err != nil {
		return err
	}
	return s.uploadSvc.DeleteFile(attachmentID)
}

func (s *ChannelService) accessibleBackup(userID, backupID int64) (*model.ChannelBackup, error) {
	backup, err := s.channelRepo.GetBackup(backupID)
	if err != nil {
		return nil, err
	}
	isAdmin, err := s.permSvc.IsAdmin(userID)
	if err != nil {
		return nil, err
	}
	if isAdmin || (backup.CreatedBy != nil && *backup.CreatedBy == userID) {
		return backup, nil
	}
	if backup.SourceChannelID != nil {
		if _, err := s.requireChannelManage(userID, *backup.SourceChannelID); err == nil {
			return backup, nil
		}
	}
	return nil, ErrChannelAccessDenied
}

func sanitizeBackupFilename(value string) string {
	value = strings.TrimSpace(value)
	replacer := strings.NewReplacer("/", "_", `\`, "_", ":", "_", "*", "_", "?", "_", `"`, "_", "<", "_", ">", "_", "|", "_")
	value = replacer.Replace(value)
	if value == "" {
		return "channel"
	}
	return value
}
