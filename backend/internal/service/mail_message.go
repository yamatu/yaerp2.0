package service

import (
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/emersion/go-imap"
	imapclient "github.com/emersion/go-imap/client"
	_ "github.com/emersion/go-message/charset"
	gomail "github.com/emersion/go-message/mail"
	"github.com/microcosm-cc/bluemonday"
	htmlparser "golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	htmlcharset "golang.org/x/net/html/charset"

	"yaerp/internal/model"
)

type parsedMailAttachment struct {
	model.MailAttachment
	Data []byte
}

type parsedMailData struct {
	Subject      string
	MessageID    string
	From         []model.MailAddress
	To           []model.MailAddress
	CC           []model.MailAddress
	BCC          []model.MailAddress
	ReplyTo      []model.MailAddress
	SenderAvatar string
	Date         time.Time
	TextBody     string
	HTMLBody     string
	InReplyTo    string
	References   []string
	Attachments  []parsedMailAttachment
}

type MailMessageListOptions struct {
	Query       string
	UnreadOnly  bool
	Participant string
	Filter      string
	StartDate   time.Time
	EndDate     time.Time
	SortBy      string
	SortOrder   string
}

var mailHeaderWordDecoder = &mime.WordDecoder{
	CharsetReader: func(charset string, input io.Reader) (io.Reader, error) {
		return htmlcharset.NewReaderLabel(charset, input)
	},
}

func (s *MailService) ListMessages(userID int64, folder string, page, pageSize int, options MailMessageListOptions) (*model.MailMessagePage, error) {
	folder, err := validateMailFolderName(folder)
	if err != nil {
		return nil, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 30
	}
	if pageSize > 100 {
		pageSize = 100
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return nil, err
	}
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	defer conn.Logout()
	if _, err := conn.Select(folder, true); err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	filter := strings.ToLower(strings.TrimSpace(options.Filter))
	switch filter {
	case "", "all", "unread", "attachment", "contacts":
	default:
		filter = "all"
	}
	sortBy := strings.ToLower(strings.TrimSpace(options.SortBy))
	if sortBy != "size" {
		sortBy = "date"
	}
	sortOrder := strings.ToLower(strings.TrimSpace(options.SortOrder))
	if sortOrder != "asc" {
		sortOrder = "desc"
	}

	criteria := imap.NewSearchCriteria()
	if value := strings.TrimSpace(options.Query); value != "" {
		criteria.Text = []string{value}
	}
	if options.UnreadOnly || filter == "unread" {
		criteria.WithoutFlags = []string{imap.SeenFlag}
	}
	if !options.StartDate.IsZero() {
		criteria.Since = options.StartDate
	}
	if !options.EndDate.IsZero() {
		criteria.Before = options.EndDate.AddDate(0, 0, 1)
	}
	if value := strings.TrimSpace(options.Participant); value != "" {
		fromCriteria := imap.NewSearchCriteria()
		fromCriteria.Header.Set("From", value)
		toCriteria := imap.NewSearchCriteria()
		toCriteria.Header.Set("To", value)
		ccCriteria := imap.NewSearchCriteria()
		ccCriteria.Header.Set("Cc", value)
		toOrCC := imap.NewSearchCriteria()
		toOrCC.Or = append(toOrCC.Or, [2]*imap.SearchCriteria{toCriteria, ccCriteria})
		criteria.Or = append(criteria.Or, [2]*imap.SearchCriteria{fromCriteria, toOrCC})
	}
	uids, err := conn.UidSearch(criteria)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	sort.Slice(uids, func(i, j int) bool { return uids[i] < uids[j] })
	needsPostFilter := filter == "attachment" || filter == "contacts" || sortBy == "size"
	if needsPostFilter {
		messagesByUID, fetchErr := fetchMailSummaries(conn, folder, uids)
		if fetchErr != nil {
			s.recordFailure(userID, fetchErr)
			return nil, fetchErr
		}
		all := make([]model.MailMessageSummary, 0, len(uids))
		for _, uid := range uids {
			if summary, exists := messagesByUID[uid]; exists {
				all = append(all, summary)
			}
		}
		if filter == "attachment" {
			filtered := all[:0]
			for _, summary := range all {
				if summary.HasAttachment {
					filtered = append(filtered, summary)
				}
			}
			all = filtered
		}
		if filter == "contacts" {
			contacts, contactErr := s.ListContacts(userID, "")
			if contactErr != nil {
				return nil, contactErr
			}
			contactEmails := make(map[string]struct{}, len(contacts))
			for _, contact := range contacts {
				if email := strings.ToLower(strings.TrimSpace(contact.Email)); email != "" {
					contactEmails[email] = struct{}{}
				}
			}
			filtered := all[:0]
			for _, summary := range all {
				if mailSummaryMatchesContacts(summary, contactEmails) {
					filtered = append(filtered, summary)
				}
			}
			all = filtered
		}
		sortMailSummaries(all, sortBy, sortOrder)
		total := len(all)
		offset := (page - 1) * pageSize
		result := &model.MailMessagePage{
			Folder: folder, Messages: make([]model.MailMessageSummary, 0), Page: page,
			PageSize: pageSize, Total: total, HasMore: offset+pageSize < total,
		}
		if offset < total {
			end := offset + pageSize
			if end > total {
				end = total
			}
			result.Messages = append(result.Messages, all[offset:end]...)
		}
		_ = s.repo.UpdateAccountStatus(userID, false, true, "")
		return result, nil
	}
	total := len(uids)
	offset := (page - 1) * pageSize
	result := &model.MailMessagePage{
		Folder: folder, Messages: make([]model.MailMessageSummary, 0), Page: page,
		PageSize: pageSize, Total: total, HasMore: offset+pageSize < total,
	}
	if offset >= total {
		return result, nil
	}
	end := offset + pageSize
	if end > total {
		end = total
	}
	selected := make([]uint32, 0, end-offset)
	if sortOrder == "asc" {
		selected = append(selected, uids[offset:end]...)
	} else {
		for index := total - 1 - offset; index >= total-end; index-- {
			selected = append(selected, uids[index])
		}
	}
	byUID, err := fetchMailSummaries(conn, folder, selected)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	for _, uid := range selected {
		if summary, exists := byUID[uid]; exists {
			result.Messages = append(result.Messages, summary)
		}
	}
	_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	return result, nil
}

