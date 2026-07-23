package service

import (
	"bytes"
	"context"
	"fmt"
	"html"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	gomail "github.com/emersion/go-message/mail"

	"yaerp/internal/model"
)

const mailAutoForwardBatchSize = 50

func (s *MailService) StartAutoForward(ctx context.Context, interval time.Duration) {
	if interval < 30*time.Second {
		interval = 2 * time.Minute
	}
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			if err := s.processForwardingAccounts(); err != nil {
				log.Printf("mail auto-forward: %v", err)
			}
			timer.Reset(interval)
		}
	}
}

func (s *MailService) RunForwardingNow(userID int64) error {
	settings, err := s.activeSettings()
	if err != nil {
		return err
	}
	account, err := s.repo.GetAccount(userID)
	if err != nil {
		return err
	}
	if !account.AutoForwardEnabled || len(account.AutoForwardTo) == 0 {
		return fmt.Errorf("当前邮箱未启用自动转发")
	}
	return s.processForwardingAccount(settings, &*account)
}

func (s *MailService) processForwardingAccounts() error {
	settings, err := s.activeSettings()
	if err != nil {
		if err == ErrMailDisabled || err == ErrMailNotConfigured {
			return nil
		}
		return err
	}
	accounts, err := s.repo.ListForwardingAccounts()
	if err != nil {
		return err
	}
	for index := range accounts {
		if err := s.processForwardingAccount(settings, &accounts[index]); err != nil {
			s.recordFailure(accounts[index].UserID, fmt.Errorf("自动转发失败: %w", err))
		}
	}
	return nil
}

