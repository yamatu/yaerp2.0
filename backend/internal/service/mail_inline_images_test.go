package service

import (
	"strings"
	"testing"

	"yaerp/internal/model"
)

// 1x1 transparent PNG.
const testPNGBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

func TestExtractMailInlineImages(t *testing.T) {
	html := `<p>Hi</p><img src="data:image/png;base64,` + testPNGBase64 + `" alt="a"><img alt="b" src="data:image/png;base64,` + testPNGBase64 + `"><img src="https://example.com/x.png">`
	rewritten, images := extractMailInlineImages(html, "example.com")
	if len(images) != 1 {
		t.Fatalf("identical images must share one part, got %d", len(images))
	}
	if strings.Contains(rewritten, "data:image") {
		t.Fatalf("data URI left in HTML: %s", rewritten)
	}
	if strings.Count(rewritten, "cid:"+images[0].ContentID) != 2 {
		t.Fatalf("both references should point at the shared part: %s", rewritten)
	}
	if !strings.Contains(rewritten, `src="https://example.com/x.png"`) {
		t.Fatal("remote images must be left untouched")
	}
	if images[0].ContentType != "image/png" || len(images[0].Data) == 0 {
		t.Fatalf("unexpected image: %+v", images[0])
	}
}

func TestExtractMailInlineImagesLeavesSVGAndBrokenData(t *testing.T) {
	html := `<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="><img src="data:image/png;base64,@@@">`
	rewritten, images := extractMailInlineImages(html, "example.com")
	if len(images) != 0 || rewritten != html {
		t.Fatalf("svg and undecodable data must be left alone: %s %+v", rewritten, images)
	}
}

func TestOutgoingReplySendsQuotedImagesAsRelatedParts(t *testing.T) {
	service := NewMailService(nil, nil, "test-secret")
	session := &mailSession{
		settings: &model.MailServerSettings{DefaultDomain: "example.com"},
		account:  &model.MailAccount{EmailAddress: "sales@example.com", SignatureHTML: "<strong>Legacy signature</strong>"},
	}
	noSignature := ""
	input := &model.MailSendInput{
		Subject:       "Re: RFQ",
		TextBody:      "Yes, fine.\n\n________________________________\nFrom: Rahman",
		HTMLBody:      `<div>Yes, fine.</div><div><b>From:</b> Rahman</div><table><tr><td>M9R84240</td><td>100</td></tr></table><img src="data:image/png;base64,` + testPNGBase64 + `">`,
		SignatureHTML: &noSignature,
	}
	raw, _, _, err := service.buildOutgoingMessage(session, input, nil, nil, nil, nil,
		[]MailOutgoingAttachment{{Filename: "quote.pdf", ContentType: "application/pdf", Data: []byte("%PDF")}})
	if err != nil {
		t.Fatal(err)
	}
	source := strings.ToLower(string(raw))
	for _, want := range []string{"multipart/mixed", "multipart/related", "multipart/alternative", "content-id: <yaerp-img-", "cid:yaerp-img-"} {
		if !strings.Contains(source, want) {
			t.Fatalf("raw message misses %q:\n%s", want, raw)
		}
	}
	if strings.Contains(source, "legacy signature") {
		t.Fatal("an explicitly empty signature must not be replaced by the account signature")
	}

	parsed, err := service.parseMailData(raw)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(parsed.HTMLBody, "data:image/png;base64,") {
		t.Fatalf("inline image did not round trip: %s", parsed.HTMLBody)
	}
	if !strings.Contains(parsed.HTMLBody, "M9R84240") || !strings.Contains(parsed.HTMLBody, "<table") {
		t.Fatalf("quoted table lost: %s", parsed.HTMLBody)
	}
	attachments := 0
	for _, attachment := range parsed.Attachments {
		if !attachment.Inline {
			attachments++
		}
	}
	if attachments != 1 {
		t.Fatalf("expected only the PDF as a regular attachment, got %+v", parsed.Attachments)
	}
}
