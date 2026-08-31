package service

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"mime"
	"net"
	"net/http"
	stdmail "net/mail"
	"net/url"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/microcosm-cc/bluemonday"
	"github.com/redis/go-redis/v9"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const (
	aliMailDefaultBaseURL = "https://alimail-cn.aliyuncs.com"
	aliMailPageSize       = 100
	aliMailUploadChunk    = 5 << 20
	aliMailListSelect     = "internetMessageId,subject,from,sender,toRecipients,ccRecipients,folderId,hasAttachments,isRead,sentDateTime,receivedDateTime,tags,size"
	aliMailRatePerSecond  = 32
	aliMailRateBurst      = 8
)

var aliMailBaseURLs = map[string]struct{}{
	"https://alimail-cn.aliyuncs.com":       {},
	"https://alimail-personal.aliyuncs.com": {},
	"https://alimail-sg.aliyuncs.com":       {},
}

type aliMailToken struct {
	AccessToken string
	ExpiresAt   time.Time
}

type aliMailTokenCall struct {
	done  chan struct{}
	token aliMailToken
	err   error
}

type aliMailRequestError struct {
	status     int
	retryAfter time.Duration
	err        error
}

func (err *aliMailRequestError) Error() string { return err.err.Error() }
func (err *aliMailRequestError) Unwrap() error { return err.err }

var aliMailRateLimitScript = redis.NewScript(`
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local state = redis.call('HMGET', KEYS[1], 'tokens', 'updated')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil then tokens = capacity end
if updated == nil then updated = now end
local elapsed = math.max(0, now - updated) / 1000
tokens = math.min(capacity, tokens + elapsed * rate)
if tokens >= 1 then
  tokens = tokens - 1
  redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
  redis.call('PEXPIRE', KEYS[1], 2000)
  return 0
end
local wait = math.ceil((1 - tokens) * 1000 / rate)
redis.call('HSET', KEYS[1], 'tokens', tokens, 'updated', now)
redis.call('PEXPIRE', KEYS[1], 2000)
return wait
`)

type aliMailContactCache struct {
	Contacts  []model.MailContact
	ExpiresAt time.Time
}

type aliMailRecipient struct {
	Email string `json:"email"`
	Name  string `json:"name"`
}

type aliMailBody struct {
	Text string `json:"bodyText"`
	HTML string `json:"bodyHtml"`
}

type aliMailInt64 int64

func (value *aliMailInt64) UnmarshalJSON(data []byte) error {
	raw := strings.TrimSpace(string(data))
	if raw == "" || raw == "null" || raw == `""` {
		*value = 0
		return nil
	}
	if strings.HasPrefix(raw, `"`) {
		var text string
		if err := json.Unmarshal(data, &text); err != nil {
			return err
		}
		raw = strings.TrimSpace(text)
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil {
		return fmt.Errorf("invalid AliMail integer %q: %w", raw, err)
	}
	*value = aliMailInt64(parsed)
	return nil
}

type aliMailMessage struct {
	InternetMessageID      string             `json:"internetMessageId"`
	Subject                string             `json:"subject"`
	Summary                string             `json:"summary"`
	Priority               string             `json:"priority"`
	ReadReceiptRequested   bool               `json:"isReadReceiptRequested"`
	From                   aliMailRecipient   `json:"from"`
	To                     []aliMailRecipient `json:"toRecipients"`
	CC                     []aliMailRecipient `json:"ccRecipients"`
	BCC                    []aliMailRecipient `json:"bccRecipients"`
	Sender                 aliMailRecipient   `json:"sender"`
	ReplyTo                []aliMailRecipient `json:"replyTo"`
	Body                   aliMailBody        `json:"body"`
	InternetMessageHeaders map[string]string  `json:"internetMessageHeaders"`
	FolderID               string             `json:"folderId"`
	ID                     string             `json:"id"`
	HasAttachments         bool               `json:"hasAttachments"`
	IsRead                 bool               `json:"isRead"`
	SentDateTime           time.Time          `json:"sentDateTime"`
	ReceivedDateTime       time.Time          `json:"receivedDateTime"`
	Tags                   []string           `json:"tags"`
	Size                   aliMailInt64       `json:"size"`
}

type aliMailFolder struct {
	ID               string            `json:"id"`
	DisplayName      string            `json:"displayName"`
	ParentFolderID   string            `json:"parentFolderId"`
	ChildFolderCount int               `json:"childFolderCount"`
	TotalItemCount   int64             `json:"totalItemCount"`
	UnreadItemCount  int64             `json:"unreadItemCount"`
	Extensions       map[string]string `json:"extensions"`
}

type aliMailAttachment struct {
	Name      string            `json:"name"`
	Size      int64             `json:"size"`
	ContentID string            `json:"contentId"`
	ID        string            `json:"id"`
	Inline    bool              `json:"isInline"`
	Headers   map[string]string `json:"extHeaders"`
}

type aliMailSharedContact struct {
	ID          string   `json:"id"`
	Name        string   `json:"name"`
	FolderID    string   `json:"folderId"`
	Email       string   `json:"email"`
	WorkPhone   string   `json:"workPhone"`
	Phone       string   `json:"phone"`
	CompanyName string   `json:"companyName"`
	JobTitle    string   `json:"jobTitle"`
	Info        string   `json:"info"`
	FolderPath  []string `json:"folderPath"`
}

type aliMailSharedFolder struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	ParentID string `json:"parentId"`
}

func normalizeAliMailBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	if value == "" {
		value = aliMailDefaultBaseURL
	}
	if _, allowed := aliMailBaseURLs[value]; !allowed {
		return "", fmt.Errorf("请选择受支持的阿里邮箱 OpenAPI 区域")
	}
	return value, nil
}

func (s *MailService) invalidateAliMailToken(accountID int64) {
	if accountID <= 0 {
		return
	}
	s.aliTokenMu.Lock()
	delete(s.aliTokens, accountID)
	s.aliTokenMu.Unlock()
	s.aliContactMu.Lock()
	delete(s.aliContacts, accountID)
	s.aliContactMu.Unlock()
}

