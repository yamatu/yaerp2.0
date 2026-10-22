package service

import (
	"encoding/base64"
	"strings"
	"testing"
)

// 1x1 PNG.
var testMailPNG, _ = base64.StdEncoding.DecodeString("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

func TestParseMailResolvesOutlookInlineImages(t *testing.T) {
	image := base64.StdEncoding.EncodeToString(testMailPNG)
	raw := strings.Join([]string{
		"From: Sender <sender@example.com>",
		"To: me@example.com",
		"Subject: images",
		"MIME-Version: 1.0",
		`Content-Type: multipart/related; boundary="b1"`,
		"",
		"--b1",
		"Content-Type: text/html; charset=utf-8",
		"",
		`<p><img src="cid:image001.png@01DA1234.ABCD"> <img src="CID:Image002%40host"></p>`,
		"--b1",
		// Some clients label inline images application/octet-stream.
		"Content-Type: application/octet-stream",
		"Content-ID: <image001.png@01DA1234.ABCD>",
		"Content-Transfer-Encoding: base64",
		"",
		image,
		"--b1",
		"Content-Type: image/png",
		"Content-ID: <image002@host>",
		"Content-Disposition: inline",
		"Content-Transfer-Encoding: base64",
		"",
		image,
		"--b1--",
		"",
	}, "\r\n")
	parsed, err := NewMailService(nil, nil, "test-secret").parseMailData([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(parsed.HTMLBody), "cid:") {
		t.Fatalf("unresolved cid reference left: %s", parsed.HTMLBody)
	}
	if got := strings.Count(parsed.HTMLBody, `src="data:image/png;base64,`); got != 2 {
		t.Fatalf("want 2 embedded images, got %d: %s", got, parsed.HTMLBody)
	}
}

func TestParseMailKeepsExcelTableFormatting(t *testing.T) {
	html := `<html><head><style><!--
.xl65 {border:.5pt solid windowtext; background:yellow; font-weight:700; mso-number-format:"\@";}
td {font-size:11.0pt; color:black}
td.num {text-align:right}
@media screen { td { color:red } }
.evil {background:url(javascript:alert(1)); width:expression(alert(1)); position:fixed}
--></style></head><body>
<table align="center" bgcolor="#f4f4f4" border="0" cellpadding="0" cellspacing="0" width="600" style="border-collapse:collapse;table-layout:fixed">
<tr bgcolor="#eeeeee"><td class="xl65" style="height:15.0pt;width:54pt">品名</td><td class="xl65 num" style="border-left:none">1,200</td></tr>
<tr><td class="evil" style="border:solid windowtext 1.0pt;border-top:none">x</td><td style="border-width:1px;border-style:solid;border-color:#ccc;font-weight:800">y</td></tr>
</table></body></html>`
	raw := "From: a@example.com\r\nTo: b@example.com\r\nSubject: t\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + html
	parsed, err := NewMailService(nil, nil, "test-secret").parseMailData([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	body := parsed.HTMLBody
	for _, want := range []string{
		`align="center"`, `bgcolor="#f4f4f4"`, `bgcolor="#eeeeee"`, "table-layout: fixed",
		"border: .5pt solid windowtext", "background: yellow", "font-weight: 700", "font-size: 11.0pt",
		"text-align: right", "border-left: none", "border: solid windowtext 1.0pt",
		"border-width: 1px", "border-style: solid", "font-weight: 800", "height: 15.0pt",
	} {
		if !strings.Contains(body, want) {
			t.Errorf("missing %q in %s", want, body)
		}
	}
	for _, unwanted := range []string{"<style", "javascript", "expression", "position", "color: red", "mso-"} {
		if strings.Contains(strings.ToLower(body), unwanted) {
			t.Errorf("unexpected %q in %s", unwanted, body)
		}
	}
	// CSS precedence: tag rule, then class rule, then tag.class, then the
	// element's own style (so border-left:none overrides the class border).
	if !strings.Contains(body, "font-size: 11.0pt; color: black; border: .5pt solid windowtext; background: yellow; font-weight: 700; text-align: right; border-left: none") {
		t.Errorf("rule order not kept: %s", body)
	}
}

func TestSenderAvatarLeavesContentImagesInBody(t *testing.T) {
	for name, htmlValue := range map[string]string{
		"wechat image":      `<p>活动海报</p><img src="https://mmbiz.qpic.cn/mmbiz_jpg/abc/640" width="80" height="80"><p>正文</p>`,
		"header banner":     `<img src="https://cdn.newsletter.net/images/header.png" width="120" height="120"><p>正文</p>`,
		"product thumbnail": `<table><tr><td><img src="cid:item1" width="80" height="80"></td><td>商品 A</td></tr></table>`,
	} {
		cleaned, avatar, _ := extractMailSenderAvatar(htmlValue, "Sender", "sender@example.com", map[string]string{"item1": "data:image/png;base64,aXRlbQ=="})
		if avatar != "" || !strings.Contains(cleaned, "<img") {
			t.Errorf("%s: content image was taken as the sender avatar: avatar=%q html=%s", name, avatar, cleaned)
		}
	}
}

func TestInlineMailStyleSheetsWithoutStyleIsUnchanged(t *testing.T) {
	html := `<p class="x">hi</p>`
	if got := inlineMailStyleSheets(html); got != html {
		t.Fatalf("changed html without <style>: %s", got)
	}
}
