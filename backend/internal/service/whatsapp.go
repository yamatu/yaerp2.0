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
	"whatsapp_enabled", "whatsapp_auto_start", "whatsapp_proxy_type", "whatsapp_proxy_host",
	"whatsapp_proxy_port", "whatsapp_proxy_username", "whatsapp_proxy_password",
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
	SessionID  string          `json:"sessionId"`
	Type       string          `json:"type"`
	Payload    json.RawMessage `json:"payload"`
	OccurredAt string          `json:"occurredAt"`
}

type whatsAppIncomingMessage struct {
	ID                  string             `json:"id"`
	ChatID              string             `json:"chatId"`
	From                string             `json:"from"`
	Author              string             `json:"author"`
	FromMe              bool               `json:"fromMe"`
	Body                string             `json:"body"`
	SenderName          string             `json:"senderName"`
	SenderNumber        string             `json:"senderNumber"`
	SenderProfilePicURL string             `json:"senderProfilePicUrl"`
	QuotedMessageID     string             `json:"quotedMessageId"`
	QuotedMessageBody   string             `json:"quotedMessageBody"`
	QuotedSenderName    string             `json:"quotedMessageSenderName"`
	QuotedMessageFromMe bool               `json:"quotedMessageFromMe"`
	Media               *whatsappSendMedia `json:"media"`
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
		repo: whatsAppRepo, channelRepo: channelRepo, uploadSvc: uploadSvc, sheetSvc: sheetSvc, permSvc: permSvc,
		serviceURL: strings.TrimRight(serviceURL, "/"), internalSecret: internalSecret,
		httpClient:    &http.Client{Timeout: 90 * time.Second},
		encryptionKey: sha256.Sum256([]byte(encryptionSecret + ":whatsapp-proxy")),
	}
}

func (s *WhatsAppService) SetInboundHook(hook func(*model.ChannelMessage)) { s.inboundHook = hook }

func (s *WhatsAppService) GetSettings() (*model.WhatsAppSettings, error) {
	values, err := s.repo.GetSettings(whatsappSettingKeys)
	if err != nil {
		return nil, err
	}
	settings := &model.WhatsAppSettings{
		Enabled:                 parseStoredBool(values["whatsapp_enabled"]),
		AutoStart:               values["whatsapp_auto_start"] == "" || parseStoredBool(values["whatsapp_auto_start"]),
		ProxyType:               normalizeWhatsAppProxyType(values["whatsapp_proxy_type"]),
		ProxyHost:               strings.TrimSpace(values["whatsapp_proxy_host"]),
		ProxyUsername:           strings.TrimSpace(values["whatsapp_proxy_username"]),
		ProxyPasswordConfigured: strings.TrimSpace(values["whatsapp_proxy_password"]) != "",
	}
	settings.ProxyPort, _ = strconv.Atoi(values["whatsapp_proxy_port"])
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
		values["whatsapp_proxy_host"], values["whatsapp_proxy_port"] = "", "0"
		values["whatsapp_proxy_username"], values["whatsapp_proxy_password"] = "", ""
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
	if err := s.configureSidecar(settings); err != nil {
		fmt.Printf("WhatsApp configure failed: %v\n", err)
		return
	}
	accounts, err := s.repo.ListAutoStartAccounts()
	if err != nil {
		fmt.Printf("WhatsApp account list failed: %v\n", err)
		return
	}
	for _, account := range accounts {
		account := account
		go func() {
			if err := s.startAccount(&account, false); err != nil {
				fmt.Printf("WhatsApp auto start user %d failed: %v\n", account.UserID, err)
			}
		}()
	}
}

func (s *WhatsAppService) GetAccount(requesterID, targetUserID int64) (*model.WhatsAppAccount, error) {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return nil, err
	}
	s.refreshAccountStatus(account)
	return account, nil
}

func (s *WhatsAppService) ListAccounts(requesterID int64) ([]model.WhatsAppAccount, error) {
	isAdmin, err := s.permSvc.IsAdmin(requesterID)
	if err != nil {
		return nil, err
	}
	if !isAdmin {
		return nil, ErrChannelManageDenied
	}
	accounts, err := s.repo.ListAccounts()
	if err != nil {
		return nil, err
	}
	for index := range accounts {
		s.refreshAccountStatus(&accounts[index])
	}
	return accounts, nil
}

