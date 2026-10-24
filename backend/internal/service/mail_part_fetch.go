package service

import (
	"bufio"
	"bytes"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	gomessage "github.com/emersion/go-message"
	"github.com/emersion/go-message/textproto"
)

// mailPartInfo describes one leaf part of a message the way the parser and
// the attachment numbering see it. The full parse, the part fetch and the
// rebuilt display message all use it, so attachment IDs mean the same part.
type mailPartInfo struct {
	contentType string
	filename    string
	contentID   string
	// bodyText parts form the message text; every other leaf is an
	// attachment and gets the next attachment number.
	bodyText bool
}

func describeMailPart(get func(string) string) mailPartInfo {
	rawType := get("Content-Type")
	if strings.TrimSpace(rawType) == "" {
		rawType = "text/plain" // RFC 2045 default, and what IMAP servers report
	}
	contentType, params := parseMailMediaType(rawType)
	disposition, dispositionParams := parseMailMediaType(get("Content-Disposition"))
	filename := dispositionParams["filename"]
	if filename == "" {
		filename = params["name"]
	}
	return mailPartInfo{
		contentType: contentType,
		filename:    sanitizeMailFilename(decodeMailHeaderValue(filename)),
		contentID:   strings.Trim(strings.TrimSpace(get("Content-ID")), "<>"),
		bodyText:    strings.HasPrefix(contentType, "text/") && !strings.EqualFold(disposition, "attachment"),
	}
}

// finish completes an attachment's description once its bytes are known and
// returns its image type ("" when it is not an image).
func (info *mailPartInfo) finish(index int, content []byte) string {
	imageType := mailInlineImageType(info.contentType, content)
	if imageType != "" && !strings.HasPrefix(info.contentType, "image/") {
		// Outlook sends some images as application/octet-stream.
		info.contentType = imageType
	}
	if info.filename == "" {
		info.filename = fmt.Sprintf("attachment-%d%s", index, mailExtensionForType(info.contentType))
	}
	return imageType
}

// synthesizeMailPartHeader writes the MIME header of a part from the
// server's BODYSTRUCTURE. Part headers are not fetched (BODY[n.MIME]) because
// servers are not reliable there; one test server returned the parent's
// header for every nested part.
func synthesizeMailPartHeader(part *imap.BodyStructure) []byte {
	var out bytes.Buffer
	mediaType := strings.ToLower(part.MIMEType + "/" + part.MIMESubType)
	if part.MIMEType == "" {
		mediaType = "text/plain"
	}
	out.WriteString("Content-Type: " + mediaType + formatMailParams(part.Params) + "\r\n")
	if part.Encoding != "" {
		out.WriteString("Content-Transfer-Encoding: " + strings.ToLower(part.Encoding) + "\r\n")
	}
	if part.Id != "" {
		out.WriteString("Content-ID: " + strings.TrimSpace(part.Id) + "\r\n")
	}
	if part.Disposition != "" {
		out.WriteString("Content-Disposition: " + strings.ToLower(part.Disposition) + formatMailParams(part.DispositionParams) + "\r\n")
	}
	return out.Bytes()
}