func fetchMailSummaries(conn *imapclient.Client, folder string, uids []uint32) (map[uint32]model.MailMessageSummary, error) {
	result := make(map[uint32]model.MailMessageSummary, len(uids))
	items := []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, imap.FetchFlags, imap.FetchRFC822Size, imap.FetchBodyStructure, imap.FetchInternalDate}
	for start := 0; start < len(uids); start += 100 {
		end := start + 100
		if end > len(uids) {
			end = len(uids)
		}
		seqset := new(imap.SeqSet)
		seqset.AddNum(uids[start:end]...)
		messages := make(chan *imap.Message, end-start)
		if err := conn.UidFetch(seqset, items, messages); err != nil {
			return nil, err
		}
		for message := range messages {
			if message == nil || message.Uid == 0 {
				continue
			}
			result[message.Uid] = summarizeIMAPMessage(folder, message)
		}
	}
	return result, nil
}

func sortMailSummaries(messages []model.MailMessageSummary, sortBy, sortOrder string) {
	ascending := sortOrder == "asc"
	sort.SliceStable(messages, func(i, j int) bool {
		comparison := 0
		if sortBy == "size" {
			switch {
			case messages[i].Size < messages[j].Size:
				comparison = -1
			case messages[i].Size > messages[j].Size:
				comparison = 1
			}
		}
		if comparison == 0 {
			switch {
			case messages[i].Date.Before(messages[j].Date):
				comparison = -1
			case messages[i].Date.After(messages[j].Date):
				comparison = 1
			}
		}
		if ascending {
			return comparison < 0
		}
		return comparison > 0
	})
}

func mailSummaryMatchesContacts(summary model.MailMessageSummary, contacts map[string]struct{}) bool {
	for _, addresses := range [][]model.MailAddress{summary.From, summary.To} {
		for _, address := range addresses {
			if _, exists := contacts[strings.ToLower(strings.TrimSpace(address.Address))]; exists {
				return true
			}
		}
	}
	return false
}

