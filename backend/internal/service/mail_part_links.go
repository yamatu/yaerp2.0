package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// Mail parts (attachments and the images of a message body) are served through
// signed, expiring links instead of the session API, so that an <img> in the
// sandboxed mail frame, a PDF viewer tab or a native browser download can load
// them directly: range requests, progressive loading, no copy in page memory.
const (
	mailPartLinkTTL  = 12 * time.Hour
	mailPartLinkPath = "/api/mail/file"
)

var ErrMailPartLinkInvalid = errors.New("附件链接无效或已过期，请重新打开邮件")

type mailPartLinkClaims struct {
	UserID    int64  `json:"u"`
	AccountID int64  `json:"a"`
	Folder    string `json:"f"`
	UID       uint32 `json:"m"`
	PartID    string `json:"p"`
	Expires   int64  `json:"e"`
}

func (s *MailService) mailPartLinkKey() []byte {
	sum := sha256.Sum256(append(append([]byte{}, s.encryptionKey[:]...), []byte(":mail-part-link")...))
	return sum[:]
}

func (s *MailService) signMailPartLink(claims mailPartLinkClaims) string {
	payload, _ := json.Marshal(claims)
	encoded := base64.RawURLEncoding.EncodeToString(payload)
	mac := hmac.New(sha256.New, s.mailPartLinkKey())
	_, _ = mac.Write([]byte(encoded))
	return encoded + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// mailPartURL returns the signed link of one part of a message of the account.
func (s *MailService) mailPartURL(userID, accountID int64, folder string, uid uint32, partID string) string {
	token := s.signMailPartLink(mailPartLinkClaims{
		UserID: userID, AccountID: accountID, Folder: folder, UID: uid, PartID: partID,
		Expires: time.Now().Add(mailPartLinkTTL).Unix(),
	})
	return mailPartLinkPath + "?t=" + url.QueryEscape(token)
}

func (s *MailService) verifyMailPartLink(token string) (*mailPartLinkClaims, error) {
	encoded, signature, ok := strings.Cut(strings.TrimSpace(token), ".")
	if !ok || encoded == "" || signature == "" {
		return nil, ErrMailPartLinkInvalid
	}
	given, err := base64.RawURLEncoding.DecodeString(signature)
	if err != nil {
		return nil, ErrMailPartLinkInvalid
	}
	mac := hmac.New(sha256.New, s.mailPartLinkKey())
	_, _ = mac.Write([]byte(encoded))
	if !hmac.Equal(given, mac.Sum(nil)) {
		return nil, ErrMailPartLinkInvalid
	}
	payload, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, ErrMailPartLinkInvalid
	}
	var claims mailPartLinkClaims
	if err := json.Unmarshal(payload, &claims); err != nil || claims.UserID <= 0 || claims.UID == 0 || claims.PartID == "" {
		return nil, ErrMailPartLinkInvalid
	}
	if time.Now().Unix() > claims.Expires {
		return nil, ErrMailPartLinkInvalid
	}
	return &claims, nil
}

// OpenMailPartLink returns the part a signed link points to. The link names
// the account it was issued for; after switching accounts the same UID would
// be another message, so such links are refused.
func (s *MailService) OpenMailPartLink(token string) (filename, contentType string, data []byte, err error) {
	claims, err := s.verifyMailPartLink(token)
	if err != nil {
		return "", "", nil, err
	}
	account, err := s.repo.GetAccount(claims.UserID)
	if err != nil {
		return "", "", nil, err
	}
	if account.ID != claims.AccountID {
		return "", "", nil, ErrMailPartLinkInvalid
	}
	return s.DownloadAttachment(claims.UserID, claims.Folder, claims.UID, claims.PartID)
}

// mailPartLinkFromURL extracts the claims of a link this service issued, used
// to turn quoted body images back into message parts when replying.
func (s *MailService) mailPartLinkFromURL(value string) (*mailPartLinkClaims, bool) {
	value = strings.ReplaceAll(strings.TrimSpace(value), "&amp;", "&")
	index := strings.Index(value, mailPartLinkPath+"?")
	if index < 0 {
		return nil, false
	}
	query, err := url.ParseQuery(value[index+len(mailPartLinkPath)+1:])
	if err != nil {
		return nil, false
	}
	claims, err := s.verifyMailPartLink(query.Get("t"))
	return claims, err == nil
}

// MailInlineServable reports whether a part may be shown inline on the site's
// origin. Anything that can run script (HTML, SVG, XML) is always downloaded.
func MailInlineServable(contentType string) bool {
	contentType = strings.ToLower(strings.TrimSpace(strings.SplitN(contentType, ";", 2)[0]))
	switch contentType {
	case "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/avif",
		"application/pdf", "text/plain":
		return true
	}
	return strings.HasPrefix(contentType, "audio/") || strings.HasPrefix(contentType, "video/")
}

var mailPartLinkSource = regexp.MustCompile(`(?i)(\bsrc\s*=\s*["'])([^"']*` + regexp.QuoteMeta(mailPartLinkPath) + `\?[^"']*)(["'])`)

// embedMailPartLinks replaces body images that point to this service's part
// links (a reply or forward quoting the original message) with the image
// bytes as data: URIs, which the sender then turns into message parts. A
// recipient can never open those links, and they expire.
func (s *MailService) embedMailPartLinks(userID int64, htmlBody string) string {
	if !strings.Contains(htmlBody, mailPartLinkPath) {
		return htmlBody
	}
	account, err := s.repo.GetAccount(userID)
	if err != nil {
		return htmlBody
	}
	embedded := map[string]string{}
	total := 0
	return mailPartLinkSource.ReplaceAllStringFunc(htmlBody, func(match string) string {
		parts := mailPartLinkSource.FindStringSubmatch(match)
		if cached, ok := embedded[parts[2]]; ok {
			return parts[1] + cached + parts[3]
		}
		claims, ok := s.mailPartLinkFromURL(parts[2])
		if !ok || claims.UserID != userID || claims.AccountID != account.ID {
			return match
		}
		_, contentType, data, err := s.DownloadAttachment(claims.UserID, claims.Folder, claims.UID, claims.PartID)
		imageType := mailInlineImageType(contentType, data)
		if err != nil || imageType == "" || total+len(data) > mailInlineImageLimit {
			return match
		}
		total += len(data)
		uri := "data:" + imageType + ";base64," + base64.StdEncoding.EncodeToString(data)
		embedded[parts[2]] = uri
		return parts[1] + uri + parts[3]
	})
}
