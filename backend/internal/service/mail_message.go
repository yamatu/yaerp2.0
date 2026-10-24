package service

import (
	"encoding/base64"
	"fmt"
	"io"
	"mime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

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
	// header is the part as its headers describe it, before the bytes refine
	// the type and default name; a part fetched alone is checked against it.
	header    mailPartInfo
	imageType string
	omitted   bool
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
	account, accountErr := s.repo.GetAccount(userID)
	if accountErr != nil {
		return nil, accountErr
	}
	if account.Provider == "alimail" {
		return s.aliMailListMessages(account, folder, page, pageSize, options)
	}
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
	conn, releaseIMAP, err := s.acquireIMAP(session)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	defer func() { releaseIMAP(err) }()
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
			contacts, contactErr := s.ListContacts(userID, "", false)
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
		_ = s.repo.UpdateAccountStatus(session.account.ID, false, true, "")
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
	_ = s.repo.UpdateAccountStatus(session.account.ID, false, true, "")
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
	account, accountErr := s.repo.GetAccount(userID)
	if accountErr != nil {
		return nil, accountErr
	}
	if account.Provider == "alimail" {
		return s.aliMailGetMessage(account, folder, uid)
	}
	folder, err := validateMailFolderName(folder)
	if err != nil {
		return nil, err
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return nil, err
	}
	conn, releaseIMAP, err := s.acquireIMAP(session)
	if err != nil {
		s.recordFailure(userID, err)
		return nil, err
	}
	defer func() { releaseIMAP(err) }()
	if _, err := conn.Select(folder, false); err != nil {
		return nil, err
	}
	message, raw, pruned, err := fetchMailForDisplay(conn, uid)
	if err != nil {
		return nil, err
	}
	accountID := account.ID
	partURL := func(partID string) string { return s.mailPartURL(userID, accountID, folder, uid, partID) }
	parsed, err := s.parseMailDataWithOptions(raw, mailParseOptions{partURL: partURL, pruned: pruned})
	if err != nil {
		return nil, err
	}
	// The parts are already in memory: keep them so the previews, body images
	// and downloads that follow do not fetch the whole message again.
	for _, attachment := range parsed.Attachments {
		key := mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid, partID: attachment.PartID}
		s.mailPartIndex().put(key, attachment.header.filename, attachment.header.contentType)
		s.mailAttachmentCache().put(key, mailAttachmentCacheEntry{filename: attachment.Filename, contentType: attachment.ContentType, data: attachment.Data})
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
		item := attachment.MailAttachment
		item.URL = partURL(item.PartID)
		detail.Attachments = append(detail.Attachments, item)
	}
	if !summary.Read {
		seqset := new(imap.SeqSet)
		seqset.AddNum(uid)
		if err := updateMailFlag(conn, seqset, imap.SeenFlag, true); err == nil {
			detail.Read = true
		}
	}
	_ = s.repo.UpdateAccountStatus(session.account.ID, false, true, "")
	return detail, nil
}

// DownloadAttachment returns the bytes of one part. The result is memoized for a
// few minutes because every uncached call refetches and reparses the message
// over IMAP, and the preview pane asks for the same part repeatedly.
func (s *MailService) DownloadAttachment(userID int64, folder string, uid uint32, partID string) (string, string, []byte, error) {
	if uid == 0 {
		return "", "", nil, fmt.Errorf("无效的邮件标识")
	}
	cacheKey := mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid, partID: partID}
	if entry, ok := s.mailAttachmentCache().get(cacheKey); ok {
		return entry.filename, entry.contentType, entry.data, nil
	}
	filename, contentType, data, err := s.downloadAttachmentUncached(userID, folder, uid, partID)
	if err != nil {
		return "", "", nil, err
	}
	s.mailAttachmentCache().put(cacheKey, mailAttachmentCacheEntry{
		filename: filename, contentType: contentType, data: data,
	})
	return filename, contentType, data, nil
}