func (s *MailService) GetMessage(userID int64, folder string, uid uint32) (*model.MailMessageDetail, error) {
	if uid == 0 {
		return nil, fmt.Errorf("无效的邮件标识")
	}
	folder, err := validateMailFolderName(folder)
	if err != nil {
		return nil, err
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return nil, err
	}
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	defer conn.Logout()
	if _, err := conn.Select(folder, false); err != nil {
		return nil, err
	}
	message, raw, err := fetchRawMail(conn, uid)
	if err != nil {
		return nil, err
	}
	parsed, err := s.parseMailData(raw)
	if err != nil {
		return nil, err
	}
	summary := summarizeIMAPMessage(folder, message)
	if parsed.Subject != "" {
		summary.Subject = parsed.Subject
	}
	if parsed.MessageID != "" {
		summary.MessageID = parsed.MessageID
	}
	if len(parsed.From) > 0 {
		summary.From = parsed.From
	}
	if len(parsed.To) > 0 {
		summary.To = parsed.To
	}
	if !parsed.Date.IsZero() {
		summary.Date = parsed.Date
	}
	detail := &model.MailMessageDetail{
		MailMessageSummary: summary,
		CC:                 parsed.CC, BCC: parsed.BCC, ReplyTo: parsed.ReplyTo,
		SenderAvatar: parsed.SenderAvatar,
		TextBody:     parsed.TextBody, HTMLBody: parsed.HTMLBody,
		InReplyTo: parsed.InReplyTo, References: parsed.References,
		Attachments: make([]model.MailAttachment, 0, len(parsed.Attachments)),
	}
	for _, attachment := range parsed.Attachments {
		detail.Attachments = append(detail.Attachments, attachment.MailAttachment)
	}
	if !summary.Read {
		seqset := new(imap.SeqSet)
		seqset.AddNum(uid)
		if err := updateMailFlag(conn, seqset, imap.SeenFlag, true); err == nil {
			detail.Read = true
		}
	}
	_ = s.repo.UpdateAccountStatus(userID, false, true, "")
	return detail, nil
}

func (s *MailService) DownloadAttachment(userID int64, folder string, uid uint32, partID string) (string, string, []byte, error) {
	if uid == 0 {
		return "", "", nil, fmt.Errorf("无效的邮件标识")
	}
	folder, err := validateMailFolderName(folder)
	if err != nil {
		return "", "", nil, err
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return "", "", nil, err
	}
	conn, err := s.connectIMAP(session.settings, session.account.LoginUsername, session.password)
	if err != nil {
		return "", "", nil, err
	}
	defer conn.Logout()
	if _, err := conn.Select(folder, true); err != nil {
		return "", "", nil, err
	}
	_, raw, err := fetchRawMail(conn, uid)
	if err != nil {
		return "", "", nil, err
	}
	parsed, err := s.parseMailData(raw)
	if err != nil {
		return "", "", nil, err
	}
	for _, attachment := range parsed.Attachments {
		if attachment.PartID == partID {
			return attachment.Filename, attachment.ContentType, attachment.Data, nil
		}
	}
	return "", "", nil, ErrMailMessageNotFound
}

func fetchRawMail(conn *imapclient.Client, uid uint32) (*imap.Message, []byte, error) {
	seqset := new(imap.SeqSet)
	seqset.AddNum(uid)
	section := &imap.BodySectionName{Peek: true}
	messages := make(chan *imap.Message, 1)
	items := []imap.FetchItem{imap.FetchUid, imap.FetchEnvelope, imap.FetchFlags, imap.FetchRFC822Size, imap.FetchBodyStructure, imap.FetchInternalDate, section.FetchItem()}
	if err := conn.UidFetch(seqset, items, messages); err != nil {
		return nil, nil, err
	}
	message, ok := <-messages
	if !ok || message == nil {
		return nil, nil, ErrMailMessageNotFound
	}
	body := message.GetBody(section)
	if body == nil {
		return nil, nil, fmt.Errorf("邮件正文读取失败")
	}
	raw, err := io.ReadAll(io.LimitReader(body, mailMaxRawMessageSize+1))
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > mailMaxRawMessageSize {
		return nil, nil, fmt.Errorf("邮件内容超过 64MB，无法在线打开")
	}
	return message, raw, nil
}

