package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/internal/ws"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type ChannelHandler struct {
	channelService *service.ChannelService
	uploadService  *service.UploadService
	hub            *ws.Hub
}

func NewChannelHandler(channelService *service.ChannelService, uploadService *service.UploadService, hub *ws.Hub) *ChannelHandler {
	return &ChannelHandler{channelService: channelService, uploadService: uploadService, hub: hub}
}

func (h *ChannelHandler) ListChannels(c *gin.Context) {
	channels, err := h.channelService.ListChannels(c.GetInt64("user_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, channels)
}

func (h *ChannelHandler) CreateChannel(c *gin.Context) {
	var req model.ChannelCreateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	channel, err := h.channelService.CreateChannel(c.GetInt64("user_id"), &req)
	if err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.OK(c, channel)
}

func (h *ChannelHandler) UpdateChannel(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.ChannelUpdateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	channel, err := h.channelService.UpdateChannel(c.GetInt64("user_id"), channelID, &req)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, channel)
}

func (h *ChannelHandler) DeleteChannel(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	if err := h.channelService.DeleteChannel(c.GetInt64("user_id"), channelID); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "channel deleted")
}

func (h *ChannelHandler) ListMembers(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	members, err := h.channelService.ListMembers(c.GetInt64("user_id"), channelID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, members)
}

func (h *ChannelHandler) AddMembers(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.ChannelMembersRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	members, err := h.channelService.AddMembers(c.GetInt64("user_id"), channelID, req.UserIDs)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, members)
}

func (h *ChannelHandler) RemoveMember(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	memberUserID, err := parseIDParam(c, "userId")
	if err != nil {
		response.BadRequest(c, "invalid user id")
		return
	}
	if err := h.channelService.RemoveMember(c.GetInt64("user_id"), channelID, memberUserID); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "member removed")
}

func (h *ChannelHandler) ListAIMembers(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	members, err := h.channelService.ListAIMembers(c.GetInt64("user_id"), channelID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, members)
}

func (h *ChannelHandler) SetAIMembers(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.ChannelAIMembersRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	members, err := h.channelService.SetAIMembers(c.GetInt64("user_id"), channelID, req.AssistantIDs)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, members)
}

func (h *ChannelHandler) OpenAIPrivateChannel(c *gin.Context) {
	var req model.ChannelAIPrivateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	channel, err := h.channelService.OpenAIPrivateChannel(c.GetInt64("user_id"), req.AssistantID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, channel)
}

func (h *ChannelHandler) AskAI(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.ChannelAIAskRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	result, err := h.channelService.AskAI(c.GetInt64("user_id"), channelID, &req)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	if h.hub != nil {
		for _, sheetID := range result.ChangedSheetIDs {
			payload, _ := json.Marshal(ws.Message{Type: "sheet_sync", SheetID: sheetID, UserID: c.GetInt64("user_id")})
			h.hub.BroadcastToSheetExceptClientID(sheetID, payload, c.GetHeader("X-Client-Id"))
		}
	}
	response.OK(c, result)
}

func (h *ChannelHandler) SetPinned(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.ChannelPinRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	if err := h.channelService.SetPinned(c.GetInt64("user_id"), channelID, req.Pinned); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "channel pin updated")
}

func (h *ChannelHandler) ReorderPinnedChannels(c *gin.Context) {
	var req model.ChannelPinOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	if err := h.channelService.ReorderPinnedChannels(c.GetInt64("user_id"), req.ChannelIDs); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "channel pin order updated")
}

func (h *ChannelHandler) UpdateChannelAvatar(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	var req model.AttachmentAvatarRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	channel, err := h.channelService.UpdateChannelAvatar(c.GetInt64("user_id"), channelID, req.AttachmentID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, channel)
}

func (h *ChannelHandler) ListMessages(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	messages, total, err := h.channelService.ListMessages(c.GetInt64("user_id"), channelID, page, size)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKPage(c, messages, total, page, size)
}

func (h *ChannelHandler) MarkChannelRead(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	if err := h.channelService.MarkChannelRead(c.GetInt64("user_id"), channelID); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "channel marked as read")
}

