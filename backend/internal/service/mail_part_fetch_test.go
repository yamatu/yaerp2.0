package service

import (
	"bufio"
	"bytes"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/backend/backendutil"
	"github.com/emersion/go-message/textproto"
)

// A message mixing the cases that numbering must agree on: nested
// multipart/related inside multipart/mixed, a part without Content-Type, an
// RFC 2231 filename, an image sent as application/octet-stream, a text
// attachment and an Apple Mail style inline PDF without Content-ID.
func trickyMailMessage() string {
	png := base64.StdEncoding.EncodeToString([]byte("\x89PNG\r\n\x1a\n0000IHDR........."))
	return strings.Join([]string{
		"From: a@example.com", "To: b@example.com", "Subject: t", "MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="mix"`, "",
		"--mix", `Content-Type: multipart/related; boundary="rel"`, "",
		"--rel", "Content-Type: multipart/alternative; boundary=\"alt\"", "",
		"--alt", "Content-Type: text/plain; charset=utf-8", "", "plain body",
		"--alt", "Content-Type: text/html; charset=utf-8", "", `<p>html <img src="cid:logo@x"></p>`,
		"--alt--",
		"--rel", "Content-Type: application/octet-stream", "Content-ID: <logo@x>", "Content-Transfer-Encoding: base64", "", png,
		"--rel--",
		"--mix", "", "a part without any Content-Type is text/plain",
		"--mix", `Content-Type: application/pdf`, `Content-Disposition: inline; filename*=UTF-8''%E5%90%88%E5%90%8C.pdf`, "Content-Transfer-Encoding: base64", "", base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 x")),
		"--mix", `Content-Type: text/csv; charset=utf-8; name="data.csv"`, `Content-Disposition: attachment; filename="data.csv"`, "", "a,b",
		"--mix--", "",
	}, "\r\n")
}