func (s *MailService) parseMailData(raw []byte) (*parsedMailData, error) {
	reader, err := gomail.CreateReader(strings.NewReader(string(raw)))
	if reader == nil {
		return nil, err
	}
	defer reader.Close()
	result := &parsedMailData{}
	result.Subject, _ = reader.Header.Subject()
	result.Subject = decodeMailHeaderValue(result.Subject)
	result.MessageID, _ = reader.Header.MessageID()
	result.Date, _ = reader.Header.Date()
	result.From = convertGoMailAddresses(mailHeaderAddresses(&reader.Header, "From"))
	result.To = convertGoMailAddresses(mailHeaderAddresses(&reader.Header, "To"))
	result.CC = convertGoMailAddresses(mailHeaderAddresses(&reader.Header, "Cc"))
	result.BCC = convertGoMailAddresses(mailHeaderAddresses(&reader.Header, "Bcc"))
	result.ReplyTo = convertGoMailAddresses(mailHeaderAddresses(&reader.Header, "Reply-To"))
	inReplyTo, _ := reader.Header.MsgIDList("In-Reply-To")
	if len(inReplyTo) > 0 {
		result.InReplyTo = inReplyTo[0]
	}
	result.References, _ = reader.Header.MsgIDList("References")
	attachmentIndex := 0
	inlineData := make(map[string]string)
	for {
		part, partErr := reader.NextPart()
		if partErr == io.EOF {
			break
		}
		if part == nil {
			if partErr != nil {
				return nil, partErr
			}
			continue
		}
		content, readErr := io.ReadAll(io.LimitReader(part.Body, mailMaxRawMessageSize+1))
		if readErr != nil {
			return nil, readErr
		}
		contentType, params := parseMailMediaType(part.Header.Get("Content-Type"))
		disposition, dispositionParams := parseMailMediaType(part.Header.Get("Content-Disposition"))
		filename := dispositionParams["filename"]
		if filename == "" {
			filename = params["name"]
		}
		filename = sanitizeMailFilename(decodeMailHeaderValue(filename))
		isText := strings.HasPrefix(contentType, "text/") && !strings.EqualFold(disposition, "attachment")
		if isText {
			switch strings.ToLower(contentType) {
			case "text/html":
				if result.HTMLBody != "" {
					result.HTMLBody += "<hr>"
				}
				result.HTMLBody += string(content)
			default:
				if result.TextBody != "" {
					result.TextBody += "\n\n"
				}
				result.TextBody += string(content)
			}
			continue
		}
		attachmentIndex++
		contentID := strings.Trim(strings.TrimSpace(part.Header.Get("Content-ID")), "<>")
		isInline := strings.EqualFold(disposition, "inline") || (contentID != "" && strings.HasPrefix(strings.ToLower(contentType), "image/"))
		if filename == "" {
			filename = fmt.Sprintf("attachment-%d%s", attachmentIndex, mailExtensionForType(contentType))
		}
		attachment := parsedMailAttachment{
			MailAttachment: model.MailAttachment{
				PartID: strconv.Itoa(attachmentIndex), Filename: filename, ContentType: contentType,
				Size: int64(len(content)), Inline: isInline, ContentID: contentID,
			},
			Data: content,
		}
		result.Attachments = append(result.Attachments, attachment)
		if contentID != "" && strings.HasPrefix(strings.ToLower(contentType), "image/") && len(content) <= 5<<20 {
			inlineData[contentID] = "data:" + contentType + ";base64," + base64.StdEncoding.EncodeToString(content)
		}
	}
	senderEmail := ""
	if len(result.From) > 0 {
		senderEmail = result.From[0].Address
	}
	var avatarContentID string
	result.HTMLBody, result.SenderAvatar, avatarContentID = extractMailSenderAvatar(result.HTMLBody, senderEmail, inlineData)
	if avatarContentID != "" {
		filtered := result.Attachments[:0]
		for _, attachment := range result.Attachments {
			if strings.EqualFold(attachment.ContentID, avatarContentID) {
				continue
			}
			filtered = append(filtered, attachment)
		}
		result.Attachments = filtered
	}
	for contentID, dataURI := range inlineData {
		result.HTMLBody = strings.ReplaceAll(result.HTMLBody, "cid:"+contentID, dataURI)
		result.HTMLBody = strings.ReplaceAll(result.HTMLBody, "CID:"+contentID, dataURI)
	}
	result.HTMLBody = s.htmlPolicy.Sanitize(result.HTMLBody)
	if result.TextBody == "" && result.HTMLBody != "" {
		result.TextBody = bluemondayText(result.HTMLBody)
	}
	return result, nil
}