func (h *ChannelHandler) SearchMessages(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "50"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 200 {
		size = 50
	}
	from, err := parseOptionalQueryTime(c, "from")
	if err != nil {
		response.BadRequest(c, "invalid from time")
		return
	}
	to, err := parseOptionalQueryTime(c, "to")
	if err != nil {
		response.BadRequest(c, "invalid to time")
		return
	}

	filter := model.ChannelMessageSearchFilter{
		ChannelID:   parseOptionalQueryInt64(c, "channel_id"),
		Keyword:     c.Query("q"),
		MatchMode:   c.DefaultQuery("match", "contains"),
		SenderID:    parseOptionalQueryInt64(c, "sender_id"),
		MessageType: c.DefaultQuery("type", "all"),
		From:        from,
		To:          to,
		Page:        page,
		Size:        size,
	}
	results, total, err := h.channelService.SearchMessages(c.GetInt64("user_id"), filter)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKPage(c, results, total, filter.Page, filter.Size)
}

func (h *ChannelHandler) CreateMessage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil && !errors.Is(err, http.ErrMissingFile) {
		response.BadRequest(c, err.Error())
		return
	}
	if file != nil {
		defer file.Close()
	}

	directoryID := parseOptionalFormInt64(c, "gallery_directory_id")
	saveToGallery, _ := strconv.ParseBool(c.PostForm("save_to_gallery"))
	makeWorkbookPublic, _ := strconv.ParseBool(c.PostForm("make_workbook_public"))
	message, err := h.channelService.CreateMessage(c.GetInt64("user_id"), channelID, service.ChannelMessageInput{
		Content:            c.PostForm("content"),
		File:               file,
		FileHeader:         header,
		AttachmentID:       parseOptionalFormInt64(c, "attachment_id"),
		SaveToGallery:      saveToGallery || directoryID != nil,
		GalleryDirectoryID: directoryID,
		LinkedWorkbookID:   parseOptionalFormInt64(c, "linked_workbook_id"),
		LinkedSheetID:      parseOptionalFormInt64(c, "linked_sheet_id"),
		LinkedSummaryID:    parseOptionalFormInt64(c, "linked_summary_id"),
		MakeWorkbookPublic: makeWorkbookPublic,
		ReplyToMessageID:   parseOptionalFormInt64(c, "reply_to_message_id"),
	})
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, message)
}

func (h *ChannelHandler) RecallMessage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := parseIDParam(c, "messageId")
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	message, err := h.channelService.RecallMessage(c.GetInt64("user_id"), channelID, messageID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, message)
}

func (h *ChannelHandler) EditMessage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := parseIDParam(c, "messageId")
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	var req model.ChannelMessageEditRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	message, err := h.channelService.EditMessage(c.GetInt64("user_id"), channelID, messageID, req.Content)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, message)
}

func (h *ChannelHandler) ImportMessageWorkbook(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := parseIDParam(c, "messageId")
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	var req model.ChannelWorkbookImportRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	result, err := h.channelService.ImportMessageWorkbook(c.GetInt64("user_id"), channelID, messageID, &req)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *ChannelHandler) ListBackups(c *gin.Context) {
	backups, err := h.channelService.ListBackups(c.GetInt64("user_id"))
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, backups)
}

func (h *ChannelHandler) CreateBackup(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	backup, err := h.channelService.CreateBackup(c.GetInt64("user_id"), channelID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, backup)
}

func (h *ChannelHandler) RestoreBackup(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	backupID, err := parseIDParam(c, "backupId")
	if err != nil {
		response.BadRequest(c, "invalid backup id")
		return
	}
	restore, err := h.channelService.RestoreBackup(c.GetInt64("user_id"), channelID, backupID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, restore)
}

func (h *ChannelHandler) ListBackupRestores(c *gin.Context) {
	backupID, err := parseIDParam(c, "backupId")
	if err != nil {
		response.BadRequest(c, "invalid backup id")
		return
	}
	restores, err := h.channelService.ListBackupRestores(c.GetInt64("user_id"), backupID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, restores)
}

func (h *ChannelHandler) DeleteBackup(c *gin.Context) {
	backupID, err := parseIDParam(c, "backupId")
	if err != nil {
		response.BadRequest(c, "invalid backup id")
		return
	}
	if err := h.channelService.DeleteBackup(c.GetInt64("user_id"), backupID); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "channel backup deleted")
}

func (h *ChannelHandler) ForwardMessage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := parseIDParam(c, "messageId")
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	var req model.ChannelForwardRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	message, err := h.channelService.ForwardMessage(c.GetInt64("user_id"), channelID, messageID, &req)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, message)
}

