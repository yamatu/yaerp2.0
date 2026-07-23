package service

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"html"
	"io"
	"net"
	stdmail "net/mail"
	"net/smtp"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	gomail "github.com/emersion/go-message/mail"
	"github.com/microcosm-cc/bluemonday"
	"golang.org/x/net/proxy"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const (
	mailConnectionTimeout = 20 * time.Second
	mailMaxRawMessageSize = 64 << 20
)

var (
	ErrMailNotConfigured        = errors.New("邮件服务器尚未配置")
	ErrMailDisabled             = errors.New("邮件服务尚未启用")
	ErrMailAccountNotConfigured = errors.New("当前员工尚未绑定邮箱")
	ErrMailAccessDenied         = errors.New("没有权限管理邮件配置")
	ErrMailMessageNotFound      = errors.New("邮件不存在或已被移动")
)

type MailOutgoingAttachment struct {
	Filename    string
	ContentType string
	Data        []byte
}

type MailService struct {
	repo          *repo.MailRepo
	permSvc       *PermissionService
	aiSvc         *AIService
	tradeSvc      *TradeService
	encryptionKey [32]byte
	htmlPolicy    *bluemonday.Policy
}

type mailSession struct {
	settings *model.MailServerSettings
	account  *model.MailAccount
	password string
}

func (s *MailService) SetAIService(aiSvc *AIService) { s.aiSvc = aiSvc }

func (s *MailService) SetTradeService(tradeSvc *TradeService) { s.tradeSvc = tradeSvc }

func NewMailService(mailRepo *repo.MailRepo, permSvc *PermissionService, encryptionSecret string) *MailService {
	policy := bluemonday.UGCPolicy()
	policy.AllowDataURIImages()
	return &MailService{
		repo:          mailRepo,
		permSvc:       permSvc,
		encryptionKey: sha256.Sum256([]byte(encryptionSecret + ":mail-account")),
		htmlPolicy:    policy,
	}
}

func (s *MailService) GetSettings(userID int64) (*model.MailServerSettings, error) {
	if err := s.requireAdmin(userID); err != nil {
		return nil, err
	}
	return s.repo.GetSettings()
}

func (s *MailService) UpdateSettings(userID int64, input *model.MailServerSettings) (*model.MailServerSettings, error) {
	if err := s.requireAdmin(userID); err != nil {
		return nil, err
	}
	if input == nil {
		return nil, fmt.Errorf("邮件服务器配置不能为空")
	}
	current, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	settings := *input
	settings.IMAPHost = normalizeMailHost(settings.IMAPHost)
	settings.SMTPHost = normalizeMailHost(settings.SMTPHost)
	settings.DefaultDomain = strings.TrimSpace(strings.ToLower(settings.DefaultDomain))
	settings.IMAPSecurity = normalizeMailSecurity(settings.IMAPSecurity)
	settings.SMTPSecurity = normalizeMailSecurity(settings.SMTPSecurity)
	settings.ProxyType = normalizeMailProxyType(settings.ProxyType)
	settings.ProxyHost = normalizeMailHost(settings.ProxyHost)
	settings.ProxyUsername = strings.TrimSpace(settings.ProxyUsername)
	if settings.IMAPPort == 0 {
		settings.IMAPPort = 993
	}
	if settings.SMTPPort == 0 {
		settings.SMTPPort = 465
	}
	if settings.MaxAttachmentMB == 0 {
		settings.MaxAttachmentMB = 25
	}
	settings.ProxyPasswordEncrypted = current.ProxyPasswordEncrypted
	if settings.ProxyType == "none" {
		settings.ProxyHost = ""
		settings.ProxyPort = 0
		settings.ProxyUsername = ""
		settings.ProxyPasswordEncrypted = ""
	} else if settings.ProxyPassword != "" {
		settings.ProxyPasswordEncrypted, err = s.encryptSecret(settings.ProxyPassword)
		if err != nil {
			return nil, err
		}
	} else if !settings.ProxyPasswordConfigured {
		settings.ProxyPasswordEncrypted = ""
	}
	if err := validateMailSettings(&settings); err != nil {
		return nil, err
	}
	if err := s.repo.UpdateSettings(userID, &settings); err != nil {
		return nil, err
	}
	return s.repo.GetSettings()
}

func (s *MailService) ListAccounts(userID int64) ([]model.MailAccount, error) {
	if err := s.requireAdmin(userID); err != nil {
		return nil, err
	}
	return s.repo.ListAccounts()
}

func (s *MailService) GetOwnAccount(userID int64) (*model.MailAccount, error) {
	account, err := s.repo.GetAccount(userID)
	if repo.IsMailAccountMissing(err) {
		return nil, nil
	}
	return account, err
}