func (s *WhatsAppService) UpdateAccountPreferences(requesterID, targetUserID int64, enabled, autoStart bool) (*model.WhatsAppAccount, error) {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return nil, err
	}
	if err := s.repo.UpdateAccountPreferences(account.UserID, enabled, autoStart); err != nil {
		return nil, err
	}
	return s.GetAccount(requesterID, account.UserID)
}

func (s *WhatsAppService) StartAccount(requesterID, targetUserID int64) error {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return err
	}
	return s.startAccount(account, true)
}

func (s *WhatsAppService) RestartAccount(requesterID, targetUserID int64) error {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return err
	}
	settings, err := s.GetSettings()
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return fmt.Errorf("管理员尚未启用 WhatsApp 服务")
	}
	if err := s.configureSidecar(settings); err != nil {
		return err
	}
	return s.callSidecar(http.MethodPost, s.sessionPath(account.UserID)+"/restart", nil, nil)
}

func (s *WhatsAppService) LogoutAccount(requesterID, targetUserID int64) error {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return err
	}
	if err := s.callSidecar(http.MethodPost, s.sessionPath(account.UserID)+"/logout", nil, nil); err != nil {
		return err
	}
	_ = s.repo.UpdateAccountPreferences(account.UserID, false, account.AutoStart)
	return s.repo.UpdateAccountRuntime(account.UserID, "disconnected", "", "", "", "", "", "", "")
}

func (s *WhatsAppService) ListChats(requesterID, targetUserID int64) ([]model.WhatsAppChat, error) {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.listChatsForAccount(account)
}

func (s *WhatsAppService) UpdateAccountAbout(requesterID, targetUserID int64, about string) (*model.WhatsAppAccount, error) {
	account, err := s.accountForAccess(requesterID, targetUserID)
	if err != nil {
		return nil, err
	}
	var profile map[string]interface{}
	if err := s.callSidecar(http.MethodPut, s.sessionPath(account.UserID)+"/profile/about", map[string]string{"about": about}, &profile); err != nil {
		return nil, err
	}
	s.applyRuntimeSnapshot(account.UserID, "ready", profile, "")
	return s.GetAccount(requesterID, account.UserID)
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
	account, err := s.accountByIDForAccess(userID, request.WhatsAppAccountID)
	if err != nil {
		return nil, err
	}
	chatID := strings.TrimSpace(request.WhatsAppChatID)
	if chatID == "" {
		return nil, fmt.Errorf("请选择 WhatsApp 会话")
	}
	chats, err := s.listChatsForAccount(account)
	if err != nil {
		return nil, err
	}
	var selected *model.WhatsAppChat
	for index := range chats {
		if chats[index].ID == chatID {
			selected = &chats[index]
			break
		}
	}
	if selected == nil {
		return nil, fmt.Errorf("所选 WhatsApp 会话不存在或当前账号不可访问")
	}
	syncInbound, syncOutbound := true, true
	if request.SyncInbound != nil {
		syncInbound = *request.SyncInbound
	}
	if request.SyncOutbound != nil {
		syncOutbound = *request.SyncOutbound
	}
	link := &model.WhatsAppChannelLink{
		ChannelID: channelID, WhatsAppAccountID: account.ID, WhatsAppUserID: account.UserID,
		WhatsAppUsername: account.Username, WhatsAppDisplayName: account.DisplayName,
		WhatsAppChatID: selected.ID, WhatsAppChatName: selected.Name, WhatsAppChatAvatarURL: selected.ProfilePicURL,
		WhatsAppChatAbout: whatsAppFirstNonEmpty(selected.Description, selected.About), WhatsAppIsGroup: selected.IsGroup,
		WhatsAppParticipantCount: selected.ParticipantCount, SyncInbound: syncInbound, SyncOutbound: syncOutbound, CreatedBy: userID,
	}
	if err := s.repo.UpsertChannelLink(link); err != nil {
		return nil, err
	}
	return s.repo.GetChannelLink(channelID)
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
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("当前频道尚未关联 WhatsApp 会话")
	}
	if err != nil {
		return nil, err
	}
	return s.sendStoredChannelMessage(userID, link, messageID)
}

