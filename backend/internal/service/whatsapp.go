package service

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const whatsappMaxSendBytes = 25 * 1024 * 1024

var whatsappSettingKeys = []string{
	"whatsapp_enabled",
	"whatsapp_auto_start",
	"whatsapp_proxy_type",
	"whatsapp_proxy_host",
	"whatsapp_proxy_port",
	"whatsapp_proxy_username",
	"whatsapp_proxy_password",
}

type WhatsAppService struct {
	repo           *repo.WhatsAppRepo
	channelRepo    *repo.ChannelRepo
	uploadSvc      *UploadService
	sheetSvc       *SheetService
	permSvc        *PermissionService
	serviceURL     string
	internalSecret string
	httpClient     *http.Client
	encryptionKey  [32]byte
	inboundHook    func(*model.ChannelMessage)
}

type whatsappSendMedia struct {
	Data     string `json:"data"`
	Mimetype string `json:"mimetype"`
	Filename string `json:"filename"`
}

type whatsappSendPayload struct {
	ChatID              string             `json:"chatId"`
	Content             string             `json:"content,omitempty"`
	Media               *whatsappSendMedia `json:"media,omitempty"`
	QuotedMessageID     string             `json:"quotedMessageId,omitempty"`
	SendMediaAsDocument bool               `json:"sendMediaAsDocument,omitempty"`
}

type whatsappSentMessage struct {
	ID        string `json:"id"`
	ChatID    string `json:"chatId"`
	Timestamp int64  `json:"timestamp"`
}

type whatsAppWebhookEvent struct {
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt string          `json:"occurredAt"`
}

type whatsAppIncomingMessage struct {
	ID           string             `json:"id"`
	ChatID       string             `json:"chatId"`
	From         string             `json:"from"`
	Author       string             `json:"author"`
	FromMe       bool               `json:"fromMe"`
	Body         string             `json:"body"`
	SenderName   string             `json:"senderName"`
	SenderNumber string             `json:"senderNumber"`
	Media        *whatsappSendMedia `json:"media"`
}

func NewWhatsAppService(
	whatsAppRepo *repo.WhatsAppRepo,
	channelRepo *repo.ChannelRepo,
	uploadSvc *UploadService,
	sheetSvc *SheetService,
	permSvc *PermissionService,
	serviceURL, internalSecret, encryptionSecret string,
) *WhatsAppService {
	return &WhatsAppService{
		repo:           whatsAppRepo,
		channelRepo:    channelRepo,
		uploadSvc:      uploadSvc,
		sheetSvc:       sheetSvc,
		permSvc:        permSvc,
		serviceURL:     strings.TrimRight(serviceURL, "/"),
		internalSecret: internalSecret,
		httpClient:     &http.Client{Timeout: 90 * time.Second},
		encryptionKey:  sha256.Sum256([]byte(encryptionSecret + ":whatsapp-proxy")),
	}
}

func (s *WhatsAppService) SetInboundHook(hook func(*model.ChannelMessage)) {
	s.inboundHook = hook
}

func (s *WhatsAppService) GetSettings() (*model.WhatsAppSettings, error) {
	values, err := s.repo.GetSettings(whatsappSettingKeys)
	if err != nil {
		return nil, err
	}
	settings := &model.WhatsAppSettings{
		Enabled:       parseStoredBool(values["whatsapp_enabled"]),
		AutoStart:     values["whatsapp_auto_start"] == "" || parseStoredBool(values["whatsapp_auto_start"]),
		ProxyType:     normalizeWhatsAppProxyType(values["whatsapp_proxy_type"]),
		ProxyHost:     strings.TrimSpace(values["whatsapp_proxy_host"]),
		ProxyUsername: strings.TrimSpace(values["whatsapp_proxy_username"]),
	}
	settings.ProxyPort, _ = strconv.Atoi(values["whatsapp_proxy_port"])
	settings.ProxyPasswordConfigured = strings.TrimSpace(values["whatsapp_proxy_password"]) != ""
	return settings, nil
}

