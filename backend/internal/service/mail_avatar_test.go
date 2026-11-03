package service

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/png"
	"strings"
	"testing"
)

func testPNGDataURI(t *testing.T, width, height int) string {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, width, height))); err != nil {
		t.Fatal(err)
	}
	return "data:image/png;base64," + base64.StdEncoding.EncodeToString(buffer.Bytes())
}

func TestSenderAvatarIgnoresQuotedAndContentImages(t *testing.T) {
	small := testPNGDataURI(t, 64, 64)
	photo := testPNGDataURI(t, 800, 600)
	cases := map[string]struct {
		html   string
		sender string
		inline map[string]string
	}{
		// A customer's reply quotes our earlier mail ("To: customer@...") and the
		// images we sent; none of them is the customer's avatar.
		"image in the quote under To: sender": {
			html: `<div>Thanks, received.<br>John<br>john@customer.com</div>` +
				`<div style="border-top:1px solid #ccc"><b>From:</b> Sales &lt;sales@us.com&gt;<br><b>To:</b> john@customer.com</div>` +
				`<div><img src="cid:sent-image"></div>`,
			sender: "john@customer.com",
			inline: map[string]string{"sent-image": small},
		},
		"image inside a blockquote": {
			html:   `<p>See below</p><blockquote><p>john@customer.com</p><img src="cid:q"></blockquote>`,
			sender: "john@customer.com",
			inline: map[string]string{"q": small},
		},
		"outlook reply header": {
			html:   `<p>OK</p><div id="divRplyFwdMsg"><b>发件人:</b> john@customer.com</div><img src="cid:q" width="64" height="64">`,
			sender: "john@customer.com",
			inline: map[string]string{"q": small},
		},
		// A photo pasted into a short mail sits next to the signature.
		"pasted photo above the signature": {
			html:   `<div>Please check the damage:<br><img src="cid:photo"><br>--<br>John<br>john@customer.com</div>`,
			sender: "john@customer.com",
			inline: map[string]string{"photo": photo},
		},
		"large part served by link": {
			html:   `<div>Photo:<br><img src="cid:big"><br>John<br>john@customer.com</div>`,
			sender: "john@customer.com",
			inline: map[string]string{"big": "/api/mail/file?t=abc"},
		},
	}
	for name, test := range cases {
		cleaned, avatar, _ := extractMailSenderAvatar(test.html, "John", test.sender, test.inline)
		if avatar != "" || !strings.Contains(cleaned, "<img") {
			t.Errorf("%s: a content image was taken as the avatar: avatar=%.40q html=%s", name, avatar, cleaned)
		}
	}
}

func TestMailImageSourcesSurviveSanitizing(t *testing.T) {
	policy := newMailHTMLPolicy()
	cases := map[string]struct{ in, want string }{
		"space in URL":         {`<img src="https://cdn.example.com/Product Photo 01.jpg">`, `src="https://cdn.example.com/Product%20Photo%2001.jpg"`},
		"lazy data-src":        {`<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="https://cdn.example.com/real.jpg">`, `src="https://cdn.example.com/real.jpg"`},
		"lazy placeholder gif": {`<img src="https://cdn.example.com/img/blank.gif" data-original="https://cdn.example.com/real.jpg">`, `src="https://cdn.example.com/real.jpg"`},
		"srcset only":          {`<img srcset="https://cdn.example.com/a.jpg 1x, https://cdn.example.com/a@2x.jpg 2x">`, `src="https://cdn.example.com/a.jpg"`},
		"ordinary image":       {`<img src="https://cdn.example.com/a.jpg" data-src="https://cdn.example.com/b.jpg">`, `src="https://cdn.example.com/a.jpg"`},
		"embedded image":       {`<img src="` + testPNGDataURI(t, 20, 20) + `">`, `src="data:image/png;base64,`},
	}
	for name, test := range cases {
		got := policy.Sanitize(normalizeMailImageSources(test.in))
		if !strings.Contains(got, test.want) {
			t.Errorf("%s: got %s, want it to contain %s", name, got, test.want)
		}
	}
	plain := `<p>no images</p>`
	if got := normalizeMailImageSources(plain); got != plain {
		t.Fatalf("html without images changed: %s", got)
	}
}

func TestOwnMailKeepsItsImagesAndDownloadsKeepAvatarParts(t *testing.T) {
	small := testPNGDataURI(t, 64, 64)
	payload := strings.TrimPrefix(small, "data:image/png;base64,")
	raw := strings.Join([]string{
		"From: Sales <sales@us.com>", "To: john@customer.com", "Subject: photo", "MIME-Version: 1.0",
		`Content-Type: multipart/related; boundary="b"`, "",
		"--b", "Content-Type: text/html; charset=utf-8", "",
		`<div>See picture<br><img src="cid:pic"><br>Sales<br>sales@us.com</div>`,
		"--b", "Content-Type: image/png", "Content-ID: <pic>", "Content-Transfer-Encoding: base64", "", payload,
		"--b--", "",
	}, "\r\n")
	service := &MailService{}
	service.htmlPolicy = newMailHTMLPolicy()

	parsed, err := service.parseMailDataWithOptions([]byte(raw), mailParseOptions{extractAvatar: true, ownAddress: "SALES@us.com"})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SenderAvatar != "" || !strings.Contains(parsed.HTMLBody, "<img") {
		t.Fatalf("own mail lost its image to the avatar: avatar=%.40q html=%s", parsed.SenderAvatar, parsed.HTMLBody)
	}

	parsed, err = service.parseMailData([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SenderAvatar != "" || len(parsed.Attachments) != 1 {
		t.Fatalf("download parse dropped the image part: avatar=%.40q attachments=%d", parsed.SenderAvatar, len(parsed.Attachments))
	}

	parsed, err = service.parseMailDataWithOptions([]byte(raw), mailParseOptions{extractAvatar: true, ownAddress: "other@us.com"})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.SenderAvatar == "" {
		t.Fatal("an avatar-sized image in someone else's signature should still become the avatar")
	}
}