// EnsureAttachmentFile returns a stored copy of one attachment together with a
// signed URL. The bytes come from the attachment cache or IMAP on the first
// call; afterwards the browser talks to object storage directly, which means
// progressive images, seekable PDFs and no full buffering in the page.
func (s *MailService) EnsureAttachmentFile(userID int64, folder string, uid uint32, partID string) (*model.Attachment, string, error) {
	if s.attachmentStore == nil {
		return nil, "", ErrMailAttachmentStoreUnavailable
	}
	if strings.TrimSpace(partID) == "" {
		return nil, "", fmt.Errorf("无效的附件标识")
	}
	filename, contentType, data, err := s.DownloadAttachment(userID, folder, uid, partID)
	if err != nil {
		return nil, "", err
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	attachment, url, err := s.attachmentStore.StoreOrReuseFile(filename, contentType, data, userID)
	if err != nil {
		return nil, "", err
	}
	if attachment == nil || url == "" {
		return nil, "", fmt.Errorf("附件存储失败")
	}
	return attachment, url, nil
}

func (s *MailService) downloadAttachmentUncached(userID int64, folder string, uid uint32, partID string) (string, string, []byte, error) {
	account, accountErr := s.repo.GetAccount(userID)
	if accountErr != nil {
		return "", "", nil, accountErr
	}
	if account.Provider == "alimail" {
		return s.aliMailDownloadAttachment(account, uid, partID)
	}
	folder, err := validateMailFolderName(folder)
	if err != nil {
		return "", "", nil, err
	}
	session, err := s.sessionForUser(userID)
	if err != nil {
		return "", "", nil, err
	}
	conn, releaseIMAP, err := s.acquireIMAP(session)
	if err != nil {
		return "", "", nil, err
	}
	defer func() { releaseIMAP(err) }()
	if _, err := conn.Select(folder, true); err != nil {
		return "", "", nil, err
	}
	// Fetch just this part when possible; a 20MB attachment of a 60MB message
	// then costs 20MB instead of the whole message every time.
	if filename, contentType, data, ok := s.fetchMailAttachmentPart(conn, mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid, partID: partID}); ok {
		return filename, contentType, data, nil
	}
	// The whole message is needed. Several body images of one message are
	// requested at once: one request downloads it and caches every part, the
	// others wait for it and are answered from the cache.
	unlock := s.lockMailMessage(userID, folder, uid)
	defer unlock()
	cacheKey := mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid, partID: partID}
	if entry, ok := s.mailAttachmentCache().get(cacheKey); ok {
		return entry.filename, entry.contentType, entry.data, nil
	}
	_, raw, err := fetchRawMail(conn, uid)
	if err != nil {
		return "", "", nil, err
	}
	parsed, err := s.parseMailData(raw)
	if err != nil {
		return "", "", nil, err
	}
	var found *parsedMailAttachment
	for index := range parsed.Attachments {
		attachment := &parsed.Attachments[index]
		key := mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid, partID: attachment.PartID}
		s.mailAttachmentCache().put(key, mailAttachmentCacheEntry{filename: attachment.Filename, contentType: attachment.ContentType, data: attachment.Data})
		if attachment.PartID == partID {
			found = attachment
		}
	}
	if found == nil {
		return "", "", nil, ErrMailMessageNotFound
	}
	return found.Filename, found.ContentType, found.Data, nil
}

// lockMailMessage serializes whole-message downloads of one message; the
// returned function releases the lock.
func (s *MailService) lockMailMessage(userID int64, folder string, uid uint32) func() {
	key := mailAttachmentCacheKey{userID: userID, folder: folder, uid: uid}
	s.messageLocksMu.Lock()
	if s.messageLocks == nil {
		s.messageLocks = map[mailAttachmentCacheKey]*mailMessageLock{}
	}
	lock := s.messageLocks[key]
	if lock == nil {
		lock = &mailMessageLock{}
		s.messageLocks[key] = lock
	}
	lock.waiters++
	s.messageLocksMu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.messageLocksMu.Lock()
		lock.waiters--
		if lock.waiters == 0 {
			delete(s.messageLocks, key)
		}
		s.messageLocksMu.Unlock()
	}
}