func (s *WhatsAppService) UpdateSettings(input *model.WhatsAppSettings) (*model.WhatsAppSettings, error) {
	proxyType := normalizeWhatsAppProxyType(input.ProxyType)
	if proxyType != "none" {
		if strings.TrimSpace(input.ProxyHost) == "" {
			return nil, fmt.Errorf("代理地址不能为空")
		}
		if input.ProxyPort < 1 || input.ProxyPort > 65535 {
			return nil, fmt.Errorf("代理端口必须在 1 到 65535 之间")
		}
	}
	current, err := s.repo.GetSettings(whatsappSettingKeys)
	if err != nil {
		return nil, err
	}
	password := current["whatsapp_proxy_password"]
	if input.ProxyPassword != "" {
		password, err = s.encryptSecret(input.ProxyPassword)
		if err != nil {
			return nil, err
		}
	} else if !input.ProxyPasswordConfigured {
		password = ""
	}
	values := map[string]string{
		"whatsapp_enabled":        strconv.FormatBool(input.Enabled),
		"whatsapp_auto_start":     strconv.FormatBool(input.AutoStart),
		"whatsapp_proxy_type":     proxyType,
		"whatsapp_proxy_host":     strings.TrimSpace(input.ProxyHost),
		"whatsapp_proxy_port":     strconv.Itoa(input.ProxyPort),
		"whatsapp_proxy_username": strings.TrimSpace(input.ProxyUsername),
		"whatsapp_proxy_password": password,
	}
	if proxyType == "none" {
		values["whatsapp_proxy_host"] = ""
		values["whatsapp_proxy_port"] = "0"
		values["whatsapp_proxy_username"] = ""
		values["whatsapp_proxy_password"] = ""
	}
	if err := s.repo.UpsertSettings(values); err != nil {
		return nil, err
	}
	updated, err := s.GetSettings()
	if err != nil {
		return nil, err
	}
	if err := s.configureSidecar(updated); err != nil {
		return nil, fmt.Errorf("配置已保存，但 WhatsApp 服务暂时不可用: %w", err)
	}
	return updated, nil
}

func (s *WhatsAppService) AutoStart() {
	settings, err := s.GetSettings()
	if err != nil || !settings.Enabled || !settings.AutoStart {
		return
	}
	if err := s.Start(); err != nil {
		fmt.Printf("WhatsApp auto start failed: %v\n", err)
	}
}

func (s *WhatsAppService) Start() error {
	settings, err := s.GetSettings()
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return fmt.Errorf("请先在管理后台启用 WhatsApp")
	}
	if err := s.configureSidecar(settings); err != nil {
		return err
	}
	return s.callSidecar(http.MethodPost, "/session/start", nil, nil)
}

func (s *WhatsAppService) Restart() error {
	settings, err := s.GetSettings()
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return fmt.Errorf("请先在管理后台启用 WhatsApp")
	}
	if err := s.configureSidecar(settings); err != nil {
		return err
	}
	return s.callSidecar(http.MethodPost, "/session/restart", nil, nil)
}

func (s *WhatsAppService) Logout() error {
	return s.callSidecar(http.MethodPost, "/session/logout", nil, nil)
}

func (s *WhatsAppService) GetStatus() (*model.WhatsAppStatus, error) {
	status := &model.WhatsAppStatus{Status: "unavailable"}
	if err := s.callSidecar(http.MethodGet, "/status", nil, status); err != nil {
		status.LastError = err.Error()
		return status, nil
	}
	return status, nil
}

func (s *WhatsAppService) ListChats() ([]model.WhatsAppChat, error) {
	chats := make([]model.WhatsAppChat, 0)
	if err := s.callSidecar(http.MethodGet, "/chats", nil, &chats); err != nil {
		return nil, err
	}
	return chats, nil
}

