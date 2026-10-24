package service

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"yaerp/internal/model"
)

func TestAliMailEmbedInlineImagesDownloadsSmallImagesConcurrently(t *testing.T) {
	image := append([]byte("\x89PNG\r\n\x1a\n"), make([]byte, 64)...)
	var active, peak int32
	var server *httptest.Server
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/blob/") {
			now := atomic.AddInt32(&active, 1)
			for {
				seen := atomic.LoadInt32(&peak)
				if now <= seen || atomic.CompareAndSwapInt32(&peak, seen, now) {
					break
				}
			}
			time.Sleep(50 * time.Millisecond)
			atomic.AddInt32(&active, -1)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(image)
			return
		}
		if r.Header.Get("Authorization") != "Bearer token" || !strings.HasSuffix(r.URL.Path, "/$value") {
			http.Error(w, "unexpected", http.StatusBadRequest)
			return
		}
		parts := strings.Split(r.URL.Path, "/")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"location":"` + server.URL + "/blob/" + parts[len(parts)-2] + `"}`))
	}))
	defer server.Close()

	service := NewMailService(nil, nil, "secret")
	account := &model.MailAccount{ID: 7, UserID: 3, EmailAddress: "me@example.com", APIBaseURL: server.URL, ProxyMode: mailProxyModeOff}
	service.aliTokens[account.ID] = aliMailToken{AccessToken: "token", ExpiresAt: time.Now().Add(time.Hour)}
	service.aliHTTPClient["direct"] = server.Client()

	attachments := []model.MailAttachment{
		{PartID: "a", ContentID: "<a@x>", ContentType: "image/png", Size: 100},
		{PartID: "b", ContentID: "<b@x>", ContentType: "application/octet-stream", Size: 100},
		{PartID: "c", ContentID: "<c@x>", ContentType: "image/png", Size: 100},
		{PartID: "big", ContentID: "<big@x>", ContentType: "image/png", Size: mailInlineDataURIMax + 1},
		{PartID: "doc", Filename: "doc.pdf", ContentType: "application/pdf", Size: 100},
	}
	html := `<img src="cid:a@x"><img src="cid:b@x"><img src="cid:c@x"><img src="cid:big@x">`
	out := service.aliMailEmbedInlineImages(account, "INBOX", 9, "remote", html, attachments)

	dataURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(image)
	if count := strings.Count(out, dataURI); count != 3 {
		t.Fatalf("want the 3 small images embedded, got %d in %s", count, out)
	}
	if !strings.Contains(out, attachments[3].URL) || attachments[3].URL == "" {
		t.Fatalf("the large image should point to its link: %s", out)
	}
	if peak < 2 {
		t.Fatalf("small images were downloaded one after another (peak %d)", peak)
	}
	for _, attachment := range attachments {
		if attachment.Inline != (attachment.PartID != "doc") {
			t.Fatalf("attachment %s inline=%v", attachment.PartID, attachment.Inline)
		}
	}
}