func (s *MailService) aliMailHTTPClient() (*http.Client, error) {
	settings := &model.MailServerSettings{ProxyType: "none"}
	if s.repo != nil {
		if current, err := s.repo.GetSettings(); err == nil && current != nil {
			settings = current
		}
	}
	cacheKey := strings.Join([]string{
		normalizeMailProxyType(settings.ProxyType), settings.ProxyHost,
		strconv.Itoa(settings.ProxyPort), settings.ProxyUsername, settings.ProxyPasswordEncrypted,
	}, "|")
	s.aliHTTPMu.Lock()
	if client := s.aliHTTPClient[cacheKey]; client != nil {
		s.aliHTTPMu.Unlock()
		return client, nil
	}
	s.aliHTTPMu.Unlock()
	transport := &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   40,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   15 * time.Second,
		ResponseHeaderTimeout: 30 * time.Second,
	}
	if normalizeMailProxyType(settings.ProxyType) != "none" {
		dialer, dialErr := s.mailDialer(settings)
		if dialErr != nil {
			return nil, dialErr
		}
		transport.Proxy = nil
		transport.DialContext = func(_ context.Context, network, address string) (net.Conn, error) {
			return dialer.Dial(network, address)
		}
	}
	client := &http.Client{Transport: transport, Timeout: 45 * time.Second}
	s.aliHTTPMu.Lock()
	if existing := s.aliHTTPClient[cacheKey]; existing != nil {
		s.aliHTTPMu.Unlock()
		transport.CloseIdleConnections()
		return existing, nil
	}
	s.aliHTTPClient[cacheKey] = client
	s.aliHTTPMu.Unlock()
	return client, nil
}

func (s *MailService) resetAliMailHTTPClients() {
	s.aliHTTPMu.Lock()
	defer s.aliHTTPMu.Unlock()
	for _, client := range s.aliHTTPClient {
		if transport, ok := client.Transport.(*http.Transport); ok {
			transport.CloseIdleConnections()
		}
	}
	s.aliHTTPClient = make(map[string]*http.Client)
}

func (s *MailService) aliMailAcquireToken(account *model.MailAccount, secret string) (aliMailToken, error) {
	client, err := s.aliMailHTTPClient()
	if err != nil {
		return aliMailToken{}, err
	}
	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {strings.TrimSpace(account.ClientID)},
		"client_secret": {secret},
	}
	request, err := http.NewRequest(http.MethodPost, account.APIBaseURL+"/oauth2/v2.0/token", strings.NewReader(form.Encode()))
	if err != nil {
		return aliMailToken{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	response, err := client.Do(request)
	if err != nil {
		return aliMailToken{}, fmt.Errorf("阿里邮箱认证请求失败: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		return aliMailToken{}, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return aliMailToken{}, aliMailHTTPError(response.StatusCode, body)
	}
	var payload struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return aliMailToken{}, fmt.Errorf("阿里邮箱认证响应无法解析: %w", err)
	}
	if strings.TrimSpace(payload.AccessToken) == "" {
		return aliMailToken{}, fmt.Errorf("阿里邮箱认证未返回 access token")
	}
	if payload.ExpiresIn <= 0 {
		payload.ExpiresIn = 3600
	}
	return aliMailToken{AccessToken: payload.AccessToken, ExpiresAt: time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second)}, nil
}

func (s *MailService) aliMailAccessToken(account *model.MailAccount) (string, error) {
	s.aliTokenMu.Lock()
	if cached, exists := s.aliTokens[account.ID]; exists && time.Until(cached.ExpiresAt) > 2*time.Minute {
		s.aliTokenMu.Unlock()
		return cached.AccessToken, nil
	}
	if call := s.aliTokenCalls[account.ID]; call != nil {
		s.aliTokenMu.Unlock()
		<-call.done
		if call.err != nil {
			return "", call.err
		}
		return call.token.AccessToken, nil
	}
	call := &aliMailTokenCall{done: make(chan struct{})}
	s.aliTokenCalls[account.ID] = call
	s.aliTokenMu.Unlock()
	secret, err := s.decryptSecret(account.ClientSecretEncrypted)
	if err != nil {
		err = fmt.Errorf("阿里邮箱应用密钥无法读取: %w", err)
	} else {
		call.token, err = s.aliMailAcquireToken(account, secret)
	}
	s.aliTokenMu.Lock()
	call.err = err
	if err == nil {
		s.aliTokens[account.ID] = call.token
	}
	delete(s.aliTokenCalls, account.ID)
	close(call.done)
	s.aliTokenMu.Unlock()
	if err != nil {
		return "", err
	}
	return call.token.AccessToken, nil
}

func (s *MailService) aliMailDo(account *model.MailAccount, method, endpoint string, query url.Values, payload, result any) error {
	if account == nil || !account.Enabled {
		return fmt.Errorf("当前邮箱账号已停用")
	}
	// The global mail switch configures the shared IMAP/SMTP service. AliMail
	// accounts authenticate independently through OpenAPI and are controlled by
	// their own enabled flag. Proxy settings are still applied by
	// aliMailHTTPClient.
	token, err := s.aliMailAccessToken(account)
	if err != nil {
		return err
	}
	for attempt := 0; attempt < 4; attempt++ {
		err = s.aliMailDoWithToken(account, token, method, endpoint, query, payload, result)
		if err == nil {
			return nil
		}
		var requestErr *aliMailRequestError
		if !errors.As(err, &requestErr) {
			return err
		}
		if requestErr.status == http.StatusUnauthorized && attempt == 0 {
			s.invalidateAliMailToken(account.ID)
			token, err = s.aliMailAccessToken(account)
			if err != nil {
				return err
			}
			continue
		}
		if requestErr.status != http.StatusTooManyRequests || attempt == 3 {
			return err
		}
		delay := requestErr.retryAfter
		if delay <= 0 {
			delay = time.Duration(attempt+1) * 250 * time.Millisecond
		}
		time.Sleep(delay)
	}
	return err
}