func summarizeIMAPMessage(folder string, message *imap.Message) model.MailMessageSummary {
	result := model.MailMessageSummary{UID: message.Uid, Folder: folder, Size: message.Size}
	if message.Envelope != nil {
		result.MessageID = trimMessageID(message.Envelope.MessageId)
		result.Subject = decodeMailHeaderValue(message.Envelope.Subject)
		result.From = convertIMAPAddresses(message.Envelope.From)
		result.To = convertIMAPAddresses(message.Envelope.To)
		result.Date = message.Envelope.Date
	}
	if result.Subject == "" {
		result.Subject = "（无主题）"
	}
	if result.Date.IsZero() {
		result.Date = message.InternalDate
	}
	result.Read = mailFlagPresent(message.Flags, imap.SeenFlag)
	result.Starred = mailFlagPresent(message.Flags, imap.FlaggedFlag)
	result.HasAttachment = mailBodyHasAttachment(message.BodyStructure)
	return result
}

func mailBodyHasAttachment(body *imap.BodyStructure) bool {
	if body == nil {
		return false
	}
	found := false
	body.Walk(func(_ []int, part *imap.BodyStructure) bool {
		filename, _ := part.Filename()
		if strings.EqualFold(part.Disposition, "attachment") || (filename != "" && !strings.EqualFold(part.Disposition, "inline") && strings.TrimSpace(part.Id) == "") {
			found = true
			return false
		}
		return !found
	})
	return found
}

func convertIMAPAddresses(addresses []*imap.Address) []model.MailAddress {
	result := make([]model.MailAddress, 0, len(addresses))
	for _, address := range addresses {
		if address == nil {
			continue
		}
		value := address.Address()
		if value == "" {
			continue
		}
		result = append(result, model.MailAddress{Name: decodeMailHeaderValue(address.PersonalName), Address: value})
	}
	return result
}

func convertGoMailAddresses(addresses []*gomail.Address) []model.MailAddress {
	result := make([]model.MailAddress, 0, len(addresses))
	for _, address := range addresses {
		if address == nil || strings.TrimSpace(address.Address) == "" {
			continue
		}
		result = append(result, model.MailAddress{Name: decodeMailHeaderValue(address.Name), Address: address.Address})
	}
	return result
}

func mailHeaderAddresses(header *gomail.Header, key string) []*gomail.Address {
	addresses, _ := header.AddressList(key)
	return addresses
}

func parseMailMediaType(value string) (string, map[string]string) {
	mediaType, params, err := mime.ParseMediaType(value)
	if err != nil || mediaType == "" {
		mediaType = "application/octet-stream"
		params = make(map[string]string)
	}
	return strings.ToLower(mediaType), params
}

func mailExtensionForType(contentType string) string {
	extensions, _ := mime.ExtensionsByType(contentType)
	if len(extensions) > 0 {
		return extensions[0]
	}
	return ""
}

func mailFlagPresent(flags []string, target string) bool {
	for _, flag := range flags {
		if strings.EqualFold(flag, target) {
			return true
		}
	}
	return false
}

func bluemondayText(value string) string {
	return strings.TrimSpace(bluemonday.StrictPolicy().Sanitize(value))
}

func decodeMailHeaderValue(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	decoded, err := mailHeaderWordDecoder.DecodeHeader(value)
	if err != nil || strings.TrimSpace(decoded) == "" {
		return value
	}
	return strings.TrimSpace(decoded)
}

