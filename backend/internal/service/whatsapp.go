package service

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"sort"
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
	Ack       *int   `json:"ack,omitempty"`
}

type whatsAppAvatarPayload struct {
	Data      string `json:"data"`
	Mimetype  string `json:"mimetype"`
	SourceURL string `json:"sourceUrl"`
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
	Type                string             `json:"type"`
	Timestamp           int64              `json:"timestamp"`
	HasMedia            bool               `json:"hasMedia"`
	Ack                 *int               `json:"ack,omitempty"`
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
	s.attachAccountAvatarURL(account)
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
		s.attachAccountAvatarURL(&accounts[index])
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
	chats, err := s.listChatsForAccount(account)
	if err != nil {
		return nil, err
	}
	for index := range chats {
		if strings.TrimSpace(chats[index].ProfilePicURL) != "" {
			chats[index].ProfilePicURL = s.avatarProxyURL(account.UserID, chats[index].ID)
		}
	}
	return chats, nil
}

func (s *WhatsAppService) SyncChannelHistory(userID, channelID int64, request *model.WhatsAppHistorySyncRequest) (*model.WhatsAppHistorySyncResult, error) {
	if err := s.requireChannelManage(userID, channelID); err != nil {
		return nil, err
	}
	link, err := s.repo.GetChannelLink(channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("当前频道尚未关联 WhatsApp 会话")
	}
	if err != nil {
		return nil, err
	}
	account, err := s.repo.GetAccountByID(link.WhatsAppAccountID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureAccountReady(account); err != nil {
		return nil, err
	}
	limit := 200
	if request != nil && request.Limit > 0 {
		limit = request.Limit
	}
	if limit > 500 {
		limit = 500
	}
	var history []whatsAppIncomingMessage
	path := s.sessionPath(account.UserID) + "/chats/" + url.PathEscape(link.WhatsAppChatID) + "/messages?limit=" + strconv.Itoa(limit) + "&includeMedia=1"
	if err := s.callSidecarWithTimeout(http.MethodGet, path, nil, &history, 60*time.Second); err != nil {
		return nil, err
	}
	sort.SliceStable(history, func(i, j int) bool { return history[i].Timestamp < history[j].Timestamp })
	result := &model.WhatsAppHistorySyncResult{Total: len(history)}
	for _, incoming := range history {
		externalID := strings.TrimSpace(incoming.ID)
		if externalID == "" {
			result.Skipped++
			continue
		}
		exists, err := s.repo.HasWhatsAppMessage(account.ID, externalID)
		if err != nil {
			return nil, err
		}
		if exists {
			result.Skipped++
			continue
		}
		content := strings.TrimSpace(incoming.Body)
		var attachmentID *int64
		uploaderID := account.UserID
		if !incoming.FromMe && link.CreatedBy > 0 {
			uploaderID = link.CreatedBy
		}
		if incoming.Media != nil && incoming.Media.Data != "" {
			data, decodeErr := base64.StdEncoding.DecodeString(incoming.Media.Data)
			if decodeErr != nil {
				return nil, decodeErr
			}
			if len(data) > whatsappMaxSendBytes {
				content = strings.TrimSpace(content + "\n[WhatsApp 历史附件超过 25MB，未自动保存]")
			} else {
				filename := sanitizeWhatsAppFilename(incoming.Media.Filename)
				attachment, _, uploadErr := s.uploadSvc.UploadBytes(filename, incoming.Media.Mimetype, data, uploaderID)
				if uploadErr != nil {
					return nil, uploadErr
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
		if content == "" && incoming.HasMedia {
			content = whatsAppHistoryMediaLabel(incoming.Type)
		}
		if content == "" {
			content = "[WhatsApp 历史消息]"
		}
		createdAt := time.Now()
		if incoming.Timestamp > 0 {
			createdAt = time.Unix(incoming.Timestamp, 0)
		}
		message := &model.ChannelMessage{ChannelID: channelID, Content: content, AttachmentID: attachmentID, CreatedAt: createdAt}
		direction := "inbound"
		if incoming.FromMe {
			direction = "outbound"
			message.SenderID = account.UserID
			message.SenderType = "user"
		} else {
			message.SenderType = "whatsapp"
			senderName := whatsAppFirstNonEmpty(incoming.SenderName, incoming.Author, incoming.From, link.WhatsAppChatName, "WhatsApp 联系人")
			senderAddress := whatsAppFirstNonEmpty(incoming.SenderNumber, incoming.Author, incoming.From)
			message.ExternalSenderName = &senderName
			if senderAddress != "" {
				message.ExternalSenderAddress = &senderAddress
			}
			if strings.TrimSpace(incoming.SenderProfilePicURL) != "" {
				avatar := s.avatarProxyURL(account.UserID, whatsAppFirstNonEmpty(incoming.Author, incoming.From, link.WhatsAppChatID))
				message.ExternalSenderAvatar = &avatar
			}
		}
		if quotedID := strings.TrimSpace(incoming.QuotedMessageID); quotedID != "" {
			message.ReplyExternalMessageID = &quotedID
			if internalID, lookupErr := s.repo.ChannelMessageID(account.ID, quotedID); lookupErr == nil {
				message.ReplyToMessageID = &internalID
			}
			if quotedSender := strings.TrimSpace(incoming.QuotedSenderName); quotedSender != "" {
				message.ReplySnapshotSender = &quotedSender
			}
			if quotedContent := strings.TrimSpace(incoming.QuotedMessageBody); quotedContent != "" {
				message.ReplySnapshotContent = &quotedContent
			}
		}
		if err := s.repo.CreateSyncedMessage(message, account.ID, externalID, direction, incoming.Ack); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				result.Skipped++
				continue
			}
			return nil, err
		}
		result.Imported++
	}
	if result.Imported > 0 {
		_ = s.repo.TouchChannel(channelID)
		if s.inboundHook != nil {
			s.inboundHook(&model.ChannelMessage{ChannelID: channelID})
		}
	}
	return result, nil
}

func (s *WhatsAppService) SyncContactsToChannels(userID int64, request *model.WhatsAppContactSyncRequest) (*model.WhatsAppContactSyncResult, error) {
	accountID := int64(0)
	limit := 500
	if request != nil {
		accountID = request.WhatsAppAccountID
		if request.Limit > 0 {
			limit = request.Limit
		}
	}
	if limit > 2000 {
		limit = 2000
	}
	account, err := s.accountByIDForAccess(userID, accountID)
	if err != nil {
		return nil, err
	}
	if err := s.ensureAccountReady(account); err != nil {
		return nil, err
	}
	contacts := make([]model.WhatsAppContact, 0)
	path := s.sessionPath(account.UserID) + "/contacts?basic=0&limit=" + strconv.Itoa(limit)
	if err := s.callSidecarWithTimeout(http.MethodGet, path, nil, &contacts, 60*time.Second); err != nil {
		return nil, err
	}
	result := &model.WhatsAppContactSyncResult{Total: len(contacts), Channels: []int64{}, Errors: []string{}}
	for _, contact := range contacts {
		contactID := strings.TrimSpace(contact.ID)
		if contactID == "" || contactID == account.WhatsAppID {
			result.Skipped++
			continue
		}
		if existingLink, err := s.repo.FindChannelLink(account.ID, contactID); err == nil {
			existingLink.WhatsAppChatName = truncateWhatsAppChannelName(whatsAppFirstNonEmpty(contact.Name, contact.Number, contactID))
			existingLink.WhatsAppChatAvatarURL = contact.ProfilePicURL
			_ = s.repo.UpsertChannelLink(existingLink)
			if strings.TrimSpace(contact.ProfilePicURL) != "" {
				if channel, channelErr := s.channelRepo.GetChannel(existingLink.ChannelID, account.UserID); channelErr == nil && channel.AvatarAttachmentID == nil {
					if avatarErr := s.syncWhatsAppChannelAvatar(account, existingLink.ChannelID, contactID, existingLink.WhatsAppChatName); avatarErr != nil {
						result.Errors = appendWhatsAppSyncError(result.Errors, existingLink.WhatsAppChatName+" 头像", avatarErr)
					}
				}
			}
			result.Skipped++
			continue
		} else if !errors.Is(err, sql.ErrNoRows) {
			result.Failed++
			result.Errors = appendWhatsAppSyncError(result.Errors, contact.Name, err)
			continue
		}
		channelName := truncateWhatsAppChannelName(whatsAppFirstNonEmpty(contact.Name, contact.Number, contactID))
		descriptionText := "WhatsApp 客户"
		if strings.TrimSpace(contact.Number) != "" {
			descriptionText += " · " + strings.TrimSpace(contact.Number)
		}
		channel := &model.Channel{Name: channelName, Description: &descriptionText, OwnerID: account.UserID, ChannelType: "group"}
		if err := s.channelRepo.CreateChannel(channel); err != nil {
			result.Failed++
			result.Errors = appendWhatsAppSyncError(result.Errors, channelName, err)
			continue
		}
		link := &model.WhatsAppChannelLink{
			ChannelID: channel.ID, WhatsAppAccountID: account.ID, WhatsAppUserID: account.UserID,
			WhatsAppUsername: account.Username, WhatsAppDisplayName: account.DisplayName,
			WhatsAppChatID: contactID, WhatsAppChatName: channelName, WhatsAppChatAvatarURL: contact.ProfilePicURL,
			SyncInbound: true, SyncOutbound: true, CreatedBy: userID,
		}
		if err := s.repo.UpsertChannelLink(link); err != nil {
			_ = s.channelRepo.DeleteChannel(channel.ID)
			result.Failed++
			result.Errors = appendWhatsAppSyncError(result.Errors, channelName, err)
			continue
		}
		if strings.TrimSpace(contact.ProfilePicURL) != "" {
			if avatarErr := s.syncWhatsAppChannelAvatar(account, channel.ID, contactID, channelName); avatarErr != nil {
				result.Errors = appendWhatsAppSyncError(result.Errors, channelName+" 头像", avatarErr)
			}
		}
		result.Created++
		result.Channels = append(result.Channels, channel.ID)
	}
	return result, nil
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
	if err == nil {
		s.attachChannelLinkAvatarURL(link)
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
	if strings.TrimSpace(link.WhatsAppChatAvatarURL) != "" {
		link.WhatsAppChatAvatarURL = s.avatarProxyURL(account.UserID, selected.ID)
	}
	if err := s.repo.UpsertChannelLink(link); err != nil {
		return nil, err
	}
	channel, channelErr := s.channelRepo.GetChannel(channelID, userID)
	if channelErr == nil && channel.AvatarAttachmentID == nil && strings.TrimSpace(selected.ProfilePicURL) != "" {
		_ = s.syncWhatsAppChannelAvatar(account, channelID, selected.ID, selected.Name)
	}
	return s.GetChannelLink(userID, channelID)
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
		messageID, channelID, err := s.repo.UpdateMessageAck(account.ID, ack.ID, ack.Ack)
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if s.inboundHook != nil {
			s.inboundHook(&model.ChannelMessage{ID: messageID, ChannelID: channelID})
		}
		return nil
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
		avatar = s.avatarProxyURL(account.UserID, whatsAppFirstNonEmpty(incoming.Author, incoming.From, link.WhatsAppChatID))
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
		_ = s.repo.RecordMessageLink(link.WhatsAppAccountID, message.ID, sent.ID, "outbound", sent.Ack)
		if s.inboundHook != nil {
			s.inboundHook(&model.ChannelMessage{ID: message.ID, ChannelID: message.ChannelID})
		}
	}
	return sent, nil
}

func (s *WhatsAppService) MarkOwnChatRead(requesterID int64, chatID string) error {
	account, err := s.accountForAccess(requesterID, requesterID)
	if err != nil {
		return err
	}
	return s.markChatRead(account, strings.TrimSpace(chatID), true)
}

func (s *WhatsAppService) MarkChannelSeen(userID, channelID int64) error {
	link, err := s.repo.GetChannelLink(channelID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	pending, err := s.repo.HasUnreadInboundChat(link.WhatsAppAccountID, link.WhatsAppChatID)
	if err != nil || !pending {
		return err
	}
	account, err := s.repo.GetAccountByID(link.WhatsAppAccountID)
	if err != nil {
		return err
	}
	return s.markChatRead(account, link.WhatsAppChatID, false)
}

func (s *WhatsAppService) markChatRead(account *model.WhatsAppAccount, chatID string, force bool) error {
	if account == nil || strings.TrimSpace(chatID) == "" {
		return fmt.Errorf("WhatsApp 会话不能为空")
	}
	if !force {
		pending, err := s.repo.HasUnreadInboundChat(account.ID, chatID)
		if err != nil || !pending {
			return err
		}
	}
	payload := map[string]string{"action": "seen"}
	if err := s.callSidecar(http.MethodPost, s.sessionPath(account.UserID)+"/chats/"+url.PathEscape(chatID)+"/action", payload, nil); err != nil {
		return err
	}
	channelIDs, err := s.repo.MarkInboundChatRead(account.ID, chatID)
	if err != nil {
		return err
	}
	if s.inboundHook != nil {
		for _, channelID := range channelIDs {
			s.inboundHook(&model.ChannelMessage{ChannelID: channelID})
		}
	}
	return nil
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
	if err := s.ensureAccountReady(account); err != nil {
		return nil, err
	}
	chats := make([]model.WhatsAppChat, 0)
	if err := s.callSidecarWithTimeout(http.MethodGet, s.sessionPath(account.UserID)+"/chats?metadata=1", nil, &chats, 45*time.Second); err != nil {
		return nil, err
	}
	return chats, nil
}

func (s *WhatsAppService) attachAccountAvatarURL(account *model.WhatsAppAccount) {
	if account == nil || strings.TrimSpace(account.ProfilePicURL) == "" || strings.TrimSpace(account.WhatsAppID) == "" {
		return
	}
	account.ProfilePicURL = s.avatarProxyURL(account.UserID, account.WhatsAppID)
}

func (s *WhatsAppService) attachChannelLinkAvatarURL(link *model.WhatsAppChannelLink) {
	if link == nil || strings.TrimSpace(link.WhatsAppChatAvatarURL) == "" || link.WhatsAppUserID <= 0 {
		return
	}
	link.WhatsAppChatAvatarURL = s.avatarProxyURL(link.WhatsAppUserID, link.WhatsAppChatID)
}

func (s *WhatsAppService) avatarProxyURL(userID int64, chatID string) string {
	chatID = strings.TrimSpace(chatID)
	if userID <= 0 || chatID == "" {
		return ""
	}
	expires := time.Now().Add(24 * time.Hour).Unix()
	signature := s.signAvatarRequest(userID, chatID, expires)
	return fmt.Sprintf("/api/whatsapp/avatar/%d/%s?expires=%d&signature=%s", userID, url.PathEscape(chatID), expires, signature)
}

func (s *WhatsAppService) signAvatarRequest(userID int64, chatID string, expires int64) string {
	mac := hmac.New(sha256.New, s.encryptionKey[:])
	_, _ = fmt.Fprintf(mac, "%d|%s|%d", userID, chatID, expires)
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *WhatsAppService) GetAvatar(userID int64, chatID string, expires int64, signature string) ([]byte, string, error) {
	chatID = strings.TrimSpace(chatID)
	if userID <= 0 || chatID == "" || expires < time.Now().Unix() || expires > time.Now().Add(48*time.Hour).Unix() {
		return nil, "", fmt.Errorf("avatar link expired")
	}
	expected, err := hex.DecodeString(s.signAvatarRequest(userID, chatID, expires))
	if err != nil {
		return nil, "", err
	}
	provided, err := hex.DecodeString(strings.TrimSpace(signature))
	if err != nil || !hmac.Equal(expected, provided) {
		return nil, "", fmt.Errorf("invalid avatar signature")
	}
	avatar, err := s.downloadWhatsAppAvatar(userID, chatID)
	if err != nil {
		return nil, "", err
	}
	data, err := base64.StdEncoding.DecodeString(avatar.Data)
	if err != nil {
		return nil, "", err
	}
	if len(data) == 0 || len(data) > 5*1024*1024 {
		return nil, "", fmt.Errorf("invalid avatar data")
	}
	mimeType := strings.TrimSpace(avatar.Mimetype)
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		mimeType = "image/jpeg"
	}
	return data, mimeType, nil
}

func (s *WhatsAppService) downloadWhatsAppAvatar(userID int64, chatID string) (*whatsAppAvatarPayload, error) {
	var avatar whatsAppAvatarPayload
	path := s.sessionPath(userID) + "/avatars/" + url.PathEscape(strings.TrimSpace(chatID))
	if err := s.callSidecarWithTimeout(http.MethodGet, path, nil, &avatar, 20*time.Second); err != nil {
		return nil, err
	}
	if strings.TrimSpace(avatar.Data) == "" {
		return nil, fmt.Errorf("WhatsApp 头像不可用")
	}
	return &avatar, nil
}

func (s *WhatsAppService) syncWhatsAppChannelAvatar(account *model.WhatsAppAccount, channelID int64, chatID, name string) error {
	if account == nil || channelID <= 0 {
		return fmt.Errorf("invalid WhatsApp channel avatar target")
	}
	avatar, err := s.downloadWhatsAppAvatar(account.UserID, chatID)
	if err != nil {
		return err
	}
	data, err := base64.StdEncoding.DecodeString(avatar.Data)
	if err != nil {
		return err
	}
	if len(data) == 0 || len(data) > 5*1024*1024 {
		return fmt.Errorf("WhatsApp 头像数据无效")
	}
	mimeType := strings.TrimSpace(avatar.Mimetype)
	if !strings.HasPrefix(strings.ToLower(mimeType), "image/") {
		mimeType = "image/jpeg"
	}
	extension := ".jpg"
	if strings.Contains(strings.ToLower(mimeType), "png") {
		extension = ".png"
	} else if strings.Contains(strings.ToLower(mimeType), "webp") {
		extension = ".webp"
	}
	filename := sanitizeWhatsAppFilename(whatsAppFirstNonEmpty(name, chatID, "whatsapp-avatar") + extension)
	attachment, _, err := s.uploadSvc.UploadBytes(filename, mimeType, data, account.UserID)
	if err != nil {
		return err
	}
	if err := s.channelRepo.UpdateChannelAvatar(channelID, &attachment.ID); err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return err
	}
	return nil
}

func (s *WhatsAppService) ensureAccountReady(account *model.WhatsAppAccount) error {
	s.refreshAccountStatus(account)
	if account.Status != "ready" {
		return fmt.Errorf("WhatsApp 账号尚未连接，请先扫码登录并等待状态变为已连接")
	}
	return nil
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
	return s.callSidecarWithTimeout(method, path, input, output, 90*time.Second)
}

func (s *WhatsAppService) callSidecarWithTimeout(method, path string, input, output interface{}, timeout time.Duration) error {
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
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
		if response.StatusCode == http.StatusConflict && strings.Contains(strings.ToLower(payload.Error), "not ready") {
			return fmt.Errorf("WhatsApp 账号尚未连接，请先扫码登录并等待状态变为已连接")
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

func whatsAppHistoryMediaLabel(messageType string) string {
	switch strings.ToLower(strings.TrimSpace(messageType)) {
	case "image", "sticker":
		return "[WhatsApp 历史图片]"
	case "video":
		return "[WhatsApp 历史视频]"
	case "audio", "ptt":
		return "[WhatsApp 历史语音]"
	case "document":
		return "[WhatsApp 历史文件]"
	default:
		return "[WhatsApp 历史附件]"
	}
}

func truncateWhatsAppChannelName(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		trimmed = "WhatsApp 客户"
	}
	runes := []rune(trimmed)
	if len(runes) > 128 {
		return string(runes[:128])
	}
	return trimmed
}

func appendWhatsAppSyncError(items []string, name string, err error) []string {
	if len(items) >= 10 {
		return items
	}
	return append(items, fmt.Sprintf("%s: %v", whatsAppFirstNonEmpty(name, "WhatsApp 联系人"), err))
}