func (s *MailService) aliMailDoWithToken(account *model.MailAccount, token, method, endpoint string, query url.Values, payload, result any) error {
	if err := s.waitAliMailRateLimit(account); err != nil {
		return err
	}
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	requestURL := account.APIBaseURL + endpoint
	if len(query) > 0 {
		requestURL += "?" + query.Encode()
	}
	request, err := http.NewRequest(method, requestURL, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client, err := s.aliMailHTTPClient()
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return fmt.Errorf("阿里邮箱 OpenAPI 请求失败: %w", err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, mailMaxRawMessageSize+1))
	if err != nil {
		return err
	}
	if len(responseBody) > mailMaxRawMessageSize {
		return fmt.Errorf("阿里邮箱响应超过 64MB 限制")
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return &aliMailRequestError{
			status: response.StatusCode, retryAfter: aliMailRetryAfter(response.Header.Get("Retry-After")),
			err: aliMailHTTPError(response.StatusCode, responseBody),
		}
	}
	if result == nil || len(bytes.TrimSpace(responseBody)) == 0 {
		return nil
	}
	if err := json.Unmarshal(responseBody, result); err != nil {
		return fmt.Errorf("阿里邮箱响应无法解析: %w", err)
	}
	return nil
}

func (s *MailService) waitAliMailRateLimit(account *model.MailAccount) error {
	if s.rdb != nil {
		host := "default"
		if parsed, err := url.Parse(account.APIBaseURL); err == nil && parsed.Hostname() != "" {
			host = parsed.Hostname()
		}
		key := "alimail:rate:v1:" + host
		deadline := time.Now().Add(45 * time.Second)
		for {
			wait, err := aliMailRateLimitScript.Run(
				context.Background(), s.rdb, []string{key},
				aliMailRateBurst, aliMailRatePerSecond, time.Now().UnixMilli(),
			).Int64()
			if err != nil {
				break
			}
			if wait <= 0 {
				return nil
			}
			if time.Now().Add(time.Duration(wait) * time.Millisecond).After(deadline) {
				return fmt.Errorf("等待阿里邮箱 API 限流超时")
			}
			time.Sleep(time.Duration(wait) * time.Millisecond)
		}
	}
	interval := time.Second / aliMailRatePerSecond
	s.aliRateMu.Lock()
	now := time.Now()
	if s.aliRateNext.Before(now) {
		s.aliRateNext = now
	}
	wait := time.Until(s.aliRateNext)
	s.aliRateNext = s.aliRateNext.Add(interval)
	s.aliRateMu.Unlock()
	if wait > 0 {
		time.Sleep(wait)
	}
	return nil
}

func aliMailRetryAfter(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil && seconds > 0 {
		return time.Duration(seconds) * time.Second
	}
	if date, err := http.ParseTime(value); err == nil {
		if delay := time.Until(date); delay > 0 {
			return delay
		}
	}
	return 0
}