func extractMailSenderAvatar(htmlValue, senderEmail string, inlineData map[string]string) (string, string, string) {
	if strings.TrimSpace(htmlValue) == "" {
		return htmlValue, "", ""
	}
	context := &htmlparser.Node{Type: htmlparser.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := htmlparser.ParseFragment(strings.NewReader(htmlValue), context)
	if err != nil {
		return htmlValue, "", ""
	}
	for _, node := range nodes {
		context.AppendChild(node)
	}

	needle := strings.ToLower(strings.TrimSpace(senderEmail))
	var visibleText strings.Builder
	var candidate *htmlparser.Node
	avatarURL := ""
	avatarContentID := ""
	var walk func(*htmlparser.Node)
	walk = func(node *htmlparser.Node) {
		if node == nil || candidate != nil {
			return
		}
		if node.Type == htmlparser.TextNode {
			visibleText.WriteString(" ")
			visibleText.WriteString(node.Data)
		}
		if node.Type == htmlparser.ElementNode && strings.EqualFold(node.Data, "img") {
			source := mailHTMLAttribute(node, "src")
			resolvedURL, contentID := resolveMailImageSource(source, inlineData)
			if resolvedURL != "" {
				text := visibleText.String()
				if len(text) > 600 {
					text = text[len(text)-600:]
				}
				attributes := strings.ToLower(strings.Join([]string{
					mailHTMLAttribute(node, "class"), mailHTMLAttribute(node, "id"),
					mailHTMLAttribute(node, "alt"), mailHTMLAttribute(node, "title"), source,
				}, " "))
				nearSender := needle != "" && strings.Contains(strings.ToLower(text), needle)
				insideSenderSignature := needle != "" && mailHTMLAncestorContainsText(node, context, needle)
				avatarHint := strings.Contains(attributes, "avatar") || strings.Contains(attributes, "profile") ||
					strings.Contains(attributes, "head") || strings.Contains(attributes, "face") || strings.Contains(attributes, "qqmail") ||
					strings.Contains(attributes, "qlogo") || strings.Contains(attributes, "qpic")
				if nearSender || insideSenderSignature || avatarHint {
					candidate = node
					avatarURL = resolvedURL
					avatarContentID = contentID
					return
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
			if candidate != nil {
				return
			}
		}
	}
	walk(context)
	if candidate == nil || candidate.Parent == nil {
		return htmlValue, "", ""
	}
	identityNode := mailHTMLSenderIdentityNode(candidate, context, needle)
	if identityNode != nil && identityNode.Parent != nil {
		identityParent := identityNode.Parent
		containsCandidate := mailHTMLContainsNode(identityNode, candidate)
		identityParent.RemoveChild(identityNode)
		removeEmptyMailHTMLAncestors(identityParent, context)
		if containsCandidate {
			return renderMailHTMLChildren(context, htmlValue), avatarURL, avatarContentID
		}
	}
	parent := candidate.Parent
	parent.RemoveChild(candidate)
	removeEmptyMailHTMLAncestors(parent, context)
	return renderMailHTMLChildren(context, htmlValue), avatarURL, avatarContentID
}

func renderMailHTMLChildren(root *htmlparser.Node, fallback string) string {
	var output strings.Builder
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		if err := htmlparser.Render(&output, child); err != nil {
			return fallback
		}
	}
	return output.String()
}

func mailHTMLAttribute(node *htmlparser.Node, key string) string {
	for _, attribute := range node.Attr {
		if strings.EqualFold(attribute.Key, key) {
			return strings.TrimSpace(attribute.Val)
		}
	}
	return ""
}

func resolveMailImageSource(source string, inlineData map[string]string) (string, string) {
	value := strings.TrimSpace(source)
	if value == "" {
		return "", ""
	}
	if strings.HasPrefix(strings.ToLower(value), "cid:") {
		contentID, err := url.PathUnescape(strings.TrimSpace(value[4:]))
		if err != nil {
			contentID = strings.TrimSpace(value[4:])
		}
		for candidateID, dataURI := range inlineData {
			if strings.EqualFold(candidateID, contentID) {
				return dataURI, candidateID
			}
		}
		return "", ""
	}
	lower := strings.ToLower(value)
	if strings.HasPrefix(lower, "data:image/") || strings.HasPrefix(lower, "https://") || strings.HasPrefix(lower, "http://") {
		return value, ""
	}
	return "", ""
}

func removeEmptyMailHTMLAncestors(node, root *htmlparser.Node) {
	for node != nil && node != root && node.Parent != nil {
		if node.Type != htmlparser.ElementNode || mailHTMLNodeHasVisibleContent(node) {
			return
		}
		parent := node.Parent
		parent.RemoveChild(node)
		node = parent
	}
}

func mailHTMLSenderIdentityNode(candidate, root *htmlparser.Node, needle string) *htmlparser.Node {
	needle = strings.ToLower(strings.TrimSpace(needle))
	if candidate == nil || needle == "" {
		return nil
	}
	depth := 0
	for current := candidate.Parent; current != nil && current != root && depth < 6; current = current.Parent {
		if mailHTMLCompactNodeContainsText(current, needle) {
			return current
		}
		if sibling := mailHTMLNearbySiblingContainingText(current.PrevSibling, needle, true); sibling != nil {
			return sibling
		}
		if sibling := mailHTMLNearbySiblingContainingText(current.NextSibling, needle, false); sibling != nil {
			return sibling
		}
		depth++
	}
	return nil
}

func mailHTMLNearbySiblingContainingText(node *htmlparser.Node, needle string, backwards bool) *htmlparser.Node {
	checked := 0
	for current := node; current != nil && checked < 3; {
		next := current.NextSibling
		if backwards {
			next = current.PrevSibling
		}
		if current.Type == htmlparser.ElementNode {
			checked++
			if mailHTMLCompactNodeContainsText(current, needle) {
				return current
			}
		}
		current = next
	}
	return nil
}

func mailHTMLCompactNodeContainsText(node *htmlparser.Node, needle string) bool {
	text := strings.TrimSpace(mailHTMLNodeText(node, 640))
	return text != "" && len(text) <= 600 && strings.Contains(strings.ToLower(text), needle)
}

func mailHTMLContainsNode(root, target *htmlparser.Node) bool {
	for current := target; current != nil; current = current.Parent {
		if current == root {
			return true
		}
	}
	return false
}

func mailHTMLNodeHasVisibleContent(node *htmlparser.Node) bool {
	var visible bool
	var walk func(*htmlparser.Node)
	walk = func(current *htmlparser.Node) {
		if current == nil || visible {
			return
		}
		if current.Type == htmlparser.TextNode && strings.TrimSpace(current.Data) != "" {
			visible = true
			return
		}
		if current.Type == htmlparser.ElementNode && (current.Data == "img" || current.Data == "hr") {
			visible = true
			return
		}
		for child := current.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return visible
}

func mailHTMLAncestorContainsText(node, root *htmlparser.Node, needle string) bool {
	needle = strings.ToLower(strings.TrimSpace(needle))
	if needle == "" {
		return false
	}
	depth := 0
	for parent := node.Parent; parent != nil && parent != root && depth < 6; parent = parent.Parent {
		if strings.Contains(strings.ToLower(mailHTMLNodeText(parent, 2400)), needle) {
			return true
		}
		depth++
	}
	return false
}

func mailHTMLNodeText(node *htmlparser.Node, limit int) string {
	if node == nil || limit <= 0 {
		return ""
	}
	var output strings.Builder
	var walk func(*htmlparser.Node)
	walk = func(current *htmlparser.Node) {
		if current == nil || output.Len() >= limit {
			return
		}
		if current.Type == htmlparser.TextNode {
			remaining := limit - output.Len()
			value := current.Data
			if len(value) > remaining {
				value = value[:remaining]
			}
			output.WriteString(" ")
			output.WriteString(value)
		}
		for child := current.FirstChild; child != nil && output.Len() < limit; child = child.NextSibling {
			walk(child)
		}
	}
	walk(node)
	return output.String()
}
