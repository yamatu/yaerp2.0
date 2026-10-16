package service

import (
	"encoding/base64"
	"fmt"
	"hash/fnv"
	"io"
	"regexp"
	"strings"

	gomessage "github.com/emersion/go-message"
	gomail "github.com/emersion/go-message/mail"
)

// A reply quotes the original message, whose inline images reach the browser
// as data: URIs. Gmail and several webmail clients refuse data: images, so they
// are moved into multipart/related parts referenced by cid: before sending.
// SVG is left alone on purpose: it can carry script and is rarely inline.
var mailDataImagePattern = regexp.MustCompile(`(?i)(<img\b[^>]*?\bsrc\s*=\s*")data:(image/(?:png|jpe?g|gif|webp|bmp));base64,([a-z0-9+/=\s]+)(")`)

// mailInlineImageLimit bounds the decoded size of all inline images of one
// message; larger payloads stay as data: URIs rather than growing the mail.
const mailInlineImageLimit = 25 << 20

type mailInlineImage struct {
	ContentID   string
	ContentType string
	Data        []byte
}

var mailInlineImageExtensions = map[string]string{
	"image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg",
	"image/gif": ".gif", "image/webp": ".webp", "image/bmp": ".bmp",
}

// extractMailInlineImages rewrites data: image sources to cid: references and
// returns the decoded images. Identical images share one part.
func extractMailInlineImages(htmlBody, domain string) (string, []mailInlineImage) {
	if !strings.Contains(strings.ToLower(htmlBody), "data:image/") {
		return htmlBody, nil
	}
	if strings.TrimSpace(domain) == "" {
		domain = "localhost"
	}
	images := make([]mailInlineImage, 0)
	byPayload := make(map[uint64]string)
	total := 0
	result := mailDataImagePattern.ReplaceAllStringFunc(htmlBody, func(match string) string {
		parts := mailDataImagePattern.FindStringSubmatch(match)
		payload := strings.Join(strings.Fields(parts[3]), "")
		hasher := fnv.New64a()
		_, _ = hasher.Write([]byte(payload))
		key := hasher.Sum64()
		contentID, seen := byPayload[key]
		if !seen {
			data, err := base64.StdEncoding.DecodeString(payload)
			if err != nil {
				data, err = base64.RawStdEncoding.DecodeString(strings.TrimRight(payload, "="))
			}
			if err != nil || len(data) == 0 || total+len(data) > mailInlineImageLimit {
				return match
			}
			total += len(data)
			contentID = fmt.Sprintf("yaerp-img-%d-%x@%s", len(images)+1, key, domain)
			images = append(images, mailInlineImage{ContentID: contentID, ContentType: strings.ToLower(parts[2]), Data: data})
			byPayload[key] = contentID
		}
		return parts[1] + "cid:" + contentID + parts[4]
	})
	return result, images
}

// writeMailBody writes the MIME tree of an outgoing message:
//
//	multipart/mixed
//	├─ multipart/related           (only with inline images)
//	│  ├─ multipart/alternative    text/plain + text/html
//	│  └─ image parts              Content-ID referenced by the HTML
//	└─ attachments
func writeMailBody(w io.Writer, header gomail.Header, textBody, htmlBody string, images []mailInlineImage, attachments []MailOutgoingAttachment) error {
	header.SetContentType("multipart/mixed", nil)
	root, err := gomessage.CreateWriter(w, header.Header)
	if err != nil {
		return err
	}
	body := root
	var related *gomessage.Writer
	if len(images) > 0 {
		var relatedHeader gomessage.Header
		relatedHeader.SetContentType("multipart/related", map[string]string{"type": "multipart/alternative"})
		if related, err = root.CreatePart(relatedHeader); err != nil {
			return err
		}
		body = related
	}

	var alternativeHeader gomessage.Header
	alternativeHeader.SetContentType("multipart/alternative", nil)
	alternative, err := body.CreatePart(alternativeHeader)
	if err != nil {
		return err
	}
	if err := writeMailTextPart(alternative, "text/plain", textBody); err != nil {
		return err
	}
	if htmlBody != "" {
		if err := writeMailTextPart(alternative, "text/html", htmlBody); err != nil {
			return err
		}
	}
	if err := alternative.Close(); err != nil {
		return err
	}

	for index, image := range images {
		var imageHeader gomessage.Header
		imageHeader.SetContentType(image.ContentType, nil)
		imageHeader.Set("Content-Transfer-Encoding", "base64")
		imageHeader.Set("Content-ID", "<"+image.ContentID+">")
		imageHeader.SetContentDisposition("inline", map[string]string{
			"filename": fmt.Sprintf("image-%d%s", index+1, mailInlineImageExtensions[image.ContentType]),
		})
		part, err := related.CreatePart(imageHeader)
		if err != nil {
			return err
		}
		if _, err := part.Write(image.Data); err != nil {
			return err
		}
		if err := part.Close(); err != nil {
			return err
		}
	}
	if related != nil {
		if err := related.Close(); err != nil {
			return err
		}
	}

	for _, attachment := range attachments {
		var attachmentHeader gomail.AttachmentHeader
		contentType := strings.TrimSpace(attachment.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		attachmentHeader.Set("Content-Type", contentType)
		attachmentHeader.SetFilename(attachment.Filename)
		attachmentHeader.Set("Content-Transfer-Encoding", "base64")
		part, err := root.CreatePart(attachmentHeader.Header)
		if err != nil {
			return err
		}
		if _, err := part.Write(attachment.Data); err != nil {
			return err
		}
		if err := part.Close(); err != nil {
			return err
		}
	}
	return root.Close()
}

func writeMailTextPart(parent *gomessage.Writer, contentType, body string) error {
	var header gomessage.Header
	header.SetContentType(contentType, map[string]string{"charset": "utf-8"})
	header.Set("Content-Transfer-Encoding", "quoted-printable")
	header.Set("Content-Disposition", "inline")
	part, err := parent.CreatePart(header)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(part, body); err != nil {
		return err
	}
	return part.Close()
}