func (s *MailService) SaveOwnAccount(userID int64, input *model.MailAccountInput) (*model.MailAccount, error) {
	settings, err := s.activeSettings()
	if err != nil {
		return nil, err
	}
	account, password, err := s.accountFromInput(userID, input)
	if err != nil {
		return nil, err
	}
	if err := s.verifyConnections(settings, account, password); err != nil {
		return nil, err
	}
	encrypted, err := s.encryptSecret(password)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	account.PasswordEncrypted = encrypted
	account.PasswordConfigured = true
	account.LastVerifiedAt = &now
	account.LastError = ""
	if account.AutoForwardEnabled && account.ForwardUIDValidity == 0 {
		uidValidity, lastUID, cursorErr := s.currentInboxCursor(settings, account, password)
		if cursorErr != nil {
			return nil, fmt.Errorf("自动转发初始化失败: %w", cursorErr)
		}
		account.ForwardUIDValidity = uidValidity
		account.ForwardLastUID = lastUID
	}
	if err := s.repo.UpsertAccount(account); err != nil {
		return nil, err
	}
	return s.repo.GetAccount(userID)
}

func (s *MailService) TestOwnAccount(userID int64, input *model.MailAccountInput) (*model.MailConnectionTest, error) {
	settings, err := s.activeSettings()
	if err != nil {
		return nil, err
	}
	account, password, err := s.accountFromInput(userID, input)
	if err != nil {
		return nil, err
	}
	result := &model.MailConnectionTest{}
	imapConn, err := s.connectIMAP(settings, account.LoginUsername, password)
	if err != nil {
		result.Message = "IMAP 连接失败: " + cleanMailError(err)
		return result, fmt.Errorf("%s", result.Message)
	}
	result.IMAPConnected = true
	_ = imapConn.Logout()
	smtpConn, err := s.connectSMTP(settings, account.LoginUsername, password)
	if err != nil {
		result.Message = "SMTP 连接失败: " + cleanMailError(err)
		return result, fmt.Errorf("%s", result.Message)
	}
	result.SMTPConnected = true
	result.Message = "IMAP 收件与 SMTP 发件连接均正常"
	_ = smtpConn.Quit()
	return result, nil
}

func (s *MailService) DeleteOwnAccount(userID int64) error {
	err := s.repo.DeleteAccount(userID)
	if repo.IsMailAccountMissing(err) {
		return nil
	}
	return err
}

func (s *MailService) Summary(userID int64) (*model.MailSummary, error) {
	settings, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	account, err := s.repo.GetAccount(userID)
	if repo.IsMailAccountMissing(err) {
		return &model.MailSummary{Configured: false, Enabled: settings.Enabled}, nil
	}
	if err != nil {
		return nil, err
	}
	result := &model.MailSummary{Configured: true, Enabled: settings.Enabled && account.Enabled, Address: account.EmailAddress, LastError: account.LastError}
	if !settings.Enabled || !account.Enabled || !settings.Configured {
		return result, nil
	}
	password, err := s.decryptSecret(account.PasswordEncrypted)
	if err != nil {
		return nil, err
	}
	conn, err := s.connectIMAP(settings, account.LoginUsername, password)
	if err != nil {
		_ = s.repo.UpdateAccountStatus(userID, false, false, cleanMailError(err))
		result.LastError = cleanMailError(err)
		return result, nil
	}
	defer conn.Logout()
	status, err := conn.Status(imap.InboxName, []imap.StatusItem{imap.StatusMessages, imap.StatusUnseen})
	if err != nil {
		_ = s.repo.UpdateAccountStatus(userID, false, false, cleanMailError(err))
		result.LastError = cleanMailError(err)
		return result, nil
	}
	result.Total = status.Messages
	result.Unread = status.Unseen
	result.LastError = ""
	_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	return result, nil
}

func (s *MailService) ListFolders(userID int64) ([]model.MailFolder, error) {
	session, err := s.sessionForUser(userID)
	if err != nil {
		return nil, err
	}
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	defer conn.Logout()
	folders, err := listMailFolders(conn)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	return folders, nil
}

func (s *MailService) CreateFolder(userID int64, name string) error {
	name, err := validateMailFolderName(name)
	if err != nil {
		return err
	}
	return s.withIMAP(userID, func(conn *imapclient.Client) error { return conn.Create(name) })
}

func (s *MailService) RenameFolder(userID int64, from, to string) error {
	from, err := validateMailFolderName(from)
	if err != nil {
		return err
	}
	to, err = validateMailFolderName(to)
	if err != nil {
		return err
	}
	if protectedMailFolder(from) {
		return fmt.Errorf("系统邮件文件夹不能重命名")
	}
	return s.withIMAP(userID, func(conn *imapclient.Client) error { return conn.Rename(from, to) })
}

func (s *MailService) DeleteFolder(userID int64, name string) error {
	name, err := validateMailFolderName(name)
	if err != nil {
		return err
	}
	if protectedMailFolder(name) {
		return fmt.Errorf("系统邮件文件夹不能删除")
	}
	return s.withIMAP(userID, func(conn *imapclient.Client) error { return conn.Delete(name) })
}