func (s *WhatsAppService) GetChannelLink(userID, channelID int64) (*model.WhatsAppChannelLink, error) {
	if err := s.requireChannelAccess(userID, channelID); err != nil {
		return nil, err
	}
	link, err := s.repo.GetChannelLink(channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return link, err
}

func (s *WhatsAppService) UpdateChannelLink(userID, channelID int64, request *model.WhatsAppChannelLinkRequest) (*model.WhatsAppChannelLink, error) {
	if err := s.requireChannelManage(userID, channelID); err != nil {
		return nil, err
	}
	chatID := strings.TrimSpace(request.WhatsAppChatID)
	if chatID == "" {
		return nil, fmt.Errorf("请选择 WhatsApp 会话")
	}
	syncInbound, syncOutbound := true, true
	if request.SyncInbound != nil {
		syncInbound = *request.SyncInbound
	}
	if request.SyncOutbound != nil {
		syncOutbound = *request.SyncOutbound
	}
	link := &model.WhatsAppChannelLink{
		ChannelID:        channelID,
		WhatsAppChatID:   chatID,
		WhatsAppChatName: strings.TrimSpace(request.WhatsAppChatName),
		SyncInbound:      syncInbound,
		SyncOutbound:     syncOutbound,
		CreatedBy:        userID,
	}
	if link.WhatsAppChatName == "" {
		link.WhatsAppChatName = chatID
	}
	if err := s.repo.UpsertChannelLink(link); err != nil {
		return nil, err
	}
	return link, nil
}

func (s *WhatsAppService) DeleteChannelLink(userID, channelID int64) error {
	if err := s.requireChannelManage(userID, channelID); err != nil {
		return err
	}
	return s.repo.DeleteChannelLink(channelID)
}

func (s *WhatsAppService) ForwardChannelMessage(userID, channelID, messageID int64) error {
	link, err := s.repo.GetChannelLink(channelID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !link.SyncOutbound) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = s.sendStoredChannelMessage(userID, link, messageID)
	return err
}

func (s *WhatsAppService) SendChannelMessage(userID, channelID, messageID int64) (*whatsappSentMessage, error) {
	if err := s.requireChannelAccess(userID, channelID); err != nil {
		return nil, err
	}
	link, err := s.repo.GetChannelLink(channelID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("当前频道尚未关联 WhatsApp 会话")
		}
		return nil, err
	}
	return s.sendStoredChannelMessage(userID, link, messageID)
}

func (s *WhatsAppService) SendResource(userID int64, request *model.WhatsAppSendRequest) (*whatsappSentMessage, error) {
	if request.MessageID > 0 && request.ChannelID > 0 {
		return s.SendChannelMessage(userID, request.ChannelID, request.MessageID)
	}
	chatID := strings.TrimSpace(request.ChatID)
	if chatID == "" && request.ChannelID > 0 {
		if err := s.requireChannelAccess(userID, request.ChannelID); err != nil {
			return nil, err
		}
		link, err := s.repo.GetChannelLink(request.ChannelID)
		if err != nil {
			return nil, fmt.Errorf("当前频道尚未关联 WhatsApp 会话")
		}
		chatID = link.WhatsAppChatID
	}
	if chatID == "" {
		return nil, fmt.Errorf("请选择 WhatsApp 会话")
	}
	payload := &whatsappSendPayload{ChatID: chatID, Content: strings.TrimSpace(request.Content)}
	if request.AttachmentID != nil {
		if err := s.attachStoredFile(userID, *request.AttachmentID, payload, false); err != nil {
			return nil, err
		}
	} else if request.SheetID != nil {
		exportFile, err := s.sheetSvc.BuildSheetExportFile(userID, *request.SheetID, "")
		if err != nil {
			return nil, err
		}
		s.attachExportFile(exportFile, payload)
	} else if request.WorkbookID != nil {
		exportFile, err := s.sheetSvc.BuildWorkbookExportFile(userID, *request.WorkbookID, nil, "")
		if err != nil {
			return nil, err
		}
		s.attachExportFile(exportFile, payload)
	}
	if payload.Content == "" && payload.Media == nil {
		return nil, fmt.Errorf("请输入消息或选择要发送的文件")
	}
	return s.sendPayload(payload)
}

