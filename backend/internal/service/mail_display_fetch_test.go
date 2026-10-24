package service

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/emersion/go-imap/backend/memory"
	imapclient "github.com/emersion/go-imap/client"
	"github.com/emersion/go-imap/server"
)

func randomBase64(t *testing.T, size int) string {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		t.Fatal(err)
	}
	copy(data, "\x89PNG\r\n\x1a\n")
	encoded := base64.StdEncoding.EncodeToString(data)
	var out strings.Builder
	for len(encoded) > 76 {
		out.WriteString(encoded[:76] + "\r\n")
		encoded = encoded[76:]
	}
	out.WriteString(encoded)
	return out.String()
}

func TestDisplayFetchLeavesAttachmentsOut(t *testing.T) {
	part := func(header, body string) string { return "--mix\r\n" + header + "\r\n\r\n" + body + "\r\n" }
	related := strings.Join([]string{
		"--rel", "Content-Type: text/html; charset=utf-8", "", `<p>hi</p><img src="cid:small@x"><img src="cid:photo@x"><img src="cid:huge@x">`,
		"--rel", "Content-Type: image/png", "Content-ID: <small@x>", "Content-Transfer-Encoding: base64", "", randomBase64(t, 40<<10),
		"--rel", "Content-Type: image/png", "Content-ID: <photo@x>", "Content-Transfer-Encoding: base64", "", randomBase64(t, 400<<10),
		"--rel", "Content-Type: image/png", "Content-ID: <huge@x>", "Content-Transfer-Encoding: base64", "", randomBase64(t, 2<<20),
		"--rel--", "",
	}, "\r\n")
	raw := strings.Join([]string{
		"From: a@example.com", "To: b@example.com", "Subject: t", "MIME-Version: 1.0",
		`Content-Type: multipart/mixed; boundary="mix"`, "", "",
	}, "\r\n") +
		part(`Content-Type: multipart/related; boundary="rel"`, related) +
		part("Content-Type: application/pdf\r\nContent-Disposition: attachment; filename=\"a.pdf\"\r\nContent-Transfer-Encoding: base64", randomBase64(t, 600<<10)) +
		"--mix--\r\n"

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	imapServer := server.New(memory.New())
	imapServer.AllowInsecureAuth = true
	go func() { _ = imapServer.Serve(listener) }()
	defer imapServer.Close()
	conn, err := imapclient.Dial(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Logout()
	if err := conn.Login("username", "password"); err != nil {
		t.Fatal(err)
	}
	status, err := conn.Select("INBOX", false)
	if err != nil {
		t.Fatal(err)
	}
	uid := status.UidNext
	if err := conn.Append("INBOX", nil, time.Now(), bytes.NewBufferString(raw)); err != nil {
		t.Fatal(err)
	}
	if err := selectMailFolder(conn, "INBOX", true); err != nil {
		t.Fatal(err)
	}

	fetched, err := fetchMailForDisplay(conn, uid)
	if err != nil {
		t.Fatal(err)
	}
	if !fetched.pruned || len(fetched.leaves) != 5 {
		t.Fatalf("pruned=%v leaves=%d", fetched.pruned, len(fetched.leaves))
	}
	if len(fetched.raw) > 1<<20 {
		t.Fatalf("display fetch transferred %d bytes", len(fetched.raw))
	}
	service := &MailService{htmlPolicy: newMailHTMLPolicy()}
	parsed, err := service.parseMailDataWithOptions(fetched.raw, mailParseOptions{partURL: func(id string) string { return "/api/mail/file?t=" + id }, pruned: true})
	if err != nil {
		t.Fatal(err)
	}
	omitted := map[string]bool{}
	for _, attachment := range parsed.Attachments {
		omitted[firstNonEmptyMail(strings.Trim(attachment.ContentID, "<>"), attachment.Filename)] = attachment.omitted
	}
	want := map[string]bool{"small@x": false, "photo@x": false, "huge@x": true, "a.pdf": true}
	for key, expected := range want {
		if got, ok := omitted[key]; !ok || got != expected {
			t.Fatalf("%s omitted=%v (listed %v), want %v", key, got, ok, expected)
		}
	}
	if !strings.Contains(parsed.HTMLBody, "data:image/png;base64,") || strings.Count(parsed.HTMLBody, "/api/mail/file?t=") != 2 {
		t.Fatalf("small image embedded, the others linked: %.300s", parsed.HTMLBody)
	}
}