func (s *MailService) UpdateFlags(userID int64, uid uint32, input *model.MailFlagInput) error {
	if uid == 0 || input == nil {
		return fmt.Errorf("无效的邮件标识")
	}
	folder, err := validateMailFolderName(input.Folder)
	if err != nil {
		return err
	}
	return s.withSelectedMailbox(userID, folder, false, func(conn *imapclient.Client) error {
		seqset := new(imap.SeqSet)
		seqset.AddNum(uid)
		if input.Read != nil {
			if err := updateMailFlag(conn, seqset, imap.SeenFlag, *input.Read); err != nil {
				return err
			}
		}
		if input.Starred != nil {
			if err := updateMailFlag(conn, seqset, imap.FlaggedFlag, *input.Starred); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *MailService) MoveMessage(userID int64, uid uint32, input *model.MailMoveInput) error {
	if uid == 0 || input == nil {
		return fmt.Errorf("无效的邮件标识")
	}
	folder, err := validateMailFolderName(input.Folder)
	if err != nil {
		return err
	}
	destination, err := validateMailFolderName(input.Destination)
	if err != nil {
		return err
	}
	return s.withSelectedMailbox(userID, folder, false, func(conn *imapclient.Client) error {
		seqset := new(imap.SeqSet)
		seqset.AddNum(uid)
		return conn.UidMove(seqset, destination)
	})
}

func (s *MailService) DeleteMessage(userID int64, uid uint32, folder string) error {
	return s.BatchMessages(userID, &model.MailBatchInput{Folder: folder, Action: "delete", UIDs: []uint32{uid}})
}

func (s *MailService) BatchMessages(userID int64, input *model.MailBatchInput) error {
	if input == nil || len(input.UIDs) == 0 || len(input.UIDs) > 500 {
		return fmt.Errorf("请选择 1 到 500 封邮件")
	}
	folder, err := validateMailFolderName(input.Folder)
	if err != nil {
		return err
	}
	seqset := new(imap.SeqSet)
	for _, uid := range input.UIDs {
		if uid == 0 {
			return fmt.Errorf("邮件标识无效")
		}
		seqset.AddNum(uid)
	}
	action := strings.ToLower(strings.TrimSpace(input.Action))
	return s.withSelectedMailbox(userID, folder, false, func(conn *imapclient.Client) error {
		switch action {
		case "read":
			return updateMailFlag(conn, seqset, imap.SeenFlag, true)
		case "unread":
			return updateMailFlag(conn, seqset, imap.SeenFlag, false)
		case "star":
			return updateMailFlag(conn, seqset, imap.FlaggedFlag, true)
		case "unstar":
			return updateMailFlag(conn, seqset, imap.FlaggedFlag, false)
		case "move":
			destination, validateErr := validateMailFolderName(input.Destination)
			if validateErr != nil {
				return validateErr
			}
			if strings.EqualFold(folder, destination) {
				return nil
			}
			return conn.UidMove(seqset, destination)
		case "delete":
			folders, _ := listMailFolders(conn)
			trash := folderForRole(folders, "trash")
			if trash != "" && !strings.EqualFold(folder, trash) {
				return conn.UidMove(seqset, trash)
			}
			if flagErr := updateMailFlag(conn, seqset, imap.DeletedFlag, true); flagErr != nil {
				return flagErr
			}
			return conn.Expunge(nil)
		default:
			return fmt.Errorf("不支持的批量邮件操作")
		}
	})
}

func (s *MailService) SendMessage(userID int64, input *model.MailSendInput, attachments []MailOutgoingAttachment) (*model.MailSendResult, error) {
	if input == nil {
		return nil, fmt.Errorf("邮件内容不能为空")
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return nil, err
	}
	to, toEnvelope, err := parseMailAddresses(input.To)
	if err != nil || len(to) == 0 {
		return nil, fmt.Errorf("请填写有效的收件人邮箱")
	}
	cc, ccEnvelope, err := parseMailAddresses(input.CC)
	if err != nil {
		return nil, fmt.Errorf("抄送地址无效: %w", err)
	}
	bcc, bccEnvelope, err := parseMailAddresses(input.BCC)
	if err != nil {
		return nil, fmt.Errorf("密送地址无效: %w", err)
	}
	maxBytes := int64(session.settings.MaxAttachmentMB) << 20
	var total int64
	for index := range attachments {
		attachments[index].Filename = sanitizeMailFilename(attachments[index].Filename)
		if attachments[index].Filename == "" {
			attachments[index].Filename = fmt.Sprintf("attachment-%d", index+1)
		}
		total += int64(len(attachments[index].Data))
		if int64(len(attachments[index].Data)) > maxBytes {
			return nil, fmt.Errorf("附件 %s 超过 %dMB 限制", attachments[index].Filename, session.settings.MaxAttachmentMB)
		}
	}
	if total > maxBytes {
		return nil, fmt.Errorf("附件总大小超过 %dMB 限制", session.settings.MaxAttachmentMB)
	}
	from := []*gomail.Address{{Name: session.account.DisplayName, Address: session.account.EmailAddress}}
	raw, messageID, sentAt, err := s.buildOutgoingMessage(session, input, from, to, cc, bcc, attachments)
	if err != nil {
		return nil, err
	}
	smtpConn, err := s.connectSMTP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	recipients := append(append(toEnvelope, ccEnvelope...), bccEnvelope...)
	if err := sendSMTPMessage(smtpConn, session.account.EmailAddress, recipients, raw); err != nil {
		_ = smtpConn.Close()
		s.recordFailure(userID, err)
		return nil, err
	}
	_ = smtpConn.Quit()
	if input.SaveToSent {
		if err := s.appendSentMessage(session, raw, sentAt); err != nil {
			_ = s.repo.UpdateAccountStatus(userID, false, true, "邮件已发送，但未能保存到已发送文件夹: "+cleanMailError(err))
		} else {
			_ = s.repo.UpdateAccountStatus(userID, false, true, "")
		}
	} else {
		_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	}
	return &model.MailSendResult{MessageID: messageID, SentAt: sentAt}, nil
}

func (s *MailService) buildOutgoingMessage(session *mailSession, input *model.MailSendInput, from, to, cc, _ []*gomail.Address, attachments []MailOutgoingAttachment) ([]byte, string, time.Time, error) {
	var buffer bytes.Buffer
	var header gomail.Header
	sentAt := time.Now()
	header.SetDate(sentAt)
	header.SetAddressList("From", from)
	header.SetAddressList("To", to)
	header.SetAddressList("Cc", cc)
	header.SetSubject(strings.TrimSpace(input.Subject))
	header.Set("X-Mailer", "YAERP Mail")
	if strings.TrimSpace(input.AutoForwardedBy) != "" {
		header.Set("X-YAERP-Auto-Forwarded", strings.TrimSpace(input.AutoForwardedBy))
	}
	switch strings.ToLower(strings.TrimSpace(input.Priority)) {
	case "high":
		header.Set("X-Priority", "1")
		header.Set("Importance", "high")
	case "low":
		header.Set("X-Priority", "5")
		header.Set("Importance", "low")
	}
	if input.RequestReadReceipt {
		header.Set("Disposition-Notification-To", session.account.EmailAddress)
	}
	hostname := session.settings.DefaultDomain
	if hostname == "" {
		parts := strings.Split(session.account.EmailAddress, "@")
		if len(parts) == 2 {
			hostname = parts[1]
		}
	}
	if hostname == "" {
		hostname = "localhost"
	}
	if err := header.GenerateMessageIDWithHostname(hostname); err != nil {
		return nil, "", time.Time{}, err
	}
	messageID, _ := header.MessageID()
	if strings.TrimSpace(input.InReplyTo) != "" {
		header.SetMsgIDList("In-Reply-To", []string{trimMessageID(input.InReplyTo)})
	}
	refs := make([]string, 0, len(input.References))
	for _, ref := range input.References {
		if value := trimMessageID(ref); value != "" {
			refs = append(refs, value)
		}
	}
	if len(refs) > 0 {
		header.SetMsgIDList("References", refs)
	}
	writer, err := gomail.CreateWriter(&buffer, header)
	if err != nil {
		return nil, "", time.Time{}, err
	}
	inline, err := writer.CreateInline()
	if err != nil {
		return nil, "", time.Time{}, err
	}
	textBody := strings.TrimSpace(input.TextBody)
	htmlBody := strings.TrimSpace(input.HTMLBody)
	if signature := strings.TrimSpace(session.account.SignatureHTML); signature != "" {
		if htmlBody == "" && textBody != "" {
			htmlBody = strings.ReplaceAll(html.EscapeString(textBody), "\n", "<br>")
		}
		htmlBody += "<br><br>" + signature
		if textBody != "" {
			textBody += "\n\n" + bluemonday.StrictPolicy().Sanitize(signature)
		}
	}
	if textBody == "" && htmlBody != "" {
		textBody = bluemonday.StrictPolicy().Sanitize(htmlBody)
	}
	if textBody == "" {
		textBody = " "
	}
	var textHeader gomail.InlineHeader
	textHeader.Set("Content-Type", "text/plain; charset=utf-8")
	textWriter, err := inline.CreatePart(textHeader)
	if err != nil {
		return nil, "", time.Time{}, err
	}
	_, _ = io.WriteString(textWriter, textBody)
	_ = textWriter.Close()
	if htmlBody != "" {
		var htmlHeader gomail.InlineHeader
		htmlHeader.Set("Content-Type", "text/html; charset=utf-8")
		htmlWriter, err := inline.CreatePart(htmlHeader)
		if err != nil {
			return nil, "", time.Time{}, err
		}
		_, _ = io.WriteString(htmlWriter, s.htmlPolicy.Sanitize(htmlBody))
		_ = htmlWriter.Close()
	}
	if err := inline.Close(); err != nil {
		return nil, "", time.Time{}, err
	}
	for _, attachment := range attachments {
		var attachmentHeader gomail.AttachmentHeader
		contentType := strings.TrimSpace(attachment.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		attachmentHeader.Set("Content-Type", contentType)
		attachmentHeader.SetFilename(attachment.Filename)
		attachmentWriter, err := writer.CreateAttachment(attachmentHeader)
		if err != nil {
			return nil, "", time.Time{}, err
		}
		if _, err := attachmentWriter.Write(attachment.Data); err != nil {
			return nil, "", time.Time{}, err
		}
		_ = attachmentWriter.Close()
	}
	if err := writer.Close(); err != nil {
		return nil, "", time.Time{}, err
	}
	return buffer.Bytes(), messageID, sentAt, nil
}

func (s *MailService) sessionForUser(userID int64) (*mailSession, error) {
	settings, err := s.activeSettings()
	if err != nil {
		return nil, err
	}
	account, err := s.repo.GetAccount(userID)
	if repo.IsMailAccountMissing(err) {
		return nil, ErrMailAccountNotConfigured
	}
	if err != nil {
		return nil, err
	}
	if !account.Enabled {
		return nil, fmt.Errorf("当前邮箱账号已停用")
	}
	password, err := s.decryptSecret(account.PasswordEncrypted)
	if err != nil {
		return nil, err
	}
	return &mailSession{settings: settings, account: account, password: password}, nil
}

func (s *MailService) activeSettings() (*model.MailServerSettings, error) {
	settings, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	if !settings.Configured {
		return nil, ErrMailNotConfigured
	}
	if !settings.Enabled {
		return nil, ErrMailDisabled
	}
	return settings, nil
}

func (s *MailService) accountFromInput(userID int64, input *model.MailAccountInput) (*model.MailAccount, string, error) {
	if input == nil {
		input = &model.MailAccountInput{}
	}
	existing, err := s.repo.GetAccount(userID)
	if err != nil && !repo.IsMailAccountMissing(err) {
		return nil, "", err
	}
	emailAddress := strings.TrimSpace(strings.ToLower(input.EmailAddress))
	if emailAddress == "" && existing != nil {
		emailAddress = existing.EmailAddress
	}
	parsed, err := stdmail.ParseAddress(emailAddress)
	if err != nil || !strings.Contains(parsed.Address, "@") {
		return nil, "", fmt.Errorf("请输入有效的邮箱地址")
	}
	emailAddress = strings.ToLower(parsed.Address)
	loginUsername := strings.TrimSpace(input.LoginUsername)
	if loginUsername == "" {
		loginUsername = emailAddress
	}
	password := input.Password
	if password == "" && existing != nil {
		password, err = s.decryptSecret(existing.PasswordEncrypted)
		if err != nil {
			return nil, "", err
		}
	}
	if password == "" {
		return nil, "", fmt.Errorf("请输入邮箱密码")
	}
	enabled := input.Enabled
	if existing == nil && !input.Enabled {
		enabled = true
	}
	account := &model.MailAccount{
		UserID: userID, EmailAddress: emailAddress, DisplayName: strings.TrimSpace(input.DisplayName),
		LoginUsername: loginUsername, SignatureHTML: s.htmlPolicy.Sanitize(input.SignatureHTML), Enabled: enabled,
		AutoForwardEnabled: input.AutoForwardEnabled, ForwardAttachments: input.ForwardAttachments,
	}
	if existing != nil {
		account.ForwardUIDValidity = existing.ForwardUIDValidity
		account.ForwardLastUID = existing.ForwardLastUID
	}
	account.AutoForwardTo, err = normalizeMailForwardAddresses(emailAddress, input.AutoForwardTo)
	if err != nil {
		return nil, "", err
	}
	if account.AutoForwardEnabled && len(account.AutoForwardTo) == 0 {
		return nil, "", fmt.Errorf("启用自动转发后，请至少填写一个转发邮箱")
	}
	if !account.AutoForwardEnabled {
		account.ForwardUIDValidity = 0
		account.ForwardLastUID = 0
	}
	return account, password, nil
}

func (s *MailService) verifyConnections(settings *model.MailServerSettings, account *model.MailAccount, password string) error {
	imapConn, err := s.connectIMAP(settings, account.LoginUsername, password)
	if err != nil {
		return fmt.Errorf("IMAP 登录失败: %w", err)
	}
	_ = imapConn.Logout()
	smtpConn, err := s.connectSMTP(settings, account.LoginUsername, password)
	if err != nil {
		return fmt.Errorf("SMTP 登录失败: %w", err)
	}
	return smtpConn.Quit()
}

func (s *MailService) requireAdmin(userID int64) error {
	isAdmin, err := s.permSvc.IsAdmin(userID)
	if err != nil {
		return err
	}
	if !isAdmin {
		return ErrMailAccessDenied
	}
	return nil
}

func (s *MailService) withIMAP(userID int64, fn func(*imapclient.Client) error) error {
	session, err := s.sessionForUser(userID)
	if err != nil {
		return err
	}
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		s.recordFailure(userID, err)
		return err
	}
	defer conn.Logout()
	if err := fn(conn); err != nil {
		s.recordFailure(userID, err)
		return err
	}
	_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	return nil
}

func (s *MailService) withSelectedMailbox(userID int64, folder string, readOnly bool, fn func(*imapclient.Client) error) error {
	return s.withIMAP(userID, func(conn *imapclient.Client) error {
		if _, err := conn.Select(folder, readOnly); err != nil {
			return err
		}
		return fn(conn)
	})
}

func (s *MailService) recordFailure(userID int64, err error) {
	_ = s.repo.UpdateAccountStatus(userID, false, false, cleanMailError(err))
}

func (s *MailService) connectIMAP(settings *model.MailServerSettings, username, password string) (*imapclient.Client, error) {
	address := net.JoinHostPort(settings.IMAPHost, fmt.Sprintf("%d", settings.IMAPPort))
	tlsConfig := &tls.Config{ServerName: settings.IMAPHost, MinVersion: tls.VersionTLS12, InsecureSkipVerify: settings.AllowInsecureTLS} // #nosec G402 -- explicit administrator option for private poste.io deployments.
	dialer, err := s.mailDialer(settings)
	if err != nil {
		return nil, err
	}
	var conn *imapclient.Client
	if settings.IMAPSecurity == "tls" {
		conn, err = imapclient.DialWithDialerTLS(dialer, address, tlsConfig)
	} else {
		conn, err = imapclient.DialWithDialer(dialer, address)
		if err == nil {
			conn.Timeout = mailConnectionTimeout
			err = conn.StartTLS(tlsConfig)
		}
	}
	if err != nil {
		if conn != nil {
			_ = conn.Terminate()
		}
		return nil, err
	}
	conn.Timeout = mailConnectionTimeout
	if err := conn.Login(username, password); err != nil {
		_ = conn.Terminate()
		return nil, err
	}
	return conn, nil
}

func (s *MailService) mailDialer(settings *model.MailServerSettings) (imapclient.Dialer, error) {
	base := &net.Dialer{Timeout: mailConnectionTimeout}
	if settings == nil || normalizeMailProxyType(settings.ProxyType) == "none" {
		return base, nil
	}
	if strings.TrimSpace(settings.ProxyHost) == "" || settings.ProxyPort < 1 || settings.ProxyPort > 65535 {
		return nil, fmt.Errorf("SOCKS5 代理地址或端口无效")
	}
	var auth *proxy.Auth
	if strings.TrimSpace(settings.ProxyUsername) != "" {
		password := ""
		if strings.TrimSpace(settings.ProxyPasswordEncrypted) != "" {
			value, err := s.decryptSecret(settings.ProxyPasswordEncrypted)
			if err != nil {
				return nil, fmt.Errorf("SOCKS5 代理密码无法读取: %w", err)
			}
			password = value
		}
		auth = &proxy.Auth{User: strings.TrimSpace(settings.ProxyUsername), Password: password}
	}
	return proxy.SOCKS5(
		"tcp",
		net.JoinHostPort(strings.TrimSpace(settings.ProxyHost), fmt.Sprintf("%d", settings.ProxyPort)),
		auth,
		base,
	)
}

func (s *MailService) connectSMTP(settings *model.MailServerSettings, username, password string) (*smtp.Client, error) {
	address := net.JoinHostPort(settings.SMTPHost, fmt.Sprintf("%d", settings.SMTPPort))
	tlsConfig := &tls.Config{ServerName: settings.SMTPHost, MinVersion: tls.VersionTLS12, InsecureSkipVerify: settings.AllowInsecureTLS} // #nosec G402 -- explicit administrator option for private poste.io deployments.
	dialer, err := s.mailDialer(settings)
	if err != nil {
		return nil, err
	}
	var conn net.Conn
	if settings.SMTPSecurity == "tls" {
		plainConn, dialErr := dialer.Dial("tcp", address)
		if dialErr != nil {
			return nil, dialErr
		}
		_ = plainConn.SetDeadline(time.Now().Add(mailConnectionTimeout))
		tlsConn := tls.Client(plainConn, tlsConfig)
		if handshakeErr := tlsConn.Handshake(); handshakeErr != nil {
			_ = plainConn.Close()
			return nil, handshakeErr
		}
		_ = plainConn.SetDeadline(time.Time{})
		conn = tlsConn
	} else {
		conn, err = dialer.Dial("tcp", address)
	}
	if err != nil {
		return nil, err
	}
	client, err := smtp.NewClient(conn, settings.SMTPHost)
	if err != nil {
		_ = conn.Close()
		return nil, err
	}
	if settings.SMTPSecurity == "starttls" {
		if ok, _ := client.Extension("STARTTLS"); !ok {
			_ = client.Close()
			return nil, fmt.Errorf("服务器不支持 STARTTLS")
		}
		if err := client.StartTLS(tlsConfig); err != nil {
			_ = client.Close()
			return nil, err
		}
	}
	if ok, _ := client.Extension("AUTH"); !ok {
		_ = client.Close()
		return nil, fmt.Errorf("SMTP 服务器未提供身份验证")
	}
	if err := client.Auth(smtp.PlainAuth("", username, password, settings.SMTPHost)); err != nil {
		_ = client.Close()
		return nil, err
	}
	if err := client.Noop(); err != nil {
		_ = client.Close()
		return nil, err
	}
	return client, nil
}

func sendSMTPMessage(client *smtp.Client, from string, recipients []string, raw []byte) error {
	if err := client.Mail(from); err != nil {
		return err
	}
	for _, recipient := range recipients {
		if err := client.Rcpt(recipient); err != nil {
			return err
		}
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	if _, err := writer.Write(raw); err != nil {
		_ = writer.Close()
		return err
	}
	return writer.Close()
}

func (s *MailService) appendSentMessage(session *mailSession, raw []byte, sentAt time.Time) error {
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		return err
	}
	defer conn.Logout()
	folders, err := listMailFolders(conn)
	if err != nil {
		return err
	}
	sentFolder := folderForRole(folders, "sent")
	if sentFolder == "" {
		sentFolder = "Sent"
		if err := conn.Create(sentFolder); err != nil && !strings.Contains(strings.ToLower(err.Error()), "exist") {
			return err
		}
	}
	return conn.Append(sentFolder, []string{imap.SeenFlag}, sentAt, bytes.NewReader(raw))
}

func (s *MailService) currentInboxCursor(settings *model.MailServerSettings, account *model.MailAccount, password string) (uint32, uint32, error) {
	conn, err := s.connectIMAP(settings, account.LoginUsername, password)
	if err != nil {
		return 0, 0, err
	}
	defer conn.Logout()
	status, err := conn.Select(imap.InboxName, true)
	if err != nil {
		return 0, 0, err
	}
	lastUID := uint32(0)
	if status.UidNext > 0 {
		lastUID = status.UidNext - 1
	}
	return status.UidValidity, lastUID, nil
}

func listMailFolders(conn *imapclient.Client) ([]model.MailFolder, error) {
	mailboxes := make(chan *imap.MailboxInfo, 32)
	done := make(chan error, 1)
	go func() { done <- conn.List("", "*", mailboxes) }()
	infos := make([]*imap.MailboxInfo, 0)
	for info := range mailboxes {
		infos = append(infos, info)
	}
	if err := <-done; err != nil {
		return nil, err
	}
	folders := make([]model.MailFolder, 0, len(infos))
	for _, info := range infos {
		folder := model.MailFolder{
			Name: info.Name, DisplayName: mailFolderDisplayName(info.Name, info.Attributes), Delimiter: info.Delimiter,
			Role: mailFolderRole(info.Name, info.Attributes), Selectable: !mailAttributePresent(info.Attributes, imap.NoSelectAttr),
		}
		if folder.Selectable && folder.Role == "inbox" {
			status, err := conn.Status(info.Name, []imap.StatusItem{imap.StatusMessages, imap.StatusUnseen})
			if err == nil {
				folder.Total = status.Messages
				folder.Unread = status.Unseen
			}
		}
		folders = append(folders, folder)
	}
	sort.SliceStable(folders, func(i, j int) bool {
		left, right := mailFolderOrder(folders[i].Role), mailFolderOrder(folders[j].Role)
		if left != right {
			return left < right
		}
		return strings.ToLower(folders[i].DisplayName) < strings.ToLower(folders[j].DisplayName)
	})
	return folders, nil
}

func parseMailAddresses(values []string) ([]*gomail.Address, []string, error) {
	parsed := make([]*gomail.Address, 0)
	envelope := make([]string, 0)
	seen := make(map[string]struct{})
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		addresses, err := stdmail.ParseAddressList(value)
		if err != nil {
			return nil, nil, err
		}
		for _, address := range addresses {
			key := strings.ToLower(address.Address)
			if _, exists := seen[key]; exists {
				continue
			}
			seen[key] = struct{}{}
			parsed = append(parsed, &gomail.Address{Name: address.Name, Address: address.Address})
			envelope = append(envelope, address.Address)
		}
	}
	return parsed, envelope, nil
}

func updateMailFlag(conn *imapclient.Client, seqset *imap.SeqSet, flag string, enabled bool) error {
	op := imap.FlagsOp(imap.RemoveFlags)
	if enabled {
		op = imap.AddFlags
	}
	return conn.UidStore(seqset, imap.FormatFlagsOp(op, true), []interface{}{flag}, nil)
}

func validateMailSettings(settings *model.MailServerSettings) error {
	if settings.IMAPHost == "" || settings.SMTPHost == "" {
		return fmt.Errorf("IMAP 和 SMTP 服务器地址不能为空")
	}
	if strings.ContainsAny(settings.IMAPHost+settings.SMTPHost, "/\r\n\t ") {
		return fmt.Errorf("邮件服务器地址格式不正确")
	}
	if settings.IMAPPort < 1 || settings.IMAPPort > 65535 || settings.SMTPPort < 1 || settings.SMTPPort > 65535 {
		return fmt.Errorf("邮件服务器端口必须在 1 到 65535 之间")
	}
	if settings.IMAPSecurity != "tls" && settings.IMAPSecurity != "starttls" {
		return fmt.Errorf("IMAP 加密方式仅支持 TLS 或 STARTTLS")
	}
	if settings.SMTPSecurity != "tls" && settings.SMTPSecurity != "starttls" {
		return fmt.Errorf("SMTP 加密方式仅支持 TLS 或 STARTTLS")
	}
	if settings.MaxAttachmentMB < 1 || settings.MaxAttachmentMB > 50 {
		return fmt.Errorf("附件上限必须在 1 到 50MB 之间")
	}
	if normalizeMailProxyType(settings.ProxyType) == "socks5" {
		if strings.TrimSpace(settings.ProxyHost) == "" {
			return fmt.Errorf("请填写 SOCKS5 代理主机")
		}
		if settings.ProxyPort < 1 || settings.ProxyPort > 65535 {
			return fmt.Errorf("SOCKS5 代理端口必须在 1 到 65535 之间")
		}
	}
	return nil
}

func validateMailFolderName(raw string) (string, error) {
	name := strings.TrimSpace(raw)
	if name == "" || len(name) > 255 || strings.ContainsAny(name, "\r\n\x00") {
		return "", fmt.Errorf("邮件文件夹名称无效")
	}
	return name, nil
}

func protectedMailFolder(name string) bool {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "inbox", "sent", "sent items", "trash", "deleted items", "drafts", "junk", "spam":
		return true
	default:
		return false
	}
}

func normalizeMailHost(value string) string {
	value = strings.TrimSpace(strings.ToLower(value))
	for _, prefix := range []string{"imaps://", "imap://", "smtps://", "smtp://", "https://", "http://"} {
		value = strings.TrimPrefix(value, prefix)
	}
	return strings.TrimSuffix(value, "/")
}

func normalizeMailSecurity(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	if value == "starttls" {
		return value
	}
	return "tls"
}

func normalizeMailProxyType(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "socks5") {
		return "socks5"
	}
	return "none"
}