func (s *WhatsAppService) HandleWebhook(body []byte) error {
	var event whatsAppWebhookEvent
	if err := json.Unmarshal(body, &event); err != nil {
		return err
	}
	switch event.Type {
	case "message":
		var incoming whatsAppIncomingMessage
		if err := json.Unmarshal(event.Payload, &incoming); err != nil {
			return err
		}
		return s.handleIncomingMessage(&incoming)
	case "message_ack":
		var ack struct {
			ID  string `json:"id"`
			Ack int    `json:"ack"`
		}
		if err := json.Unmarshal(event.Payload, &ack); err != nil {
			return err
		}
		return s.repo.UpdateMessageAck(ack.ID, ack.Ack)
	default:
		return nil
	}
}

func (s *WhatsAppService) ValidateInternalSecret(value string) bool {
	return s.internalSecret != "" && value == s.internalSecret
}

func (s *WhatsAppService) handleIncomingMessage(incoming *whatsAppIncomingMessage) error {
	if incoming.FromMe || strings.TrimSpace(incoming.ID) == "" || strings.TrimSpace(incoming.ChatID) == "" {
		return nil
	}
	exists, err := s.repo.HasExternalMessage("whatsapp", incoming.ID)
	if err != nil || exists {
		return err
	}
	link, err := s.repo.FindChannelLinkByChatID(incoming.ChatID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !link.SyncInbound) {
		return nil
	}
	if err != nil {
		return err
	}
	uploaderID := link.CreatedBy
	if uploaderID <= 0 {
		channel, channelErr := s.channelRepo.GetChannel(link.ChannelID, 0)
		if channelErr != nil {
			return channelErr
		}
		uploaderID = channel.OwnerID
	}
	var attachmentID *int64
	content := strings.TrimSpace(incoming.Body)
	if incoming.Media != nil && incoming.Media.Data != "" {
		data, decodeErr := base64.StdEncoding.DecodeString(incoming.Media.Data)
		if decodeErr != nil {
			return decodeErr
		}
		if len(data) > whatsappMaxSendBytes {
			content = strings.TrimSpace(content + "\n[WhatsApp 附件超过 25MB，未自动保存]")
		} else {
			filename := sanitizeWhatsAppFilename(incoming.Media.Filename)
			attachment, _, uploadErr := s.uploadSvc.UploadBytes(filename, incoming.Media.Mimetype, data, uploaderID)
			if uploadErr != nil {
				return uploadErr
			}
			attachmentID = &attachment.ID
			if strings.HasPrefix(strings.ToLower(incoming.Media.Mimetype), "image/") {
				_ = s.saveIncomingImageToGallery(link, attachment.ID, uploaderID)
			}
			if content == "" {
				content = filename
			}
		}
	}
	if content == "" && attachmentID == nil {
		content = "[WhatsApp 消息]"
	}
	senderName := strings.TrimSpace(incoming.SenderName)
	if senderName == "" {
		senderName = whatsAppFirstNonEmpty(incoming.SenderNumber, incoming.Author, incoming.From, "WhatsApp 联系人")
	}
	senderAddress := whatsAppFirstNonEmpty(incoming.SenderNumber, incoming.Author, incoming.From)
	externalSource, externalID := "whatsapp", incoming.ID
	message := &model.ChannelMessage{
		ChannelID:             link.ChannelID,
		SenderType:            "whatsapp",
		Content:               content,
		AttachmentID:          attachmentID,
		ExternalSource:        &externalSource,
		ExternalMessageID:     &externalID,
		ExternalSenderName:    &senderName,
		ExternalSenderAddress: &senderAddress,
	}
	if err := s.repo.CreateExternalMessage(message); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	_ = s.repo.RecordMessageLink(message.ID, incoming.ID, "inbound", nil)
	_ = s.repo.TouchChannel(link.ChannelID)
	created, err := s.channelRepo.GetMessage(message.ID)
	if err != nil {
		return err
	}
	s.attachChannelMessageURL(created)
	if s.inboundHook != nil {
		s.inboundHook(created)
	}
	return nil
}