func (s *MailService) processForwardingAccount(settings *model.MailServerSettings, account *model.MailAccount) error {
	password, err := s.decryptSecret(account.PasswordEncrypted)
	if err != nil {
		return err
	}
	conn, err := s.connectIMAP(settings, account.LoginUsername, password)
	if err != nil {
		return err
	}
	defer conn.Logout()
	status, err := conn.Select(imap.InboxName, true)
	if err != nil {
		return err
	}
	currentLastUID := uint32(0)
	if status.UidNext > 0 {
		currentLastUID = status.UidNext - 1
	}
	if account.ForwardUIDValidity == 0 || account.ForwardUIDValidity != status.UidValidity {
		return s.repo.UpdateForwardCursor(account.ID, status.UidValidity, currentLastUID)
	}
	criteria := imap.NewSearchCriteria()
	uids, err := conn.UidSearch(criteria)
	if err != nil {
		return err
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	pending := make([]uint32, 0, mailAutoForwardBatchSize)
	for _, uid := range uids {
		if uid > account.ForwardLastUID {
			pending = append(pending, uid)
			if len(pending) == mailAutoForwardBatchSize {
				break
			}
		}
	}
	for _, uid := range pending {
		_, raw, fetchErr := fetchRawMail(conn, uid)
		if fetchErr != nil {
			s.recordForwardFailure(account, status.UidValidity, uid, "", fetchErr)
			continue
		}
		if bytes.Contains(bytes.ToLower(raw), []byte("x-yaerp-auto-forwarded:")) {
			_ = s.repo.RecordForwardEvent(account.ID, imap.InboxName, status.UidValidity, uid, "", account.AutoForwardTo, "sent", "已跳过自动转发邮件，避免循环")
			_ = s.repo.UpdateForwardCursor(account.ID, status.UidValidity, uid)
			account.ForwardLastUID = uid
			continue
		}
		parsed, parseErr := s.parseMailData(raw)
		if parseErr != nil {
			s.recordForwardFailure(account, status.UidValidity, uid, "", parseErr)
			continue
		}
		if forwardErr := s.forwardParsedMessage(settings, account, password, parsed); forwardErr != nil {
			s.recordForwardFailure(account, status.UidValidity, uid, parsed.MessageID, forwardErr)
			continue
		}
		_ = s.repo.RecordForwardEvent(account.ID, imap.InboxName, status.UidValidity, uid, parsed.MessageID, account.AutoForwardTo, "sent", "")
		_ = s.repo.UpdateForwardCursor(account.ID, status.UidValidity, uid)
		account.ForwardLastUID = uid
	}
	if len(pending) > 0 {
		_ = s.repo.UpdateAccountStatus(account.UserID, false, true, "")
	}
	return nil
}

func (s *MailService) recordForwardFailure(account *model.MailAccount, uidValidity, uid uint32, messageID string, forwardErr error) {
	message := cleanMailError(forwardErr)
	_ = s.repo.RecordForwardEvent(account.ID, imap.InboxName, uidValidity, uid, messageID, account.AutoForwardTo, "failed", message)
	_ = s.repo.UpdateForwardCursor(account.ID, uidValidity, uid)
	_ = s.repo.UpdateAccountStatus(account.UserID, false, false, "自动转发失败: "+message)
	account.ForwardLastUID = uid
}

func (s *MailService) forwardParsedMessage(settings *model.MailServerSettings, account *model.MailAccount, password string, parsed *parsedMailData) error {
	to, recipients, err := parseMailAddresses(account.AutoForwardTo)
	if err != nil || len(recipients) == 0 {
		return fmt.Errorf("自动转发收件人无效")
	}
	from := []*gomail.Address{{Name: account.DisplayName, Address: account.EmailAddress}}
	subject := strings.TrimSpace(parsed.Subject)
	if subject == "" {
		subject = "（无主题）"
	}
	if !strings.HasPrefix(strings.ToLower(subject), "fwd:") {
		subject = "Fwd: " + subject
	}
	fromLabel := addressListText(parsed.From)
	introText := fmt.Sprintf("自动转发邮件\n原发件人: %s\n原收件时间: %s\n\n", fromLabel, parsed.Date.Format("2006-01-02 15:04:05"))
	textBody := introText + parsed.TextBody
	originalHTML := parsed.HTMLBody
	if strings.TrimSpace(originalHTML) == "" {
		originalHTML = "<pre style=\"white-space:pre-wrap\">" + html.EscapeString(parsed.TextBody) + "</pre>"
	}
	htmlBody := `<div style="padding:10px 12px;margin-bottom:16px;border-left:3px solid #0284c7;background:#f0f9ff;color:#334155">` +
		`<strong>YAERP 自动转发</strong><br>原发件人：` + html.EscapeString(fromLabel) +
		`<br>原收件时间：` + html.EscapeString(parsed.Date.Format("2006-01-02 15:04:05")) + `</div>` + originalHTML
	attachments := make([]MailOutgoingAttachment, 0, len(parsed.Attachments))
	if account.ForwardAttachments {
		limit := int64(settings.MaxAttachmentMB) << 20
		var total int64
		for _, attachment := range parsed.Attachments {
			if total+int64(len(attachment.Data)) > limit {
				continue
			}
			total += int64(len(attachment.Data))
			attachments = append(attachments, MailOutgoingAttachment{
				Filename: attachment.Filename, ContentType: attachment.ContentType, Data: attachment.Data,
			})
		}
	}
	accountCopy := *account
	accountCopy.SignatureHTML = ""
	session := &mailSession{settings: settings, account: &accountCopy, password: password}
	input := &model.MailSendInput{
		To: account.AutoForwardTo, Subject: subject, TextBody: textBody, HTMLBody: htmlBody,
		SaveToSent: false, AutoForwardedBy: account.EmailAddress,
	}
	raw, _, _, err := s.buildOutgoingMessage(session, input, from, to, nil, nil, attachments)
	if err != nil {
		return err
	}
	smtpConn, err := s.connectSMTP(settings, account.LoginUsername, password)
	if err != nil {
		return err
	}
	if err := sendSMTPMessage(smtpConn, account.EmailAddress, recipients, raw); err != nil {
		_ = smtpConn.Close()
		return err
	}
	return smtpConn.Quit()
}

func addressListText(addresses []model.MailAddress) string {
	values := make([]string, 0, len(addresses))
	for _, address := range addresses {
		if strings.TrimSpace(address.Name) != "" {
			values = append(values, fmt.Sprintf("%s <%s>", address.Name, address.Address))
		} else if strings.TrimSpace(address.Address) != "" {
			values = append(values, address.Address)
		}
	}
	if len(values) == 0 {
		return "未知发件人"
	}
	return strings.Join(values, ", ")
}
