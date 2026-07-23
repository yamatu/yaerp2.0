package service

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap"

	"yaerp/internal/model"
)

func TestMailSecretEncryptionRoundTrip(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	encrypted, err := service.encryptSecret("mail-password")
	if err != nil {
		t.Fatal(err)
	}
	if encrypted == "mail-password" || encrypted == "" {
		t.Fatalf("password was not encrypted: %q", encrypted)
	}
	plain, err := service.decryptSecret(encrypted)
	if err != nil {
		t.Fatal(err)
	}
	if plain != "mail-password" {
		t.Fatalf("unexpected decrypted password: %q", plain)
	}
}

func TestMailMessageRoundTrip(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	session := &mailSession{
		settings: &model.MailServerSettings{DefaultDomain: "example.com"},
		account: &model.MailAccount{
			EmailAddress: "sales@example.com", DisplayName: "Sales", SignatureHTML: "<strong>YAERP</strong>",
		},
	}
	input := &model.MailSendInput{
		Subject: "采购询价", TextBody: "请确认报价", SaveToSent: true,
		Priority: "high", RequestReadReceipt: true,
	}
	raw, messageID, _, err := service.buildOutgoingMessage(
		session, input,
		nil, nil, nil, nil,
		[]MailOutgoingAttachment{{Filename: "quote.txt", ContentType: "text/plain", Data: []byte("USD 100")}},
	)
	if err != nil {
		t.Fatal(err)
	}
	if messageID == "" {
		t.Fatal("message id was not generated")
	}
	parsed, err := service.parseMailData(raw)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Subject != input.Subject || !strings.Contains(parsed.TextBody, input.TextBody) {
		t.Fatalf("message content did not round trip: %#v", parsed)
	}
	if !strings.Contains(parsed.HTMLBody, "YAERP") {
		t.Fatalf("signature missing from HTML body: %q", parsed.HTMLBody)
	}
	if len(parsed.Attachments) != 1 || string(parsed.Attachments[0].Data) != "USD 100" {
		t.Fatalf("attachment did not round trip: %#v", parsed.Attachments)
	}
	messageSource := strings.ToLower(string(raw))
	if !strings.Contains(messageSource, "x-priority: 1") || !strings.Contains(messageSource, "disposition-notification-to:") {
		t.Fatalf("priority or read receipt headers missing: %s", raw)
	}
}