func (s *WhatsAppService) sendStoredChannelMessage(userID int64, link *model.WhatsAppChannelLink, messageID int64) (*whatsappSentMessage, error) {
	message, err := s.channelRepo.GetMessage(messageID)
	if err != nil {
		return nil, err
	}
	if message.ChannelID != link.ChannelID || message.RecalledAt != nil || message.SenderType == "whatsapp" {
		return nil, fmt.Errorf("该消息不能发送到 WhatsApp")
	}
	payload := &whatsappSendPayload{ChatID: link.WhatsAppChatID, Content: strings.TrimSpace(message.Content)}
	if message.ReplyToMessageID != nil {
		payload.QuotedMessageID, _ = s.repo.ExternalMessageID(*message.ReplyToMessageID)
	}
	if message.AttachmentID != nil {
		if err := s.attachStoredFile(userID, *message.AttachmentID, payload, true); err != nil {
			return nil, err
		}
	} else if message.LinkedSheetID != nil {
		exportFile, err := s.sheetSvc.BuildSheetExportFile(userID, *message.LinkedSheetID, "")
		if err != nil {
			return nil, err
		}
		s.attachExportFile(exportFile, payload)
	} else if message.LinkedWorkbookID != nil {
		exportFile, err := s.sheetSvc.BuildWorkbookExportFile(userID, *message.LinkedWorkbookID, nil, "")
		if err != nil {
			return nil, err
		}
		s.attachExportFile(exportFile, payload)
	}
	if message.LinkedSummaryTitle != nil {
		payload.Content = strings.TrimSpace(payload.Content + "\nAI 总结：" + *message.LinkedSummaryTitle)
	}
	sent, err := s.sendPayload(payload)
	if err != nil {
		return nil, err
	}
	if sent.ID != "" {
		_ = s.repo.RecordMessageLink(message.ID, sent.ID, "outbound", nil)
	}
	return sent, nil
}

func (s *WhatsAppService) sendPayload(payload *whatsappSendPayload) (*whatsappSentMessage, error) {
	var sent whatsappSentMessage
	if err := s.callSidecar(http.MethodPost, "/messages/send", payload, &sent); err != nil {
		return nil, err
	}
	return &sent, nil
}

func (s *WhatsAppService) attachStoredFile(userID, attachmentID int64, payload *whatsappSendPayload, trustedChannelMessage bool) error {
	attachment, reader, err := s.uploadSvc.OpenStoredFile(attachmentID)
	if err != nil {
		return err
	}
	defer reader.Close()
	allowed := attachment.UploaderID == userID
	if !allowed {
		allowed, _ = s.uploadSvc.CanAccessGalleryImage(userID, attachmentID)
	}
	if !allowed && !trustedChannelMessage {
		return fmt.Errorf("没有权限发送这个附件")
	}
	data, err := io.ReadAll(io.LimitReader(reader, whatsappMaxSendBytes+1))
	if err != nil {
		return err
	}
	if len(data) > whatsappMaxSendBytes {
		return fmt.Errorf("WhatsApp 附件不能超过 25MB")
	}
	payload.Media = &whatsappSendMedia{
		Data:     base64.StdEncoding.EncodeToString(data),
		Mimetype: attachment.MimeType,
		Filename: attachment.Filename,
	}
	payload.SendMediaAsDocument = !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/")
	return nil
}

func (s *WhatsAppService) attachExportFile(exportFile *sheetExportFile, payload *whatsappSendPayload) {
	payload.Media = &whatsappSendMedia{
		Data:     base64.StdEncoding.EncodeToString(exportFile.Data),
		Mimetype: exportFile.ContentType,
		Filename: exportFile.Filename,
	}
	payload.SendMediaAsDocument = true
}

func (s *WhatsAppService) saveIncomingImageToGallery(link *model.WhatsAppChannelLink, attachmentID, userID int64) error {
	directories, err := s.uploadSvc.ListGalleryDirectories(userID, &link.ChannelID)
	if err != nil {
		return err
	}
	directoryName := "WhatsApp - " + strings.TrimSpace(link.WhatsAppChatName)
	if directoryName == "WhatsApp -" || directoryName == "WhatsApp - " {
		directoryName = "WhatsApp 图片"
	}
	var directoryID *int64
	for _, directory := range directories {
		if directory.Name == directoryName {
			id := directory.ID
			directoryID = &id
			break
		}
	}
	if directoryID == nil {
		visibility := "channel"
		directory, err := s.uploadSvc.CreateGalleryDirectory(userID, directoryName, &link.ChannelID, &visibility)
		if err != nil {
			return err
		}
		directoryID = &directory.ID
	}
	return s.uploadSvc.SaveImageToGallery(attachmentID, directoryID, &link.ChannelID, userID)
}