func normalizeMailForwardAddresses(ownAddress string, values []string) ([]string, error) {
	ownAddress = strings.ToLower(strings.TrimSpace(ownAddress))
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, raw := range values {
		for _, part := range strings.FieldsFunc(raw, func(r rune) bool {
			return r == ';' || r == ',' || r == '\n'
		}) {
			parsed, err := stdmail.ParseAddress(strings.TrimSpace(part))
			if err != nil || !strings.Contains(parsed.Address, "@") {
				return nil, fmt.Errorf("自动转发邮箱无效: %s", strings.TrimSpace(part))
			}
			address := strings.ToLower(strings.TrimSpace(parsed.Address))
			if address == ownAddress {
				return nil, fmt.Errorf("自动转发地址不能与当前邮箱相同")
			}
			if _, exists := seen[address]; exists {
				continue
			}
			seen[address] = struct{}{}
			result = append(result, address)
		}
	}
	return result, nil
}

func mailFolderRole(name string, attributes []string) string {
	if strings.EqualFold(name, imap.InboxName) {
		return "inbox"
	}
	attributeRoles := map[string]string{
		imap.SentAttr: "sent", imap.DraftsAttr: "drafts", imap.TrashAttr: "trash",
		imap.JunkAttr: "junk", imap.ArchiveAttr: "archive", imap.AllAttr: "all", imap.FlaggedAttr: "flagged",
	}
	for attribute, role := range attributeRoles {
		if mailAttributePresent(attributes, attribute) {
			return role
		}
	}
	lower := strings.ToLower(name)
	switch {
	case strings.Contains(lower, "sent"):
		return "sent"
	case strings.Contains(lower, "draft"):
		return "drafts"
	case strings.Contains(lower, "trash") || strings.Contains(lower, "deleted"):
		return "trash"
	case strings.Contains(lower, "junk") || strings.Contains(lower, "spam"):
		return "junk"
	case strings.Contains(lower, "archive"):
		return "archive"
	default:
		return "folder"
	}
}