func TestMailMessageSignatureOverride(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	session := &mailSession{
		settings: &model.MailServerSettings{DefaultDomain: "example.com"},
		account: &model.MailAccount{
			EmailAddress: "sales@example.com", SignatureHTML: "<strong>Legacy signature</strong>",
		},
	}
	override := "<strong>Selected signature</strong>"
	input := &model.MailSendInput{Subject: "test", TextBody: "body", SignatureHTML: &override}
	raw, _, _, err := service.buildOutgoingMessage(session, input, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	message := string(raw)
	if !strings.Contains(message, "Selected signature") || strings.Contains(message, "Legacy signature") {
		t.Fatalf("selected signature did not override legacy account signature: %s", message)
	}

	disabled := ""
	input.SignatureHTML = &disabled
	raw, _, _, err = service.buildOutgoingMessage(session, input, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "Legacy signature") {
		t.Fatalf("explicitly disabled signature fell back to legacy signature: %s", raw)
	}
}

func TestMailFolderRoles(t *testing.T) {
	tests := []struct {
		name       string
		attributes []string
		want       string
	}{
		{name: "INBOX", want: "inbox"},
		{name: "Posteingang/Sent", attributes: []string{imap.SentAttr}, want: "sent"},
		{name: "Deleted Items", want: "trash"},
		{name: "Projects", want: "folder"},
	}
	for _, test := range tests {
		if got := mailFolderRole(test.name, test.attributes); got != test.want {
			t.Errorf("mailFolderRole(%q) = %q, want %q", test.name, got, test.want)
		}
	}
}

func TestValidateMailSettings(t *testing.T) {
	settings := &model.MailServerSettings{
		IMAPHost: "mail.example.com", IMAPPort: 993, IMAPSecurity: "tls",
		SMTPHost: "mail.example.com", SMTPPort: 465, SMTPSecurity: "tls", MaxAttachmentMB: 25,
	}
	if err := validateMailSettings(settings); err != nil {
		t.Fatal(err)
	}
	settings.SMTPPort = 0
	if err := validateMailSettings(settings); err == nil {
		t.Fatal("invalid SMTP port was accepted")
	}
	settings.SMTPPort = 465
	settings.ProxyType = "socks5"
	settings.ProxyHost = "127.0.0.1"
	settings.ProxyPort = 1080
	if err := validateMailSettings(settings); err != nil {
		t.Fatalf("valid SOCKS5 settings rejected: %v", err)
	}
	settings.ProxyPort = 0
	if err := validateMailSettings(settings); err == nil {
		t.Fatal("invalid SOCKS5 port was accepted")
	}
}

func TestNormalizeMailForwardAddresses(t *testing.T) {
	addresses, err := normalizeMailForwardAddresses("sales@example.com", []string{
		"Manager <manager@example.com>; notify@example.com",
		"MANAGER@example.com\nfinance@example.com",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"manager@example.com", "notify@example.com", "finance@example.com"}
	if len(addresses) != len(want) {
		t.Fatalf("unexpected addresses: %#v", addresses)
	}
	for index := range want {
		if addresses[index] != want[index] {
			t.Fatalf("addresses[%d] = %q, want %q", index, addresses[index], want[index])
		}
	}
	if _, err := normalizeMailForwardAddresses("sales@example.com", []string{"sales@example.com"}); err == nil {
		t.Fatal("forwarding to the same mailbox was accepted")
	}
}

func TestAITranslationResultJSONAndAlignment(t *testing.T) {
	result := AITranslationResult{
		AssistantID: 3, AssistantName: "Translator", Model: "test-model", Content: "你好",
		Segments: []AITranslationSegment{{Source: "Hello", Translation: "你好"}},
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	value := string(encoded)
	for _, key := range []string{`"assistant_id"`, `"assistant_name"`, `"content"`, `"segments"`} {
		if !strings.Contains(value, key) {
			t.Fatalf("translation JSON is missing %s: %s", key, value)
		}
	}

	source := splitTranslationSegments("Hello\r\n\r\nWorld")
	if len(source) != 2 || source[0] != "Hello" || source[1] != "World" {
		t.Fatalf("unexpected source segments: %#v", source)
	}
	aligned := alignTranslationSegments(source, "你好\n世界")
	if len(aligned) != 2 || aligned[1].Translation != "世界" {
		t.Fatalf("unexpected aligned translation: %#v", aligned)
	}
}

func TestDecodeMailHeaderValue(t *testing.T) {
	if got := decodeMailHeaderValue("=?UTF-8?B?WWFtYXR1?="); got != "Yamatu" {
		t.Fatalf("decoded mail header = %q, want Yamatu", got)
	}
	if got := decodeMailHeaderValue("Normal Sender"); got != "Normal Sender" {
		t.Fatalf("plain mail header changed: %q", got)
	}
}

func TestExtractMailSenderAvatar(t *testing.T) {
	htmlValue := `<div><a>Yamatu</a><br><a>yamatu@qq.com</a></div><p><img src="cid:qq-avatar" alt="profile"></p><p>邮件正文</p>`
	cleaned, avatar, contentID := extractMailSenderAvatar(htmlValue, "yamatu@qq.com", map[string]string{
		"qq-avatar": "data:image/png;base64,YXZhdGFy",
	})
	if avatar != "data:image/png;base64,YXZhdGFy" || contentID != "qq-avatar" {
		t.Fatalf("avatar was not extracted: avatar=%q contentID=%q", avatar, contentID)
	}
	if strings.Contains(cleaned, "qq-avatar") || strings.Contains(cleaned, "yamatu@qq.com") || !strings.Contains(cleaned, "邮件正文") {
		t.Fatalf("unexpected cleaned HTML: %s", cleaned)
	}

	ordinary := `<p>产品图片</p><img src="https://example.com/product.png">`
	cleaned, avatar, _ = extractMailSenderAvatar(ordinary, "yamatu@qq.com", nil)
	if avatar != "" || cleaned != ordinary {
		t.Fatalf("ordinary body image was incorrectly extracted: avatar=%q html=%q", avatar, cleaned)
	}

	tableSignature := `<table><tr><td><img src="cid:table-avatar"></td><td><a>Yamatu</a><br><a>yamatu@qq.com</a></td></tr></table><p>正文</p>`
	cleaned, avatar, contentID = extractMailSenderAvatar(tableSignature, "yamatu@qq.com", map[string]string{
		"table-avatar": "data:image/png;base64,dGFibGU=",
	})
	if avatar == "" || contentID != "table-avatar" || strings.Contains(cleaned, "table-avatar") || strings.Contains(cleaned, "yamatu@qq.com") {
		t.Fatalf("table signature avatar was not extracted: avatar=%q contentID=%q html=%q", avatar, contentID, cleaned)
	}

	inlineSignature := `<p>正文保留</p><div class="signature"><img src="cid:inline-avatar"><a>Yamatu</a><a>yamatu@qq.com</a></div>`
	cleaned, avatar, contentID = extractMailSenderAvatar(inlineSignature, "yamatu@qq.com", map[string]string{
		"inline-avatar": "data:image/png;base64,aW5saW5l",
	})
	if avatar == "" || contentID != "inline-avatar" || strings.Contains(cleaned, "yamatu@qq.com") || !strings.Contains(cleaned, "正文保留") {
		t.Fatalf("inline signature was not removed: avatar=%q contentID=%q html=%q", avatar, contentID, cleaned)
	}
}

func TestSortMailSummaries(t *testing.T) {
	now := time.Now()
	messages := []model.MailMessageSummary{
		{UID: 1, Size: 300, Date: now.Add(-time.Hour)},
		{UID: 2, Size: 100, Date: now},
		{UID: 3, Size: 200, Date: now.Add(-2 * time.Hour)},
	}
	sortMailSummaries(messages, "size", "asc")
	if messages[0].UID != 2 || messages[2].UID != 1 {
		t.Fatalf("unexpected size order: %#v", messages)
	}
	sortMailSummaries(messages, "date", "desc")
	if messages[0].UID != 2 || messages[2].UID != 3 {
		t.Fatalf("unexpected date order: %#v", messages)
	}
}

func TestMailBodyHasAttachmentIgnoresInlineCIDImage(t *testing.T) {
	inlineAvatar := &imap.BodyStructure{
		MIMEType: "image", MIMESubType: "png", Id: "avatar",
		Params: map[string]string{"name": "avatar.png"},
	}
	if mailBodyHasAttachment(inlineAvatar) {
		t.Fatal("inline CID avatar was reported as a downloadable attachment")
	}
	attachment := &imap.BodyStructure{
		MIMEType: "application", MIMESubType: "pdf", Disposition: "attachment",
		DispositionParams: map[string]string{"filename": "quote.pdf"},
	}
	if !mailBodyHasAttachment(attachment) {
		t.Fatal("regular attachment was not detected")
	}
}