func TestStructureNumberingMatchesParser(t *testing.T) {
	raw := trickyMailMessage()
	service := NewMailService(nil, nil, "test-secret")
	parsed, err := service.parseMailData([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(strings.NewReader(raw))
	header, err := textproto.ReadHeader(reader)
	if err != nil {
		t.Fatal(err)
	}
	structure, err := backendutil.FetchBodyStructure(header, reader, true)
	if err != nil {
		t.Fatal(err)
	}
	var fromStructure []string
	for _, leaf := range mailStructureLeaves(structure) {
		if leaf.attachment > 0 {
			info := leaf.info
			info.finish(leaf.attachment, parsed.Attachments[leaf.attachment-1].Data)
			fromStructure = append(fromStructure, info.filename)
		}
	}
	var fromParser []string
	for _, attachment := range parsed.Attachments {
		fromParser = append(fromParser, attachment.Filename)
	}
	if strings.Join(fromStructure, "|") != strings.Join(fromParser, "|") {
		t.Fatalf("attachment numbering differs:\nstructure %v\nparser    %v", fromStructure, fromParser)
	}
	if len(fromParser) != 3 || fromParser[1] != "合同.pdf" || fromParser[2] != "data.csv" {
		t.Fatalf("unexpected attachments %v", fromParser)
	}
}

func TestInlineOnlyWhenTheBodyShowsThePart(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	parsed, err := service.parseMailData([]byte(trickyMailMessage()))
	if err != nil {
		t.Fatal(err)
	}
	inline := map[string]bool{}
	for _, attachment := range parsed.Attachments {
		inline[attachment.Filename] = attachment.Inline
	}
	if !inline["attachment-1.png"] {
		t.Fatalf("the logo shown in the body must be inline: %v", inline)
	}
	if inline["合同.pdf"] || inline["data.csv"] {
		t.Fatalf("parts the body does not show must be listed: %v", inline)
	}
	if parsed.Attachments[0].ContentType != "image/png" {
		t.Fatalf("an octet-stream image must get its image type, got %q", parsed.Attachments[0].ContentType)
	}
}

func TestLargeBodyImagesBecomeLinks(t *testing.T) {
	big := bytes.Repeat([]byte{0}, mailInlineDataURIMax+10)
	copy(big, []byte("\x89PNG\r\n\x1a\n"))
	raw := strings.Join([]string{
		"From: a@example.com", "Subject: t", "MIME-Version: 1.0", `Content-Type: multipart/related; boundary="rel"`, "",
		"--rel", "Content-Type: text/html; charset=utf-8", "", `<p><img id="big" src="cid:big@x"></p>`,
		"--rel", "Content-Type: image/png", "Content-ID: <big@x>", "Content-Transfer-Encoding: base64", "", base64.StdEncoding.EncodeToString(big),
		"--rel--", "",
	}, "\r\n")
	service := NewMailService(nil, nil, "test-secret")
	parsed, err := service.parseMailDataWithOptions([]byte(raw), mailParseOptions{partURL: func(partID string) string { return "/api/mail/file?t=part-" + partID }})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(parsed.HTMLBody, `src="/api/mail/file?t=part-1"`) || strings.Contains(parsed.HTMLBody, "data:image") {
		t.Fatalf("a large image must be a link: %s", parsed.HTMLBody)
	}
	// Server-side forwarding (no links) keeps embedding it.
	forwarded, err := service.parseMailData([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(forwarded.HTMLBody, "data:image/png;base64,") {
		t.Fatalf("without links the image must stay embedded: %.200s", forwarded.HTMLBody)
	}
}

func TestMailPartLinkSignature(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	link := service.mailPartURL(7, 3, "INBOX", 42, "2")
	claims, ok := service.mailPartLinkFromURL("https://erp.example.com" + link)
	if !ok || claims.UserID != 7 || claims.AccountID != 3 || claims.UID != 42 || claims.PartID != "2" {
		t.Fatalf("link did not verify: %+v %v", claims, ok)
	}
	other := NewMailService(nil, nil, "another-secret")
	if _, ok := other.mailPartLinkFromURL(link); ok {
		t.Fatal("a link signed with another secret must not verify")
	}
	token := link[strings.Index(link, "t=")+2:]
	if _, err := service.verifyMailPartLink(strings.Replace(token, "e", "f", 1)); err == nil {
		t.Fatal("a modified token must not verify")
	}
	expired := service.signMailPartLink(mailPartLinkClaims{UserID: 7, AccountID: 3, Folder: "INBOX", UID: 42, PartID: "2", Expires: time.Now().Add(-time.Minute).Unix()})
	if _, err := service.verifyMailPartLink(expired); err == nil {
		t.Fatal("an expired token must not verify")
	}
}

func TestMailInlineServable(t *testing.T) {
	for contentType, want := range map[string]bool{
		"image/png": true, "application/pdf": true, "video/mp4": true, "text/plain; charset=utf-8": true,
		"text/html": false, "image/svg+xml": false, "application/xhtml+xml": false, "application/octet-stream": false,
	} {
		if got := MailInlineServable(contentType); got != want {
			t.Errorf("MailInlineServable(%q) = %v, want %v", contentType, got, want)
		}
	}
}

// A large message is opened without its big parts. An image the body shows
// that is declared application/octet-stream has no bytes to recognise it by;
// it must still be shown through its link.
func TestOmittedOctetStreamImageBecomesLink(t *testing.T) {
	raw := strings.Join([]string{
		"From: a@example.com", "Subject: t", "MIME-Version: 1.0", `Content-Type: multipart/related; boundary="rel"`, "",
		"--rel", "Content-Type: text/html; charset=utf-8", "", `<p><img id="photo" src="cid:photo@x"></p>`,
		"--rel", "Content-Type: application/octet-stream", "Content-ID: <photo@x>", "Content-Transfer-Encoding: base64",
		mailOmittedSizeHeader + ": 2400000", "", "",
		"--rel--", "",
	}, "\r\n")
	service := NewMailService(nil, nil, "test-secret")
	parsed, err := service.parseMailDataWithOptions([]byte(raw), mailParseOptions{
		partURL: func(partID string) string { return "/api/mail/file?t=part-" + partID },
		pruned:  true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(parsed.HTMLBody, `src="/api/mail/file?t=part-1"`) {
		t.Fatalf("the omitted image must be a link: %s", parsed.HTMLBody)
	}
	attachment := parsed.Attachments[0]
	if !attachment.Inline || attachment.Size != 2400000 {
		t.Fatalf("omitted image must be inline with its declared size: %+v", attachment.MailAttachment)
	}
	// The index records what the headers say, which a part fetched alone
	// reproduces before its bytes refine type and name.
	if attachment.header.contentType != "application/octet-stream" || attachment.header.filename != "" {
		t.Fatalf("header-level description changed: %+v", attachment.header)
	}
}

func TestServedTypeSniffsImages(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n0000IHDR")
	if got := MailServedContentType("application/octet-stream", png); got != "image/png" {
		t.Fatalf("octet-stream PNG served as %q", got)
	}
	if got := MailServedContentType("application/zip", []byte("PK\x03\x04")); got != "application/zip" {
		t.Fatalf("a zip must keep its type, got %q", got)
	}
}