func (h *ChannelHandler) SaveMessageImage(c *gin.Context) {
	channelID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid channel id")
		return
	}
	messageID, err := parseIDParam(c, "messageId")
	if err != nil {
		response.BadRequest(c, "invalid message id")
		return
	}
	var req model.ChannelImageSaveRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	if err := h.channelService.SaveMessageImage(c.GetInt64("user_id"), channelID, messageID, req.GalleryDirectoryID); err != nil {
		respondChannelError(c, err)
		return
	}
	response.OKMsg(c, "image saved")
}

func (h *ChannelHandler) ListGalleryDirectories(c *gin.Context) {
	directories, err := h.uploadService.ListGalleryDirectories(c.GetInt64("user_id"), parseOptionalQueryInt64(c, "channel_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, directories)
}

func (h *ChannelHandler) CreateGalleryDirectory(c *gin.Context) {
	var req model.GalleryDirectoryRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	directory, err := h.uploadService.CreateGalleryDirectory(c.GetInt64("user_id"), req.Name, req.ChannelID, req.Visibility)
	if err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.OK(c, directory)
}

func (h *ChannelHandler) DeleteGalleryDirectory(c *gin.Context) {
	directoryID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid gallery directory id")
		return
	}
	if err := h.uploadService.DeleteGalleryDirectory(directoryID); err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	response.OKMsg(c, "gallery directory deleted")
}

func (h *ChannelHandler) GetGalleryDirectoryAccess(c *gin.Context) {
	directoryID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid gallery directory id")
		return
	}
	access, err := h.uploadService.GetGalleryDirectoryAccess(c.GetInt64("user_id"), directoryID)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, access)
}

func (h *ChannelHandler) UpdateGalleryDirectoryAccess(c *gin.Context) {
	directoryID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid gallery directory id")
		return
	}
	var req model.GalleryDirectoryAccessRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	access, err := h.uploadService.UpdateGalleryDirectoryAccess(c.GetInt64("user_id"), directoryID, &req)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, access)
}

func (h *ChannelHandler) UploadGalleryImage(c *gin.Context) {
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "file is required")
		return
	}
	defer file.Close()

	userID := c.GetInt64("user_id")
	attachment, err := h.uploadService.Upload(file, header, userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	if !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/") {
		response.BadRequest(c, "only image files can be uploaded to gallery")
		return
	}
	directoryID := parseOptionalFormInt64(c, "gallery_directory_id")
	channelID := parseOptionalFormInt64(c, "channel_id")
	effectiveAttachmentID, duplicate, err := h.uploadService.SaveImageToGalleryDeduplicated(attachment.ID, directoryID, channelID, userID)
	if err != nil {
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}
	if duplicate && effectiveAttachmentID != attachment.ID {
		if err := h.uploadService.DeleteFile(attachment.ID); err != nil {
			response.ServerError(c, err.Error())
			return
		}
		attachment, err = h.uploadService.GetAttachment(effectiveAttachmentID)
		if err != nil {
			response.ServerError(c, err.Error())
			return
		}
	}
	url, _ := h.uploadService.GetFileURL(attachment.ID)
	response.OK(c, gin.H{"attachment": attachment, "url": url, "duplicate": duplicate})
}

func (h *ChannelHandler) RenameGalleryImage(c *gin.Context) {
	attachmentID, err := parseIDParam(c, "id")
	if err != nil {
		response.BadRequest(c, "invalid attachment id")
		return
	}
	var req model.GalleryImageRenameRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	attachment, err := h.channelService.RenameGalleryImage(c.GetInt64("user_id"), attachmentID, req.Filename)
	if err != nil {
		respondChannelError(c, err)
		return
	}
	response.OK(c, attachment)
}

func respondChannelError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrChannelAccessDenied), errors.Is(err, service.ErrChannelManageDenied), errors.Is(err, service.ErrGalleryImageRenameDenied), errors.Is(err, service.ErrMessageRecallDenied), errors.Is(err, service.ErrMessageEditDenied):
		response.Forbidden(c, err.Error())
	default:
		response.Error(c, http.StatusBadRequest, err.Error())
	}
}

func parseIDParam(c *gin.Context, name string) (int64, error) {
	return strconv.ParseInt(c.Param(name), 10, 64)
}

func parseOptionalFormInt64(c *gin.Context, key string) *int64 {
	raw := strings.TrimSpace(c.PostForm(key))
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return nil
	}
	return &value
}

func parseOptionalQueryInt64(c *gin.Context, key string) *int64 {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return nil
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value <= 0 {
		return nil
	}
	return &value
}

func parseOptionalQueryTime(c *gin.Context, key string) (*time.Time, error) {
	raw := strings.TrimSpace(c.Query(key))
	if raw == "" {
		return nil, nil
	}
	value, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}