func (s *WhatsAppService) attachChannelMessageURL(message *model.ChannelMessage) {
	if message.AttachmentID != nil {
		message.AttachmentURL, _ = s.uploadSvc.GetFileURL(*message.AttachmentID)
	}
}

func (s *WhatsAppService) requireChannelAccess(userID, channelID int64) error {
	allowed, err := s.channelRepo.IsChannelMember(channelID, userID)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrChannelAccessDenied
	}
	return nil
}

func (s *WhatsAppService) requireChannelManage(userID, channelID int64) error {
	channel, err := s.channelRepo.GetChannel(channelID, userID)
	if err != nil {
		return err
	}
	isAdmin, err := s.permSvc.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin && channel.OwnerID != userID {
		return ErrChannelManageDenied
	}
	return nil
}

func (s *WhatsAppService) configureSidecar(settings *model.WhatsAppSettings) error {
	proxyURL, err := s.buildProxyURL(settings)
	if err != nil {
		return err
	}
	payload := map[string]interface{}{"enabled": settings.Enabled, "proxyUrl": proxyURL}
	return s.callSidecar(http.MethodPost, "/configure", payload, nil)
}

func (s *WhatsAppService) buildProxyURL(settings *model.WhatsAppSettings) (string, error) {
	if settings.ProxyType == "none" {
		return "", nil
	}
	values, err := s.repo.GetSettings(whatsappSettingKeys)
	if err != nil {
		return "", err
	}
	password, err := s.decryptSecret(values["whatsapp_proxy_password"])
	if err != nil {
		return "", err
	}
	proxyURL := &url.URL{
		Scheme: settings.ProxyType,
		Host:   fmt.Sprintf("%s:%d", strings.TrimSpace(settings.ProxyHost), settings.ProxyPort),
	}
	if settings.ProxyUsername != "" {
		proxyURL.User = url.UserPassword(settings.ProxyUsername, password)
	}
	return proxyURL.String(), nil
}

func (s *WhatsAppService) callSidecar(method, path string, input, output interface{}) error {
	if s.serviceURL == "" || s.internalSecret == "" {
		return fmt.Errorf("WhatsApp 内部服务尚未配置")
	}
	var body io.Reader
	if input != nil {
		data, err := json.Marshal(input)
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, s.serviceURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("X-WhatsApp-Secret", s.internalSecret)
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := s.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 50*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var payload struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(data, &payload)
		if payload.Error == "" {
			payload.Error = strings.TrimSpace(string(data))
		}
		return fmt.Errorf("WhatsApp 服务返回 %d: %s", response.StatusCode, payload.Error)
	}
	if output != nil && len(data) > 0 {
		return json.Unmarshal(data, output)
	}
	return nil
}

func (s *WhatsAppService) encryptSecret(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	block, err := aes.NewCipher(s.encryptionKey[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(value), nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (s *WhatsAppService) decryptSecret(value string) (string, error) {
	if value == "" {
		return "", nil
	}
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("代理密码配置损坏")
	}
	block, err := aes.NewCipher(s.encryptionKey[:])
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(data) < gcm.NonceSize() {
		return "", fmt.Errorf("代理密码配置损坏")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("代理密码无法解密")
	}
	return string(plain), nil
}

func parseStoredBool(value string) bool {
	parsed, _ := strconv.ParseBool(value)
	return parsed
}

func normalizeWhatsAppProxyType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "http", "https", "socks5":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "none"
	}
}

func sanitizeWhatsAppFilename(filename string) string {
	filename = filepath.Base(strings.TrimSpace(filename))
	if filename == "." || filename == "" {
		return fmt.Sprintf("whatsapp-%d", time.Now().Unix())
	}
	return filename
}

func whatsAppFirstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