func (s *WhatsAppService) SendResource(userID int64, request *model.WhatsAppSendRequest) (*whatsappSentMessage, error) {
	if request.MessageID > 0 && request.ChannelID > 0 {
		return s.SendChannelMessage(userID, request.ChannelID, request.MessageID)
	}
	account, err := s.accountByIDForAccess(userID, request.WhatsAppAccountID)
	if err != nil {
		return nil, err
	}
	chatID := strings.TrimSpace(request.ChatID)
	if chatID == "" && request.ChannelID > 0 {
		if err := s.requireChannelAccess(userID, request.ChannelID); err != nil {
			return nil, err
		}
		link, linkErr := s.repo.GetChannelLink(request.ChannelID)
		if linkErr != nil {
			return nil, fmt.Errorf("当前频道尚未关联 WhatsApp 会话")
		}
		account, err = s.repo.GetAccountByID(link.WhatsAppAccountID)
		if err != nil {
			return nil, err
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
	return s.sendPayload(account.UserID, payload)
}

func (s *WhatsAppService) HandleWebhook(body []byte) error {
	var event whatsAppWebhookEvent
	if err := json.Unmarshal(body, &event); err != nil {
		return err
	}
	userID, err := parseWhatsAppSessionUserID(event.SessionID)
	if err != nil {
		return err
	}
	account, err := s.repo.EnsureAccount(userID)
	if err != nil {
		return err
	}
	switch event.Type {
	case "status":
		var status model.WhatsAppStatus
		if err := json.Unmarshal(event.Payload, &status); err != nil {
			return err
		}
		s.applyRuntimeSnapshot(userID, status.Status, status.Account, status.LastError)
		return nil
	case "message":
		var incoming whatsAppIncomingMessage
		if err := json.Unmarshal(event.Payload, &incoming); err != nil {
			return err
		}
		return s.handleIncomingMessage(account, &incoming)
	case "message_edit":
		var incoming whatsAppIncomingMessage
		if err := json.Unmarshal(event.Payload, &incoming); err != nil {
			return err
		}
		if incoming.FromMe || strings.TrimSpace(incoming.ID) == "" {
			return nil
		}
		messageID, err := s.repo.EditExternalMessage(account.ID, incoming.ID, strings.TrimSpace(incoming.Body))
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		updated, err := s.channelRepo.GetMessage(messageID)
		if err != nil {
			return err
		}
		s.attachChannelMessageURL(updated)
		if s.inboundHook != nil {
			s.inboundHook(updated)
		}
		return nil
	case "message_ack":
		var ack struct {
			ID  string `json:"id"`
			Ack int    `json:"ack"`
		}
		if err := json.Unmarshal(event.Payload, &ack); err != nil {
			return err
		}
		return s.repo.UpdateMessageAck(account.ID, ack.ID, ack.Ack)
	default:
		return nil
	}
}

func (s *WhatsAppService) ValidateInternalSecret(value string) bool {
	return s.internalSecret != "" && value == s.internalSecret
}

func (s *WhatsAppService) handleIncomingMessage(account *model.WhatsAppAccount, incoming *whatsAppIncomingMessage) error {
	if incoming.FromMe || strings.TrimSpace(incoming.ID) == "" || strings.TrimSpace(incoming.ChatID) == "" {
		return nil
	}
	exists, err := s.repo.HasExternalMessage(account.ID, "whatsapp", incoming.ID)
	if err != nil || exists {
		return err
	}
	link, err := s.repo.FindChannelLink(account.ID, incoming.ChatID)
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
	externalSource, externalID, avatar := "whatsapp", incoming.ID, strings.TrimSpace(incoming.SenderProfilePicURL)
	message := &model.ChannelMessage{
		ChannelID: link.ChannelID, SenderType: "whatsapp", Content: content, AttachmentID: attachmentID,
		ExternalSource: &externalSource, ExternalAccountID: &account.ID, ExternalMessageID: &externalID,
		ExternalSenderName: &senderName, ExternalSenderAddress: &senderAddress,
	}
	if quotedID := strings.TrimSpace(incoming.QuotedMessageID); quotedID != "" {
		message.ReplyExternalMessageID = &quotedID
		if internalID, lookupErr := s.repo.ChannelMessageID(account.ID, quotedID); lookupErr == nil {
			message.ReplyToMessageID = &internalID
		}
		quotedSender := strings.TrimSpace(incoming.QuotedSenderName)
		if quotedSender == "" && incoming.QuotedMessageFromMe {
			quotedSender = account.DisplayName
		}
		if quotedSender != "" {
			message.ReplySnapshotSender = &quotedSender
		}
		quotedContent := strings.TrimSpace(incoming.QuotedMessageBody)
		if quotedContent != "" {
			message.ReplySnapshotContent = &quotedContent
		}
	}
	if avatar != "" {
		message.ExternalSenderAvatar = &avatar
	}
	if err := s.repo.CreateExternalMessage(message); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	_ = s.repo.RecordMessageLink(account.ID, message.ID, incoming.ID, "inbound", nil)
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
		payload.QuotedMessageID, _ = s.repo.ExternalMessageID(link.WhatsAppAccountID, *message.ReplyToMessageID)
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
	sent, err := s.sendPayload(link.WhatsAppUserID, payload)
	if err != nil {
		return nil, err
	}
	if sent.ID != "" {
		_ = s.repo.RecordMessageLink(link.WhatsAppAccountID, message.ID, sent.ID, "outbound", nil)
	}
	return sent, nil
}

func (s *WhatsAppService) EditForwardedChannelMessage(userID, channelID, messageID int64, content string) error {
	link, err := s.repo.GetChannelLink(channelID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !link.SyncOutbound) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := s.requireChannelAccess(userID, channelID); err != nil {
		return err
	}
	externalID, err := s.repo.ExternalMessageID(link.WhatsAppAccountID, messageID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	payload := map[string]string{"content": strings.TrimSpace(content)}
	return s.callSidecar(http.MethodPut, s.sessionPath(link.WhatsAppUserID)+"/messages/"+url.PathEscape(externalID), payload, nil)
}

func (s *WhatsAppService) sendPayload(accountUserID int64, payload *whatsappSendPayload) (*whatsappSentMessage, error) {
	var sent whatsappSentMessage
	if err := s.callSidecar(http.MethodPost, s.sessionPath(accountUserID)+"/messages/send", payload, &sent); err != nil {
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
	payload.Media = &whatsappSendMedia{Data: base64.StdEncoding.EncodeToString(data), Mimetype: attachment.MimeType, Filename: attachment.Filename}
	payload.SendMediaAsDocument = !strings.HasPrefix(strings.ToLower(attachment.MimeType), "image/")
	return nil
}

func (s *WhatsAppService) attachExportFile(exportFile *sheetExportFile, payload *whatsappSendPayload) {
	payload.Media = &whatsappSendMedia{Data: base64.StdEncoding.EncodeToString(exportFile.Data), Mimetype: exportFile.ContentType, Filename: exportFile.Filename}
	payload.SendMediaAsDocument = true
}

func (s *WhatsAppService) saveIncomingImageToGallery(link *model.WhatsAppChannelLink, attachmentID, userID int64) error {
	directories, err := s.uploadSvc.ListGalleryDirectories(userID, &link.ChannelID)
	if err != nil {
		return err
	}
	directoryName := "WhatsApp - " + strings.TrimSpace(link.WhatsAppChatName)
	if strings.TrimSpace(directoryName) == "WhatsApp -" {
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

func (s *WhatsAppService) accountForAccess(requesterID, targetUserID int64) (*model.WhatsAppAccount, error) {
	if targetUserID <= 0 {
		targetUserID = requesterID
	}
	if targetUserID != requesterID {
		isAdmin, err := s.permSvc.IsAdmin(requesterID)
		if err != nil {
			return nil, err
		}
		if !isAdmin {
			return nil, ErrChannelManageDenied
		}
	}
	return s.repo.EnsureAccount(targetUserID)
}

func (s *WhatsAppService) accountByIDForAccess(requesterID, accountID int64) (*model.WhatsAppAccount, error) {
	if accountID <= 0 {
		return s.repo.EnsureAccount(requesterID)
	}
	account, err := s.repo.GetAccountByID(accountID)
	if err != nil {
		return nil, err
	}
	if account.UserID != requesterID {
		isAdmin, err := s.permSvc.IsAdmin(requesterID)
		if err != nil {
			return nil, err
		}
		if !isAdmin {
			return nil, ErrChannelManageDenied
		}
	}
	return account, nil
}

func (s *WhatsAppService) startAccount(account *model.WhatsAppAccount, enable bool) error {
	settings, err := s.GetSettings()
	if err != nil {
		return err
	}
	if !settings.Enabled {
		return fmt.Errorf("管理员尚未启用 WhatsApp 服务")
	}
	if enable {
		if err := s.repo.UpdateAccountPreferences(account.UserID, true, account.AutoStart); err != nil {
			return err
		}
	}
	if err := s.configureSidecar(settings); err != nil {
		return err
	}
	return s.callSidecar(http.MethodPost, s.sessionPath(account.UserID)+"/start", nil, nil)
}

func (s *WhatsAppService) listChatsForAccount(account *model.WhatsAppAccount) ([]model.WhatsAppChat, error) {
	chats := make([]model.WhatsAppChat, 0)
	if err := s.callSidecar(http.MethodGet, s.sessionPath(account.UserID)+"/chats", nil, &chats); err != nil {
		return nil, err
	}
	return chats, nil
}

func (s *WhatsAppService) refreshAccountStatus(account *model.WhatsAppAccount) {
	var status model.WhatsAppStatus
	if err := s.callSidecar(http.MethodGet, s.sessionPath(account.UserID)+"/status", nil, &status); err != nil {
		account.LastError = err.Error()
		return
	}
	account.QRDataURL, account.LoadingPercent, account.LoadingMessage = status.QRDataURL, status.LoadingPercent, status.LoadingMessage
	account.Status, account.LastError = status.Status, status.LastError
	s.applyRuntimeSnapshot(account.UserID, status.Status, status.Account, status.LastError)
	if refreshed, err := s.repo.GetAccountByUserID(account.UserID); err == nil {
		qr, progress, loading := account.QRDataURL, account.LoadingPercent, account.LoadingMessage
		*account = *refreshed
		account.QRDataURL, account.LoadingPercent, account.LoadingMessage = qr, progress, loading
	}
}

func (s *WhatsAppService) applyRuntimeSnapshot(userID int64, status string, raw map[string]interface{}, lastError string) {
	stringValue := func(key string) string {
		value, _ := raw[key].(string)
		return strings.TrimSpace(value)
	}
	wid := stringValue("wid")
	phone := strings.Split(wid, "@")[0]
	if err := s.repo.UpdateAccountRuntime(userID, status, wid, stringValue("pushname"), phone,
		stringValue("profilePicUrl"), stringValue("about"), stringValue("platform"), lastError); err != nil {
		fmt.Printf("WhatsApp account runtime update failed for user %d: %v\n", userID, err)
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
	return s.callSidecar(http.MethodPost, "/configure", map[string]interface{}{"proxyUrl": proxyURL}, nil)
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
	proxyURL := &url.URL{Scheme: settings.ProxyType, Host: fmt.Sprintf("%s:%d", strings.TrimSpace(settings.ProxyHost), settings.ProxyPort)}
	if settings.ProxyUsername != "" {
		proxyURL.User = url.UserPassword(settings.ProxyUsername, password)
	}
	return proxyURL.String(), nil
}

func (s *WhatsAppService) sessionPath(userID int64) string {
	return "/sessions/" + whatsAppSessionID(userID)
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
	return base64.RawURLEncoding.EncodeToString(gcm.Seal(nonce, nonce, []byte(value), nil)), nil
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

func parseStoredBool(value string) bool { parsed, _ := strconv.ParseBool(value); return parsed }

func normalizeWhatsAppProxyType(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "http", "https", "socks5":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "none"
	}
}

func whatsAppSessionID(userID int64) string { return fmt.Sprintf("user-%d", userID) }

func parseWhatsAppSessionUserID(sessionID string) (int64, error) {
	if !strings.HasPrefix(sessionID, "user-") {
		return 0, fmt.Errorf("invalid WhatsApp session")
	}
	userID, err := strconv.ParseInt(strings.TrimPrefix(sessionID, "user-"), 10, 64)
	if err != nil || userID <= 0 {
		return 0, fmt.Errorf("invalid WhatsApp session")
	}
	return userID, nil
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