func mailFolderDisplayName(name string, attributes []string) string {
	switch mailFolderRole(name, attributes) {
	case "inbox":
		return "收件箱"
	case "sent":
		return "已发送"
	case "drafts":
		return "草稿箱"
	case "trash":
		return "已删除"
	case "junk":
		return "垃圾邮件"
	case "archive":
		return "归档"
	case "all":
		return "全部邮件"
	case "flagged":
		return "已加星标"
	default:
		return name
	}
}

func mailFolderOrder(role string) int {
	switch role {
	case "inbox":
		return 0
	case "flagged":
		return 1
	case "sent":
		return 2
	case "drafts":
		return 3
	case "archive":
		return 4
	case "junk":
		return 5
	case "trash":
		return 6
	default:
		return 10
	}
}

func mailAttributePresent(attributes []string, target string) bool {
	for _, attribute := range attributes {
		if strings.EqualFold(attribute, target) {
			return true
		}
	}
	return false
}

func folderForRole(folders []model.MailFolder, role string) string {
	for _, folder := range folders {
		if folder.Role == role && folder.Selectable {
			return folder.Name
		}
	}
	return ""
}

func sanitizeMailFilename(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(value, "\\", "_"), "/", "_"))
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r", ""), "\n", "")
	if len(value) > 180 {
		value = value[:180]
	}
	return value
}

func trimMessageID(value string) string {
	return strings.Trim(strings.TrimSpace(value), "<>")
}

func cleanMailError(err error) string {
	if err == nil {
		return ""
	}
	message := strings.TrimSpace(err.Error())
	message = strings.ReplaceAll(message, "\r", " ")
	message = strings.ReplaceAll(message, "\n", " ")
	if len(message) > 500 {
		message = message[:500]
	}
	return message
}

func (s *MailService) encryptSecret(value string) (string, error) {
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

func (s *MailService) decryptSecret(value string) (string, error) {
	data, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil {
		return "", fmt.Errorf("邮箱密码配置损坏")
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
		return "", fmt.Errorf("邮箱密码配置损坏")
	}
	plain, err := gcm.Open(nil, data[:gcm.NonceSize()], data[gcm.NonceSize():], nil)
	if err != nil {
		return "", fmt.Errorf("邮箱密码无法解密")
	}
	return string(plain), nil
}