type mailMessageLock struct {
	mu      sync.Mutex
	waiters int
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

// mailInlineDataURIMax is the largest body image embedded as a data: URI when
// the caller can serve parts through links; larger images become links, so a
// message with photos is not a response of many megabytes of base64.
const mailInlineDataURIMax = 48 << 10

type mailParseOptions struct {
	// partURL returns the link of a part. Without it every body image up to
	// mailInlineImageMaxSize is embedded (used when forwarding server-side).
	partURL func(partID string) string
	// pruned is set for a message rebuilt by fetchMailForDisplay: parts marked
	// with mailOmittedSizeHeader have no body here and load through links.
	pruned bool
}

func (s *MailService) parseMailData(raw []byte) (*parsedMailData, error) {
	return s.parseMailDataWithOptions(raw, mailParseOptions{})
}

func (s *MailService) parseMailDataWithOptions(raw []byte, options mailParseOptions) (*parsedMailData, error) {
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
		info := describeMailPart(part.Header.Get)
		if info.bodyText {
			switch info.contentType {
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
		header := info
		imageType := info.finish(attachmentIndex, content)
		contentID := info.contentID
		size := int64(len(content))
		omitted := false
		if options.pruned {
			if declared, err := strconv.ParseInt(strings.TrimSpace(part.Header.Get(mailOmittedSizeHeader)), 10, 64); err == nil {
				size, omitted = declared, true
			}
		}
		attachment := parsedMailAttachment{
			MailAttachment: model.MailAttachment{
				PartID: strconv.Itoa(attachmentIndex), Filename: info.filename, ContentType: info.contentType,
				Size: size, ContentID: contentID,
			},
			Data: content, header: header, imageType: imageType, omitted: omitted,
		}
		result.Attachments = append(result.Attachments, attachment)
	}
	// Body images: small ones are embedded, others are links. A part the body
	// references by cid: is shown through its link whatever type it declares;
	// an omitted part has no bytes to tell, and the browser decides anyway.
	bodyReferences := referencedMailContentIDs(result.HTMLBody)
	for _, attachment := range result.Attachments {
		if attachment.ContentID == "" {
			continue
		}
		key := normalizeMailContentID(attachment.ContentID)
		switch {
		case !attachment.omitted && attachment.imageType != "" && (options.partURL == nil || attachment.Size <= mailInlineDataURIMax) && attachment.Size <= mailInlineImageMaxSize:
			inlineData[key] = "data:" + attachment.imageType + ";base64," + base64.StdEncoding.EncodeToString(attachment.Data)
		case options.partURL != nil && (attachment.imageType != "" || bodyReferences[key]):
			inlineData[key] = options.partURL(attachment.PartID)
		}
	}
	senderName := ""
	senderEmail := ""
	if len(result.From) > 0 {
		senderName = result.From[0].Name
		senderEmail = result.From[0].Address
	}
	var avatarContentID string
	result.HTMLBody, result.SenderAvatar, avatarContentID = extractMailSenderAvatar(result.HTMLBody, senderName, senderEmail, inlineData)
	if avatarContentID != "" {
		filtered := result.Attachments[:0]
		for _, attachment := range result.Attachments {
			if normalizeMailContentID(attachment.ContentID) == normalizeMailContentID(avatarContentID) {
				continue
			}
			filtered = append(filtered, attachment)
		}
		result.Attachments = filtered
	}
	// A part is inline (shown in the body, not in the attachment list) only when
	// the body really shows it. Apple Mail and others mark ordinary attachments
	// "inline" without referencing them; those must stay downloadable.
	referenced := referencedMailContentIDs(result.HTMLBody)
	for index := range result.Attachments {
		attachment := &result.Attachments[index]
		key := normalizeMailContentID(attachment.ContentID)
		_, shown := inlineData[key]
		attachment.Inline = attachment.ContentID != "" && referenced[key] && shown
	}
	result.HTMLBody = replaceMailCIDImages(result.HTMLBody, inlineData)
	result.HTMLBody = forceMailExternalLinksNewTab(s.htmlPolicy.Sanitize(inlineMailStyleSheets(result.HTMLBody)))
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

func extractMailSenderAvatar(htmlValue, senderName, senderEmail string, inlineData map[string]string) (string, string, string) {
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
	senderImageHints := mailSenderImageHints(senderName, senderEmail)
	var visibleText strings.Builder
	var candidate *htmlparser.Node
	candidateScore := 0
	trackingImages := make([]*htmlparser.Node, 0)
	avatarURL := ""
	avatarContentID := ""
	var walk func(*htmlparser.Node)
	walk = func(node *htmlparser.Node) {
		if node == nil {
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
				if mailHTMLImageIsTracking(node, source) {
					trackingImages = append(trackingImages, node)
					return
				}
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
				// The chosen image is removed from the body, so only clear signs
				// count: words in the image's own labels, or an avatar URL. Loose
				// URL substrings ("qpic", "head", "face") also matched every
				// WeChat image (mmbiz.qpic.cn) and files such as header.png.
				labels := strings.ToLower(strings.Join([]string{
					mailHTMLAttribute(node, "class"), mailHTMLAttribute(node, "id"),
					mailHTMLAttribute(node, "alt"), mailHTMLAttribute(node, "title"),
				}, " "))
				lowerSource := strings.ToLower(source)
				explicitAvatarHint := strings.Contains(labels, "avatar") || strings.Contains(labels, "profile") || strings.Contains(labels, "头像") ||
					strings.Contains(lowerSource, "avatar") || strings.Contains(lowerSource, "qlogo.cn")
				brandHint := strings.Contains(attributes, "logo") || strings.Contains(attributes, "brand") ||
					mailImageMatchesSender(attributes, senderImageHints)
				nearMessageStart := len([]rune(strings.TrimSpace(visibleText.String()))) <= 1200
				score := 0
				switch {
				case explicitAvatarHint:
					score = 100
				case nearSender || insideSenderSignature:
					score = 90
				case nearMessageStart && brandHint && mailHTMLImageIsSmallSquare(node):
					score = 80
				}
				if score > candidateScore {
					candidate = node
					candidateScore = score
					avatarURL = resolvedURL
					avatarContentID = contentID
				}
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(context)
	for _, tracker := range trackingImages {
		if tracker.Parent == nil {
			continue
		}
		parent := tracker.Parent
		parent.RemoveChild(tracker)
		removeEmptyMailHTMLAncestors(parent, context)
	}
	if candidate == nil {
		if len(trackingImages) == 0 {
			return htmlValue, "", ""
		}
		return renderMailHTMLChildren(context, htmlValue), "", ""
	}
	if candidate.Parent == nil {
		return renderMailHTMLChildren(context, htmlValue), "", ""
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

func mailSenderImageHints(senderName, senderEmail string) []string {
	ignored := map[string]struct{}{
		"account": {}, "admin": {}, "company": {}, "contact": {}, "email": {}, "info": {}, "limited": {},
		"mail": {}, "message": {}, "net": {}, "noreply": {}, "notification": {}, "notifications": {},
		"org": {}, "reply": {}, "sales": {}, "security": {}, "service": {}, "support": {}, "team": {},
	}
	seen := make(map[string]struct{})
	hints := make([]string, 0, 8)
	add := func(value string) {
		value = strings.ToLower(strings.TrimSpace(value))
		if len([]rune(value)) < 4 {
			return
		}
		if _, skip := ignored[value]; skip {
			return
		}
		if _, exists := seen[value]; exists {
			return
		}
		seen[value] = struct{}{}
		hints = append(hints, value)
	}
	collect := func(value string) {
		for _, token := range strings.FieldsFunc(value, func(char rune) bool {
			return !unicode.IsLetter(char) && !unicode.IsDigit(char)
		}) {
			add(token)
			lower := strings.ToLower(token)
			if strings.HasSuffix(lower, "mail") && len([]rune(lower)) > 8 {
				add(strings.TrimSuffix(lower, "mail"))
			}
		}
	}
	collect(senderName)
	collect(senderEmail)
	return hints
}

func mailImageMatchesSender(attributes string, hints []string) bool {
	for _, hint := range hints {
		if strings.Contains(attributes, hint) {
			return true
		}
	}
	return false
}

func mailHTMLImageIsTracking(node *htmlparser.Node, source string) bool {
	lowerSource := strings.ToLower(strings.TrimSpace(source))
	for _, hint := range []string{"email_open_log", "open_log_pic", "tracking_pixel", "track.gif", "spacer.gif", "pixel.gif"} {
		if strings.Contains(lowerSource, hint) {
			return true
		}
	}
	width, widthOK := mailHTMLImageDimension(node, "width")
	height, heightOK := mailHTMLImageDimension(node, "height")
	return widthOK && heightOK && width <= 2 && height <= 2
}

func mailHTMLImageIsSmallSquare(node *htmlparser.Node) bool {
	width, widthOK := mailHTMLImageDimension(node, "width")
	height, heightOK := mailHTMLImageDimension(node, "height")
	if !widthOK || !heightOK || width < 16 || height < 16 || width > 256 || height > 256 {
		return false
	}
	ratio := width / height
	return ratio >= 0.6 && ratio <= 1.67
}

func mailHTMLImageDimension(node *htmlparser.Node, key string) (float64, bool) {
	value := strings.ToLower(strings.TrimSpace(mailHTMLAttribute(node, key)))
	value = strings.TrimSpace(strings.TrimSuffix(value, "px"))
	if value == "" || strings.Contains(value, "%") {
		return 0, false
	}
	dimension, err := strconv.ParseFloat(value, 64)
	return dimension, err == nil && dimension > 0
}

func forceMailExternalLinksNewTab(htmlValue string) string {
	if strings.TrimSpace(htmlValue) == "" {
		return htmlValue
	}
	context := &htmlparser.Node{Type: htmlparser.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := htmlparser.ParseFragment(strings.NewReader(htmlValue), context)
	if err != nil {
		return htmlValue
	}
	for _, node := range nodes {
		context.AppendChild(node)
	}
	var walk func(*htmlparser.Node)
	walk = func(node *htmlparser.Node) {
		if node == nil {
			return
		}
		if node.Type == htmlparser.ElementNode && strings.EqualFold(node.Data, "a") {
			href := strings.ToLower(strings.TrimSpace(mailHTMLAttribute(node, "href")))
			if strings.HasPrefix(href, "https://") || strings.HasPrefix(href, "http://") || strings.HasPrefix(href, "//") {
				setMailHTMLAttribute(node, "target", "_blank")
				setMailHTMLAttribute(node, "rel", "noopener noreferrer")
			}
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			walk(child)
		}
	}
	walk(context)
	return renderMailHTMLChildren(context, htmlValue)
}

func setMailHTMLAttribute(node *htmlparser.Node, key, value string) {
	for index := range node.Attr {
		if strings.EqualFold(node.Attr[index].Key, key) {
			node.Attr[index].Val = value
			return
		}
	}
	node.Attr = append(node.Attr, htmlparser.Attribute{Key: key, Val: value})
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
		contentID := normalizeMailContentID(value[4:])
		if dataURI, ok := inlineData[contentID]; ok {
			return dataURI, contentID
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