func formatMailParams(params map[string]string) string {
	keys := make([]string, 0, len(params))
	for key := range params {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	var out strings.Builder
	for _, key := range keys {
		value := params[key]
		if strings.ContainsAny(key, " \t\r\n;=\"") || strings.ContainsAny(value, "\r\n") {
			continue
		}
		if strings.HasSuffix(key, "*") {
			// RFC 2231 extended value (charset''percent-encoded), kept as is.
			out.WriteString("; " + key + "=" + value)
			continue
		}
		out.WriteString("; " + key + "=\"" + strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(value) + "\"")
	}
	return out.String()
}

type mailStructureLeaf struct {
	path      []int
	structure *imap.BodyStructure
	header    []byte
	info      mailPartInfo
	// attachment is the attachment number of the leaf, 0 for body text.
	attachment int
}

// mailStructureLeaves lists the leaf parts of a multipart message in the
// order the parser reads them, numbering the attachments the same way.
func mailStructureLeaves(structure *imap.BodyStructure) []*mailStructureLeaf {
	var leaves []*mailStructureLeaf
	index := 0
	structure.Walk(func(path []int, part *imap.BodyStructure) bool {
		if len(part.Parts) > 0 || len(path) == 0 {
			return true
		}
		header := synthesizeMailPartHeader(part)
		parsed, err := textproto.ReadHeader(bufio.NewReader(bytes.NewReader(append(append([]byte{}, header...), '\r', '\n'))))
		if err != nil {
			parsed = textproto.Header{}
		}
		leaf := &mailStructureLeaf{path: append([]int(nil), path...), structure: part, header: header, info: describeMailPart(parsed.Get)}
		if !leaf.info.bodyText {
			index++
			leaf.attachment = index
		}
		leaves = append(leaves, leaf)
		return true
	})
	return leaves
}

// fetchMailAttachmentPart downloads only the attachment numbered partID
// instead of the whole message. ok is false when it cannot answer (single
// part message, or the part differs from what was listed when the message
// was opened); the caller then fetches the whole message.
func (s *MailService) fetchMailAttachmentPart(conn *imapclient.Client, key mailAttachmentCacheKey) (filename, contentType string, data []byte, ok bool) {
	target, err := strconv.Atoi(key.partID)
	if err != nil || target <= 0 {
		return "", "", nil, false
	}
	seqset := new(imap.SeqSet)
	seqset.AddNum(key.uid)
	structure, err := fetchMailBodyStructure(conn, seqset)
	if err != nil || len(structure.Parts) == 0 {
		return "", "", nil, false
	}
	for _, leaf := range mailStructureLeaves(structure) {
		if leaf.attachment != target {
			continue
		}
		// Compare what the headers say: the bytes refine type and default name
		// only after the fetch, and a large message is listed without them.
		if listed, known := s.mailPartIndex().get(key); known && (listed.filename != leaf.info.filename || listed.contentType != leaf.info.contentType) {
			return "", "", nil, false
		}
		section := &imap.BodySectionName{BodyPartName: imap.BodyPartName{Path: leaf.path}, Peek: true}
		message, err := fetchOneMessage(conn, seqset, []imap.FetchItem{section.FetchItem()})
		if err != nil {
			return "", "", nil, false
		}
		body := message.GetBody(section)
		if body == nil {
			return "", "", nil, false
		}
		raw, err := io.ReadAll(io.LimitReader(body, mailMaxRawMessageSize+1))
		if err != nil || len(raw) > mailMaxRawMessageSize {
			return "", "", nil, false
		}
		header, err := textproto.ReadHeader(bufio.NewReader(bytes.NewReader(append(append([]byte{}, leaf.header...), '\r', '\n'))))
		if err != nil {
			return "", "", nil, false
		}
		// Decode the transfer encoding (and charset of text parts) like the
		// message parser does.
		entity, err := gomessage.New(gomessage.Header{Header: header}, bytes.NewReader(raw))
		if err != nil && !gomessage.IsUnknownCharset(err) && !gomessage.IsUnknownEncoding(err) {
			return "", "", nil, false
		}
		content, err := io.ReadAll(entity.Body)
		if err != nil {
			return "", "", nil, false
		}
		info := leaf.info
		info.finish(target, content)
		return info.filename, info.contentType, content, true
	}
	return "", "", nil, false
}

// mailPartIndexEntry is what the message detail listed for a part number.
type mailPartIndexEntry struct {
	filename    string
	contentType string
	listedAt    time.Time
}

// mailPartIndex remembers, per opened message, which file each attachment
// number named, so a part fetched on its own can be checked against it.
type mailPartIndex struct {
	mu      sync.Mutex
	entries map[mailAttachmentCacheKey]mailPartIndexEntry
}

const (
	mailPartIndexTTL = mailPartLinkTTL
	mailPartIndexMax = 20000
)

func (index *mailPartIndex) put(key mailAttachmentCacheKey, filename, contentType string) {
	index.mu.Lock()
	defer index.mu.Unlock()
	now := time.Now()
	if len(index.entries) >= mailPartIndexMax {
		for existing, entry := range index.entries {
			if now.Sub(entry.listedAt) > mailPartIndexTTL || len(index.entries) >= mailPartIndexMax {
				delete(index.entries, existing)
			}
		}
	}
	index.entries[key] = mailPartIndexEntry{filename: filename, contentType: contentType, listedAt: now}
}

func (index *mailPartIndex) get(key mailAttachmentCacheKey) (mailPartIndexEntry, bool) {
	index.mu.Lock()
	defer index.mu.Unlock()
	entry, ok := index.entries[key]
	if !ok || time.Since(entry.listedAt) > mailPartIndexTTL {
		return mailPartIndexEntry{}, false
	}
	return entry, true
}

func (index *mailPartIndex) invalidateUser(userID int64) {
	index.mu.Lock()
	defer index.mu.Unlock()
	for key := range index.entries {
		if key.userID == userID {
			delete(index.entries, key)
		}
	}
}

func fetchMailBodyStructure(conn *imapclient.Client, seqset *imap.SeqSet) (*imap.BodyStructure, error) {
	message, err := fetchOneMessage(conn, seqset, []imap.FetchItem{imap.FetchUid, imap.FetchBodyStructure})
	if err != nil {
		return nil, err
	}
	if message.BodyStructure == nil {
		return nil, fmt.Errorf("邮件结构读取失败")
	}
	return message.BodyStructure, nil
}

func fetchOneMessage(conn *imapclient.Client, seqset *imap.SeqSet, items []imap.FetchItem) (*imap.Message, error) {
	messages := make(chan *imap.Message, 1)
	done := make(chan error, 1)
	go func() { done <- conn.UidFetch(seqset, items, messages) }()
	var message *imap.Message
	for item := range messages {
		if message == nil {
			message = item
		}
	}
	if err := <-done; err != nil {
		return nil, err
	}
	if message == nil {
		return nil, ErrMailMessageNotFound
	}
	return message, nil
}

const (
	// Messages above this size are opened without their large parts.
	mailDisplayFullFetchMax = 6 << 20
	// Parts up to this encoded size are always fetched with the message.
	mailDisplaySmallPartMax = 96 << 10
	// mailOmittedSizeHeader marks a part whose body was left out when
	// opening a large message; it carries the part's decoded size estimate.
	mailOmittedSizeHeader = "X-Yaerp-Omitted-Size"
)

// fetchMailForDisplay returns the message to show. Large messages are
// rebuilt from their structure with only the text parts and small parts
// included, so opening a mail with big attachments or photos transfers little
// data; the omitted parts load on demand through fetchMailAttachmentPart.
func fetchMailForDisplay(conn *imapclient.Client, uid uint32) (*imap.Message, []byte, bool, error) {
	seqset := new(imap.SeqSet)
	seqset.AddNum(uid)
	topHeader := &imap.BodySectionName{BodyPartName: imap.BodyPartName{Specifier: imap.HeaderSpecifier}, Peek: true}
	message, err := fetchOneMessage(conn, seqset, []imap.FetchItem{
		imap.FetchUid, imap.FetchEnvelope, imap.FetchFlags, imap.FetchRFC822Size, imap.FetchBodyStructure, imap.FetchInternalDate, topHeader.FetchItem(),
	})
	if err != nil {
		return nil, nil, false, err
	}
	fullFetch := func() (*imap.Message, []byte, bool, error) {
		full, raw, err := fetchRawMail(conn, uid)
		return full, raw, false, err
	}
	structure := message.BodyStructure
	if message.Size <= mailDisplayFullFetchMax || structure == nil || len(structure.Parts) == 0 {
		return fullFetch()
	}
	headerLiteral := message.GetBody(topHeader)
	if headerLiteral == nil {
		return fullFetch()
	}
	header, err := io.ReadAll(headerLiteral)
	if err != nil {
		return nil, nil, false, err
	}

	leaves := mailStructureLeaves(structure)
	byPath := make(map[string]*mailStructureLeaf, len(leaves))
	sections := map[string]*imap.BodySectionName{}
	items := make([]imap.FetchItem, 0, len(leaves))
	for _, leaf := range leaves {
		key := fmt.Sprint(leaf.path)
		byPath[key] = leaf
		if leaf.info.bodyText || leaf.structure.Size <= mailDisplaySmallPartMax {
			section := &imap.BodySectionName{BodyPartName: imap.BodyPartName{Path: leaf.path}, Peek: true}
			sections[key] = section
			items = append(items, section.FetchItem())
		}
	}
	contents := map[string][]byte{}
	if len(items) > 0 {
		bodies, err := fetchOneMessage(conn, seqset, items)
		if err != nil {
			return nil, nil, false, err
		}
		for key, section := range sections {
			literal := bodies.GetBody(section)
			if literal == nil {
				return fullFetch()
			}
			if contents[key], err = io.ReadAll(literal); err != nil {
				return nil, nil, false, err
			}
		}
	}

	var out bytes.Buffer
	// Servers differ on whether a header section ends with the blank line.
	out.Write(bytes.TrimRight(header, "\r\n"))
	out.WriteString("\r\n\r\n")
	var writeChildren func(path []int, node *imap.BodyStructure) bool
	writeChildren = func(path []int, node *imap.BodyStructure) bool {
		boundary := node.Params["boundary"]
		if boundary == "" {
			return false
		}
		for index, child := range node.Parts {
			childPath := append(append([]int(nil), path...), index+1)
			out.WriteString("--" + boundary + "\r\n")
			if len(child.Parts) > 0 {
				out.Write(synthesizeMailPartHeader(child))
				out.WriteString("\r\n")
				if !writeChildren(childPath, child) {
					return false
				}
				out.WriteString("\r\n")
				continue
			}
			key := fmt.Sprint(childPath)
			leaf := byPath[key]
			if leaf == nil {
				return false
			}
			out.Write(leaf.header)
			content, fetched := contents[key]
			if !fetched {
				estimate := int64(child.Size)
				if strings.EqualFold(child.Encoding, "base64") {
					// 76 characters of base64 per 78 byte line, 3 bytes per 4 characters.
					estimate = estimate * 76 / 78 * 3 / 4
				}
				fmt.Fprintf(&out, "%s: %d\r\n", mailOmittedSizeHeader, estimate)
			}
			out.WriteString("\r\n")
			out.Write(content)
			out.WriteString("\r\n")
		}
		out.WriteString("--" + boundary + "--\r\n")
		return true
	}
	if !writeChildren(nil, structure) {
		return fullFetch()
	}
	return message, out.Bytes(), true, nil
}