func aliMailHTTPError(status int, body []byte) error {
	var payload struct {
		Message         string `json:"message"`
		DetailErrorCode string `json:"detailErrorCode"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	_ = json.Unmarshal(body, &payload)
	message := firstNonEmptyMail(payload.Message, payload.ErrorDesc, payload.Error, strings.TrimSpace(string(body)))
	if len(message) > 600 {
		message = message[:600]
	}
	if payload.DetailErrorCode != "" {
		message = payload.DetailErrorCode + ": " + message
	}
	if message == "" {
		message = http.StatusText(status)
	}
	return fmt.Errorf("阿里邮箱 OpenAPI 返回 %d: %s", status, message)
}

func (s *MailService) verifyAliMailAccount(account *model.MailAccount, secret string) error {
	baseURL, err := normalizeAliMailBaseURL(account.APIBaseURL)
	if err != nil {
		return err
	}
	account.APIBaseURL = baseURL
	token, err := s.aliMailAcquireToken(account, secret)
	if err != nil {
		return fmt.Errorf("阿里邮箱应用认证失败: %w", err)
	}
	var response struct {
		Folders []aliMailFolder `json:"folders"`
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders"
	if err := s.aliMailDoWithToken(account, token.AccessToken, http.MethodGet, endpoint, nil, nil, &response); err != nil {
		return fmt.Errorf("阿里邮箱账号访问失败，请确认应用已授权 Mail.Read.All 或 Mail.ReadWrite.All: %w", err)
	}
	return nil
}

func (s *MailService) aliMailAccountForUser(userID int64) (*model.MailAccount, error) {
	account, err := s.repo.GetAccount(userID)
	if err != nil {
		if repo.IsMailAccountMissing(err) {
			return nil, ErrMailAccountNotConfigured
		}
		return nil, err
	}
	if account.Provider != "alimail" {
		return nil, fmt.Errorf("当前邮箱不是阿里邮箱账号")
	}
	if !account.Enabled {
		return nil, fmt.Errorf("当前邮箱账号已停用")
	}
	return account, nil
}

func (s *MailService) aliMailFolders(account *model.MailAccount) ([]model.MailFolder, error) {
	result := make([]model.MailFolder, 0)
	queue := []string{""}
	visited := map[string]struct{}{"": {}}
	for len(queue) > 0 && len(result) < 1000 {
		parentID := queue[0]
		queue = queue[1:]
		query := url.Values{}
		if parentID != "" {
			query.Set("folderId", parentID)
		}
		var response struct {
			Folders []aliMailFolder `json:"folders"`
		}
		endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders"
		if err := s.aliMailDo(account, http.MethodGet, endpoint, query, nil, &response); err != nil {
			return nil, err
		}
		for _, folder := range response.Folders {
			if strings.TrimSpace(folder.ID) == "" {
				continue
			}
			role := aliMailFolderRole(folder)
			result = append(result, model.MailFolder{
				Name: folder.ID, DisplayName: mailFolderDisplayNameByRole(role, firstNonEmptyMail(folder.DisplayName, folder.ID)),
				Delimiter: "/", Role: role,
				Total: clampMailUint32(folder.TotalItemCount), Unread: clampMailUint32(folder.UnreadItemCount),
				Selectable: true,
			})
			if folder.ChildFolderCount > 0 {
				if _, exists := visited[folder.ID]; !exists {
					visited[folder.ID] = struct{}{}
					queue = append(queue, folder.ID)
				}
			}
		}
	}
	sort.SliceStable(result, func(i, j int) bool {
		left, right := mailFolderOrder(result[i].Role), mailFolderOrder(result[j].Role)
		if left != right {
			return left < right
		}
		return strings.ToLower(result[i].DisplayName) < strings.ToLower(result[j].DisplayName)
	})
	return result, nil
}

func aliMailFolderRole(folder aliMailFolder) string {
	if role := aliMailFolderAliasRole(folder.DisplayName); role != "" {
		return role
	}
	return "folder"
}

func aliMailFolderAliasRole(name string) string {
	compact := strings.NewReplacer(" ", "", "_", "", "-", "").Replace(strings.ToLower(strings.TrimSpace(name)))
	for _, value := range []string{"inbox", "收件箱", "收件匣"} {
		if compact == value {
			return "inbox"
		}
	}
	for _, value := range []string{"sent", "sentitems", "sentmail", "已发送", "寄件备份"} {
		if compact == value {
			return "sent"
		}
	}
	for _, value := range []string{"draft", "drafts", "草稿", "草稿箱"} {
		if compact == value {
			return "drafts"
		}
	}
	for _, value := range []string{"trash", "deleted", "deleteditems", "已删除", "已删除邮件", "废件箱"} {
		if compact == value {
			return "trash"
		}
	}
	for _, value := range []string{"junk", "spam", "垃圾邮件", "广告邮件"} {
		if compact == value {
			return "junk"
		}
	}
	if compact == "archive" || compact == "归档" {
		return "archive"
	}
	if compact == "all" || compact == "allmail" || compact == "全部邮件" {
		return "all"
	}
	if compact == "starred" || compact == "flagged" || compact == "星标邮件" || compact == "已加星标" {
		return "flagged"
	}
	return ""
}

func (s *MailService) resolveAliMailFolderAlias(account *model.MailAccount, folder string) (string, error) {
	role := aliMailFolderAliasRole(folder)
	if role == "" {
		return folder, nil
	}
	folders, err := s.aliMailFolders(account)
	if err != nil {
		return "", err
	}
	for _, candidate := range folders {
		if candidate.Role == role {
			return candidate.Name, nil
		}
	}
	return "", fmt.Errorf("当前邮箱没有%s文件夹", mailFolderDisplayNameByRole(role, folder))
}

func clampMailUint32(value int64) uint32 {
	if value <= 0 {
		return 0
	}
	if value > int64(^uint32(0)) {
		return ^uint32(0)
	}
	return uint32(value)
}

func (s *MailService) aliMailSummary(account *model.MailAccount) (*model.MailSummary, error) {
	result := &model.MailSummary{Configured: true, Enabled: account.Enabled, Address: account.EmailAddress, LastError: account.LastError}
	if !result.Enabled {
		return result, nil
	}
	folders, err := s.aliMailFolders(account)
	if err != nil {
		_ = s.repo.UpdateAccountStatus(account.ID, false, false, cleanMailError(err))
		result.LastError = cleanMailError(err)
		return result, nil
	}
	for _, folder := range folders {
		if folder.Role == "inbox" {
			result.Total = folder.Total
			result.Unread = folder.Unread
			break
		}
	}
	_ = s.repo.UpdateAccountStatus(account.ID, false, true, "")
	return result, nil
}

func (s *MailService) aliMailCreateFolder(account *model.MailAccount, name string) error {
	name, err := validateMailFolderName(name)
	if err != nil {
		return err
	}
	payload := map[string]any{"displayName": name}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders"
	return s.aliMailDo(account, http.MethodPost, endpoint, nil, payload, nil)
}

func (s *MailService) aliMailRenameFolder(account *model.MailAccount, folderID, displayName string) error {
	if strings.TrimSpace(folderID) == "" {
		return fmt.Errorf("邮件文件夹不存在")
	}
	displayName, err := validateMailFolderName(displayName)
	if err != nil {
		return err
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders/" + url.PathEscape(folderID)
	return s.aliMailDo(account, http.MethodPatch, endpoint, nil, map[string]any{"displayName": displayName}, nil)
}

func (s *MailService) aliMailDeleteFolder(account *model.MailAccount, folderID string) error {
	if strings.TrimSpace(folderID) == "" {
		return fmt.Errorf("邮件文件夹不存在")
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders/" + url.PathEscape(folderID)
	return s.aliMailDo(account, http.MethodDelete, endpoint, nil, nil, nil)
}

func (s *MailService) aliMailListMessages(account *model.MailAccount, folder string, page, pageSize int, options MailMessageListOptions) (*model.MailMessagePage, error) {
	if strings.TrimSpace(folder) == "" {
		return nil, fmt.Errorf("请选择邮件文件夹")
	}
	var err error
	folder, err = s.resolveAliMailFolderAlias(account, strings.TrimSpace(folder))
	if err != nil {
		return nil, err
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 30
	}
	if pageSize > aliMailPageSize {
		pageSize = aliMailPageSize
	}
	queryText := aliMailSearchQuery(folder, options)
	cursor := ""
	var messages []aliMailMessage
	var total int
	hasMore := false
	for currentPage := 1; currentPage <= page; currentPage++ {
		if queryText != "" {
			var response struct {
				Messages   []aliMailMessage `json:"messages"`
				Total      int              `json:"total"`
				NextCursor string           `json:"nextCursor"`
			}
			endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages/query"
			query := url.Values{"$select": {aliMailListSelect}}
			payload := map[string]any{"query": queryText, "cursor": cursor, "size": pageSize}
			if err := s.aliMailDo(account, http.MethodPost, endpoint, query, payload, &response); err != nil {
				return nil, err
			}
			messages, total, cursor = response.Messages, response.Total, response.NextCursor
			hasMore = cursor != "" && cursor != "$"
		} else {
			var response struct {
				Messages   []aliMailMessage `json:"messages"`
				NextCursor string           `json:"nextCursor"`
				HasMore    bool             `json:"hasMore"`
			}
			endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/mailFolders/" + url.PathEscape(folder) + "/messages"
			query := url.Values{
				"size":        {strconv.Itoa(pageSize)},
				"isAscending": {strconv.FormatBool(strings.EqualFold(options.SortOrder, "asc"))},
				"$select":     {aliMailListSelect},
			}
			if cursor != "" {
				query.Set("cursor", cursor)
			}
			if !options.StartDate.IsZero() {
				query.Set("startTime", options.StartDate.UTC().Format(time.RFC3339))
			}
			if !options.EndDate.IsZero() {
				query.Set("endTime", options.EndDate.AddDate(0, 0, 1).UTC().Format(time.RFC3339))
			}
			if err := s.aliMailDo(account, http.MethodGet, endpoint, query, nil, &response); err != nil {
				return nil, err
			}
			messages, cursor = response.Messages, response.NextCursor
			hasMore = response.HasMore || (cursor != "" && cursor != "$")
			if currentPage == 1 {
				folders, _ := s.aliMailFolders(account)
				for _, candidate := range folders {
					if candidate.Name == folder {
						total = int(candidate.Total)
						break
					}
				}
			}
		}
		if currentPage < page && !hasMore {
			messages = nil
			break
		}
	}
	result := &model.MailMessagePage{Folder: folder, Page: page, PageSize: pageSize, Total: total, HasMore: hasMore, Messages: make([]model.MailMessageSummary, 0, len(messages))}
	for _, message := range messages {
		summary, err := s.aliMailMessageSummary(account, folder, message)
		if err != nil {
			return nil, err
		}
		result.Messages = append(result.Messages, summary)
	}
	if strings.EqualFold(options.SortBy, "size") {
		sortMailSummaries(result.Messages, "size", options.SortOrder)
	}
	_ = s.repo.UpdateAccountStatus(account.ID, false, true, "")
	return result, nil
}

func aliMailSearchQuery(folder string, options MailMessageListOptions) string {
	clauses := make([]string, 0, 8)
	filter := strings.ToLower(strings.TrimSpace(options.Filter))
	if value := strings.TrimSpace(options.Query); value != "" {
		quoted := aliMailKQLQuote(value)
		clauses = append(clauses, "(subject:"+quoted+" OR body:"+quoted+" OR from:"+quoted+" OR to:"+quoted+" OR attachname:"+quoted+")")
	}
	if folder != "" {
		clauses = append(clauses, "folderId:"+aliMailKQLQuote(folder))
	}
	if options.UnreadOnly || filter == "unread" {
		clauses = append(clauses, "isRead:false")
	}
	if filter == "attachment" {
		clauses = append(clauses, "hasAttachments:true")
	}
	if value := strings.TrimSpace(options.Participant); value != "" {
		quoted := aliMailKQLQuote(value)
		clauses = append(clauses, "(fromEmail:"+quoted+" OR toEmail:"+quoted+")")
	}
	if !options.StartDate.IsZero() {
		clauses = append(clauses, "date>="+options.StartDate.UTC().Format(time.RFC3339))
	}
	if !options.EndDate.IsZero() {
		clauses = append(clauses, "date<"+options.EndDate.AddDate(0, 0, 1).UTC().Format(time.RFC3339))
	}
	if len(clauses) == 1 && folder != "" {
		return ""
	}
	return strings.Join(clauses, " AND ")
}

func aliMailKQLQuote(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func (s *MailService) aliMailMessageSummary(account *model.MailAccount, fallbackFolder string, message aliMailMessage) (model.MailMessageSummary, error) {
	folder := firstNonEmptyMail(message.FolderID, fallbackFolder)
	uid, err := s.repo.ResolveRemoteMessageUID(account.ID, message.ID, folder)
	if err != nil {
		return model.MailMessageSummary{}, err
	}
	date := message.ReceivedDateTime
	if date.IsZero() {
		date = message.SentDateTime
	}
	size := clampMailUint32(int64(message.Size))
	return model.MailMessageSummary{
		UID: uid, Folder: folder, MessageID: message.InternetMessageID,
		Subject: firstNonEmptyMail(message.Subject, "（无主题）"),
		From:    aliMailMessageFrom(message), To: aliMailAddresses(message.To),
		Date: date, Size: size, Read: message.IsRead, Starred: aliMailMessageStarred(message.Tags),
		HasAttachment: message.HasAttachments,
	}, nil
}

func aliMailMessageFrom(message aliMailMessage) []model.MailAddress {
	for _, candidate := range []aliMailRecipient{message.From, message.Sender} {
		if addresses := aliMailAddresses([]aliMailRecipient{candidate}); len(addresses) > 0 {
			return addresses
		}
	}
	header := aliMailHeaderValue(message.InternetMessageHeaders, "From")
	parsed, err := stdmail.ParseAddressList(header)
	if err != nil {
		return []model.MailAddress{}
	}
	result := make([]model.MailAddress, 0, len(parsed))
	for _, address := range parsed {
		if address == nil || strings.TrimSpace(address.Address) == "" {
			continue
		}
		result = append(result, model.MailAddress{
			Name: strings.TrimSpace(address.Name), Address: strings.ToLower(strings.TrimSpace(address.Address)),
		})
	}
	return result
}

func aliMailHeaderValue(headers map[string]string, name string) string {
	for key, value := range headers {
		if strings.EqualFold(strings.TrimSpace(key), name) {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func aliMailAddresses(values []aliMailRecipient) []model.MailAddress {
	result := make([]model.MailAddress, 0, len(values))
	for _, value := range values {
		if strings.TrimSpace(value.Email) == "" {
			continue
		}
		result = append(result, model.MailAddress{Name: value.Name, Address: strings.ToLower(strings.TrimSpace(value.Email))})
	}
	return result
}

func aliMailMessageStarred(tags []string) bool {
	for _, tag := range tags {
		switch strings.ToLower(strings.TrimSpace(tag)) {
		case "star", "starred", "flagged", "important":
			return true
		}
	}
	return false
}

func (s *MailService) aliMailGetMessage(account *model.MailAccount, folder string, uid uint32) (*model.MailMessageDetail, error) {
	remoteID, storedFolder, err := s.repo.GetRemoteMessageRef(account.ID, uid)
	if err != nil {
		return nil, ErrMailMessageNotFound
	}
	folder = firstNonEmptyMail(folder, storedFolder)
	var response struct {
		Message aliMailMessage `json:"message"`
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages/" + url.PathEscape(remoteID)
	query := url.Values{"$select": {aliMailListSelect + ",bccRecipients,replyTo,body,internetMessageHeaders,isReadReceiptRequested"}}
	if err := s.aliMailDo(account, http.MethodGet, endpoint, query, nil, &response); err != nil {
		return nil, err
	}
	response.Message.ID = remoteID
	if response.Message.FolderID == "" {
		response.Message.FolderID = folder
	}
	summary, err := s.aliMailMessageSummary(account, folder, response.Message)
	if err != nil {
		return nil, err
	}
	attachments, err := s.aliMailAttachments(account, remoteID)
	if err != nil {
		return nil, err
	}
	detail := &model.MailMessageDetail{
		MailMessageSummary: summary,
		CC:                 aliMailAddresses(response.Message.CC), BCC: aliMailAddresses(response.Message.BCC),
		ReplyTo: aliMailAddresses(response.Message.ReplyTo), TextBody: response.Message.Body.Text,
		HTMLBody: s.htmlPolicy.Sanitize(response.Message.Body.HTML), Attachments: attachments,
		InReplyTo:  aliMailHeaderValue(response.Message.InternetMessageHeaders, "In-Reply-To"),
		References: parseAliMailReferences(aliMailHeaderValue(response.Message.InternetMessageHeaders, "References")),
	}
	if detail.HTMLBody == "" && detail.TextBody == "" {
		detail.TextBody = response.Message.Summary
	}
	if !detail.Read {
		if err := s.aliMailBatchRemote(account, []string{remoteID}, "read", ""); err == nil {
			detail.Read = true
		}
	}
	_ = s.repo.UpdateAccountStatus(account.ID, false, true, "")
	return detail, nil
}

func parseAliMailReferences(value string) []string {
	fields := strings.Fields(strings.TrimSpace(value))
	result := make([]string, 0, len(fields))
	for _, field := range fields {
		if trimmed := trimMessageID(field); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func (s *MailService) aliMailAttachments(account *model.MailAccount, remoteID string) ([]model.MailAttachment, error) {
	var response struct {
		Attachments []aliMailAttachment `json:"attachments"`
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages/" + url.PathEscape(remoteID) + "/attachments"
	if err := s.aliMailDo(account, http.MethodGet, endpoint, nil, nil, &response); err != nil {
		return nil, err
	}
	result := make([]model.MailAttachment, 0, len(response.Attachments))
	for _, attachment := range response.Attachments {
		contentType := attachment.Headers["Content-Type"]
		if contentType == "" {
			contentType = mime.TypeByExtension(filepath.Ext(attachment.Name))
		}
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		result = append(result, model.MailAttachment{
			PartID: attachment.ID, Filename: sanitizeMailFilename(attachment.Name), ContentType: contentType,
			Size: attachment.Size, Inline: attachment.Inline, ContentID: attachment.ContentID,
		})
	}
	return result, nil
}

func (s *MailService) aliMailDownloadAttachment(account *model.MailAccount, uid uint32, attachmentID string) (string, string, []byte, error) {
	remoteID, _, err := s.repo.GetRemoteMessageRef(account.ID, uid)
	if err != nil {
		return "", "", nil, ErrMailMessageNotFound
	}
	attachments, err := s.aliMailAttachments(account, remoteID)
	if err != nil {
		return "", "", nil, err
	}
	filename, contentType := "attachment", "application/octet-stream"
	for _, attachment := range attachments {
		if attachment.PartID == attachmentID {
			filename, contentType = attachment.Filename, attachment.ContentType
			break
		}
	}
	token, err := s.aliMailAccessToken(account)
	if err != nil {
		return "", "", nil, err
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages/" + url.PathEscape(remoteID) + "/attachments/" + url.PathEscape(attachmentID) + "/$value"
	request, err := http.NewRequest(http.MethodGet, account.APIBaseURL+endpoint, nil)
	if err != nil {
		return "", "", nil, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	client, err := s.aliMailHTTPClient()
	if err != nil {
		return "", "", nil, err
	}
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(request)
	if err != nil {
		return "", "", nil, err
	}
	defer response.Body.Close()
	location := response.Header.Get("Location")
	if location == "" && response.StatusCode >= 200 && response.StatusCode < 300 {
		var payload struct {
			Location string `json:"location"`
		}
		body, readErr := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		if readErr != nil {
			return "", "", nil, readErr
		}
		if json.Unmarshal(body, &payload) == nil {
			location = payload.Location
		} else if len(body) > 0 {
			return filename, firstNonEmptyMail(response.Header.Get("Content-Type"), contentType), body, nil
		}
	} else if response.StatusCode < 300 || response.StatusCode >= 400 {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		return "", "", nil, aliMailHTTPError(response.StatusCode, body)
	}
	parsed, err := url.Parse(location)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return "", "", nil, fmt.Errorf("阿里邮箱附件下载地址无效")
	}
	download, err := client.Get(location)
	if err != nil {
		return "", "", nil, err
	}
	defer download.Body.Close()
	if download.StatusCode < 200 || download.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(download.Body, 1<<20))
		return "", "", nil, aliMailHTTPError(download.StatusCode, body)
	}
	data, err := io.ReadAll(io.LimitReader(download.Body, mailMaxRawMessageSize+1))
	if err != nil {
		return "", "", nil, err
	}
	if len(data) > mailMaxRawMessageSize {
		return "", "", nil, fmt.Errorf("附件超过 64MB，无法下载")
	}
	return filename, firstNonEmptyMail(download.Header.Get("Content-Type"), contentType), data, nil
}

func (s *MailService) aliMailBatch(account *model.MailAccount, uids []uint32, action, destination string) error {
	ids := make([]string, 0, len(uids))
	for _, uid := range uids {
		remoteID, _, err := s.repo.GetRemoteMessageRef(account.ID, uid)
		if err != nil {
			return ErrMailMessageNotFound
		}
		ids = append(ids, remoteID)
	}
	return s.aliMailBatchRemote(account, ids, action, destination)
}

func (s *MailService) aliMailBatchRemote(account *model.MailAccount, ids []string, action, destination string) error {
	if len(ids) == 0 || len(ids) > 100 {
		return fmt.Errorf("阿里邮箱每次支持操作 1 到 100 封邮件")
	}
	base := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages"
	switch strings.ToLower(strings.TrimSpace(action)) {
	case "read":
		return s.aliMailDo(account, http.MethodPost, base+"/batchUpdate", nil, map[string]any{"ids": ids, "action": "markRead"}, nil)
	case "unread":
		return s.aliMailDo(account, http.MethodPost, base+"/batchUpdate", nil, map[string]any{"ids": ids, "action": "markUnread"}, nil)
	case "move":
		if strings.TrimSpace(destination) == "" {
			return fmt.Errorf("请选择目标邮件文件夹")
		}
		return s.aliMailDo(account, http.MethodPost, base+"/move", nil, map[string]any{"ids": ids, "destinationFolderId": destination}, nil)
	case "delete":
		return s.aliMailDo(account, http.MethodPost, base+"/batchDelete", nil, map[string]any{"ids": ids, "deleteType": "USER_DELETED"}, nil)
	case "star", "unstar":
		return fmt.Errorf("阿里邮箱 OpenAPI 未提供通用星标标签，请在阿里邮箱网页端管理星标")
	default:
		return fmt.Errorf("不支持的批量邮件操作")
	}
}

func (s *MailService) aliMailSendMessage(account *model.MailAccount, input *model.MailSendInput, attachments []MailOutgoingAttachment) (*model.MailSendResult, error) {
	to, err := aliMailRecipients(input.To)
	if err != nil || len(to) == 0 {
		return nil, fmt.Errorf("请填写有效的收件人邮箱")
	}
	cc, err := aliMailRecipients(input.CC)
	if err != nil {
		return nil, fmt.Errorf("抄送地址无效: %w", err)
	}
	bcc, err := aliMailRecipients(input.BCC)
	if err != nil {
		return nil, fmt.Errorf("密送地址无效: %w", err)
	}
	textBody := strings.TrimSpace(input.TextBody)
	htmlBody := strings.TrimSpace(input.HTMLBody)
	signatureHTML := account.SignatureHTML
	if input.SignatureHTML != nil {
		signatureHTML = s.htmlPolicy.Sanitize(*input.SignatureHTML)
	}
	if signature := strings.TrimSpace(signatureHTML); signature != "" {
		if htmlBody == "" && textBody != "" {
			htmlBody = strings.ReplaceAll(htmlEscape(textBody), "\n", "<br>")
		}
		htmlBody += "<br><br>" + signature
		if textBody != "" {
			textBody += "\n\n" + bluemonday.StrictPolicy().Sanitize(signature)
		}
	}
	if textBody == "" && htmlBody != "" {
		textBody = bluemonday.StrictPolicy().Sanitize(htmlBody)
	}
	headers := map[string]string{}
	if value := strings.TrimSpace(input.InReplyTo); value != "" {
		headers["In-Reply-To"] = "<" + trimMessageID(value) + ">"
	}
	if len(input.References) > 0 {
		refs := make([]string, 0, len(input.References))
		for _, ref := range input.References {
			if value := trimMessageID(ref); value != "" {
				refs = append(refs, "<"+value+">")
			}
		}
		headers["References"] = strings.Join(refs, " ")
	}
	priority := "PRY_NORMAL"
	if strings.EqualFold(input.Priority, "high") {
		priority = "PRY_HIGH"
	}
	message := aliMailMessage{
		Subject: strings.TrimSpace(input.Subject), Priority: priority,
		ReadReceiptRequested: input.RequestReadReceipt,
		From:                 aliMailRecipient{Email: account.EmailAddress, Name: account.DisplayName},
		To:                   to, CC: cc, BCC: bcc, Body: aliMailBody{Text: textBody, HTML: s.htmlPolicy.Sanitize(htmlBody)},
		InternetMessageHeaders: headers,
	}
	var created struct {
		Message aliMailMessage `json:"message"`
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages"
	query := url.Values{"$select": {"internetMessageId"}}
	if err := s.aliMailDo(account, http.MethodPost, endpoint, query, map[string]any{"message": message}, &created); err != nil {
		return nil, err
	}
	if created.Message.ID == "" {
		return nil, fmt.Errorf("阿里邮箱未返回草稿邮件标识")
	}
	for _, attachment := range attachments {
		if err := s.aliMailUploadAttachment(account, created.Message.ID, attachment); err != nil {
			return nil, fmt.Errorf("附件 %s 上传失败: %w", attachment.Filename, err)
		}
	}
	sendEndpoint := endpoint + "/" + url.PathEscape(created.Message.ID) + "/send"
	if err := s.aliMailDo(account, http.MethodPost, sendEndpoint, nil, map[string]any{"saveToSentItems": input.SaveToSent}, nil); err != nil {
		return nil, err
	}
	_ = s.repo.UpdateAccountStatus(account.ID, false, true, "")
	return &model.MailSendResult{MessageID: firstNonEmptyMail(created.Message.InternetMessageID, created.Message.ID), SentAt: time.Now()}, nil
}

func htmlEscape(value string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&#34;", "'", "&#39;").Replace(value)
}

func aliMailRecipients(values []string) ([]aliMailRecipient, error) {
	result := make([]aliMailRecipient, 0, len(values))
	for _, raw := range values {
		for _, part := range strings.Split(raw, ",") {
			if strings.TrimSpace(part) == "" {
				continue
			}
			address, err := stdmail.ParseAddress(strings.TrimSpace(part))
			if err != nil || !strings.Contains(address.Address, "@") {
				return nil, fmt.Errorf("邮箱地址 %q 无效", part)
			}
			result = append(result, aliMailRecipient{Email: strings.ToLower(address.Address), Name: address.Name})
		}
	}
	return result, nil
}

func (s *MailService) aliMailUploadAttachment(account *model.MailAccount, messageID string, attachment MailOutgoingAttachment) error {
	filename := sanitizeMailFilename(attachment.Filename)
	if filename == "" {
		filename = "attachment"
	}
	endpoint := "/v2/users/" + url.PathEscape(account.EmailAddress) + "/messages/" + url.PathEscape(messageID) + "/attachments/createUploadSession"
	var session struct {
		UploadURL string `json:"uploadUrl"`
	}
	payload := map[string]any{"attachment": map[string]any{"name": filename, "isInline": false}}
	if err := s.aliMailDo(account, http.MethodPost, endpoint, nil, payload, &session); err != nil {
		return err
	}
	parsed, err := url.Parse(session.UploadURL)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" {
		return fmt.Errorf("阿里邮箱附件上传地址无效")
	}
	token, err := s.aliMailAccessToken(account)
	if err != nil {
		return err
	}
	client, err := s.aliMailHTTPClient()
	if err != nil {
		return err
	}
	total := len(attachment.Data)
	if total == 0 {
		attachment.Data = []byte{}
	}
	for start := 0; start < total || (total == 0 && start == 0); start += aliMailUploadChunk {
		end := start + aliMailUploadChunk
		if end > total {
			end = total
		}
		request, err := http.NewRequest(http.MethodPut, session.UploadURL, bytes.NewReader(attachment.Data[start:end]))
		if err != nil {
			return err
		}
		request.Header.Set("Authorization", "Bearer "+token)
		request.Header.Set("Content-Type", "application/octet-stream")
		if total > aliMailUploadChunk {
			request.Header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end-1, total))
		}
		response, err := client.Do(request)
		if err != nil {
			return err
		}
		body, _ := io.ReadAll(io.LimitReader(response.Body, 1<<20))
		_ = response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			return aliMailHTTPError(response.StatusCode, body)
		}
		if total == 0 {
			break
		}
	}
	return nil
}

func (s *MailService) aliMailSharedContacts(account *model.MailAccount, query string) ([]model.MailContact, error) {
	queue := []string{"$root"}
	visited := map[string]struct{}{"$root": {}}
	result := make([]model.MailContact, 0)
	query = strings.ToLower(strings.TrimSpace(query))
	for len(queue) > 0 && len(result) < 2000 {
		folderID := queue[0]
		queue = queue[1:]
		for offset := 0; ; offset += 500 {
			var response struct {
				Contacts []aliMailSharedContact `json:"contacts"`
				Total    int                    `json:"total"`
			}
			endpoint := "/v2/sharedContactFolders/" + url.PathEscape(folderID) + "/contacts"
			params := url.Values{"offset": {strconv.Itoa(offset)}, "limit": {"500"}, "$select": {"workPhone,phone,companyName,jobTitle,folderPath,info"}}
			if err := s.aliMailDo(account, http.MethodGet, endpoint, params, nil, &response); err != nil {
				return nil, err
			}
			for _, contact := range response.Contacts {
				email := strings.ToLower(strings.TrimSpace(contact.Email))
				if email == "" {
					continue
				}
				searchable := strings.ToLower(strings.Join([]string{contact.Name, contact.CompanyName, email, contact.Phone, contact.WorkPhone}, " "))
				if query != "" && !strings.Contains(searchable, query) {
					continue
				}
				accountID := account.ID
				result = append(result, model.MailContact{
					ID: aliMailContactID(account.ID, contact.ID, email), UserID: account.UserID,
					Name: firstNonEmptyMail(contact.Name, email), Company: contact.CompanyName, Email: email,
					Phone: firstNonEmptyMail(contact.Phone, contact.WorkPhone), Notes: firstNonEmptyMail(contact.Info, contact.JobTitle),
					Source: "alimail", Sources: []string{"alimail"}, SourceAccountID: &accountID, ExternalID: contact.ID,
				})
			}
			if len(response.Contacts) == 0 || offset+len(response.Contacts) >= response.Total {
				break
			}
		}
		for offset := 0; ; offset += 500 {
			var response struct {
				Folders []aliMailSharedFolder `json:"folders"`
				Total   int                   `json:"total"`
			}
			endpoint := "/v2/sharedContactFolders/" + url.PathEscape(folderID) + "/childFolders"
			params := url.Values{"offset": {strconv.Itoa(offset)}, "limit": {"500"}}
			if err := s.aliMailDo(account, http.MethodGet, endpoint, params, nil, &response); err != nil {
				return nil, err
			}
			for _, folder := range response.Folders {
				if folder.ID == "" {
					continue
				}
				if _, exists := visited[folder.ID]; !exists {
					visited[folder.ID] = struct{}{}
					queue = append(queue, folder.ID)
				}
			}
			if len(response.Folders) == 0 || offset+len(response.Folders) >= response.Total {
				break
			}
		}
	}
	return result, nil
}

func (s *MailService) aliMailSharedContactsCached(account *model.MailAccount) ([]model.MailContact, error) {
	s.aliContactMu.Lock()
	if cached, exists := s.aliContacts[account.ID]; exists && time.Now().Before(cached.ExpiresAt) {
		contacts := append([]model.MailContact(nil), cached.Contacts...)
		s.aliContactMu.Unlock()
		return contacts, nil
	}
	s.aliContactMu.Unlock()
	contacts, err := s.aliMailSharedContacts(account, "")
	if err != nil {
		return nil, err
	}
	s.aliContactMu.Lock()
	s.aliContacts[account.ID] = aliMailContactCache{Contacts: append([]model.MailContact(nil), contacts...), ExpiresAt: time.Now().Add(5 * time.Minute)}
	s.aliContactMu.Unlock()
	return contacts, nil
}

func aliMailContactID(accountID int64, remoteID, email string) int64 {
	hash := fnv.New64a()
	_, _ = hash.Write([]byte(fmt.Sprintf("%d:%s:%s", accountID, remoteID, email)))
	value := int64(hash.Sum64() & uint64(^uint64(0)>>1))
	if value == 0 {
		value = 1
	}
	return -value
}
