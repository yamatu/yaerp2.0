package service

import (
	"fmt"
	stdmail "net/mail"
	"sort"
	"strings"

	"yaerp/internal/model"
)

func (s *MailService) ListContacts(userID int64, query string, includeCustomers bool) ([]model.MailContact, error) {
	contacts, err := s.repo.ListContacts(userID, query)
	if err != nil {
		return nil, err
	}
	byEmail := make(map[string]int, len(contacts))
	for index := range contacts {
		contacts[index].Email = strings.ToLower(strings.TrimSpace(contacts[index].Email))
		contacts[index].Source = "saved"
		contacts[index].Sources = []string{"saved"}
		byEmail[contacts[index].Email] = index
	}
	if includeCustomers {
		if s.permSvc == nil {
			return nil, ErrMailContactAccessDenied
		}
		isAdmin, adminErr := s.permSvc.IsAdmin(userID)
		if adminErr != nil {
			return nil, adminErr
		}
		if !isAdmin {
			return nil, ErrMailContactAccessDenied
		}
	}
	if includeCustomers && s.tradeSvc != nil {
		customers, listErr := s.tradeSvc.ListCustomers(userID, query)
		if listErr != nil {
			return nil, listErr
		}
		for _, customer := range customers {
			email := strings.ToLower(strings.TrimSpace(customer.Email))
			if email == "" {
				continue
			}
			if index, exists := byEmail[email]; exists {
				contacts[index].Sources = appendMailContactSource(contacts[index].Sources, "erp")
				if contacts[index].TradeCustomerID == nil {
					customerID := customer.ID
					contacts[index].TradeCustomerID = &customerID
				}
				continue
			}
			customerID := customer.ID
			contacts = append(contacts, model.MailContact{
				ID: -customer.ID, UserID: userID, TradeCustomerID: &customerID,
				Name:    firstNonEmptyMail(customer.ContactName, customer.Name),
				Company: customer.CompanyName, Email: email, Phone: customer.Phone,
				Notes: customer.Notes, Source: "erp", Sources: []string{"erp"},
			})
			byEmail[email] = len(contacts) - 1
		}
	}
	accounts, accountErr := s.repo.ListOwnAccounts(userID)
	if accountErr != nil {
		return nil, accountErr
	}
	mailServiceEnabled := true
	if settings, settingsErr := s.repo.GetSettings(); settingsErr == nil {
		mailServiceEnabled = settings.Enabled
	}
	query = strings.ToLower(strings.TrimSpace(query))
	for index := range accounts {
		account := &accounts[index]
		if account.Provider != "alimail" || !account.Enabled || !mailServiceEnabled {
			continue
		}
		remoteContacts, remoteErr := s.aliMailSharedContactsCached(account)
		if remoteErr != nil {
			_ = s.repo.UpdateAccountStatus(account.ID, false, false, "公共通讯录读取失败: "+cleanMailError(remoteErr))
			continue
		}
		for _, contact := range remoteContacts {
			email := strings.ToLower(strings.TrimSpace(contact.Email))
			if email == "" {
				continue
			}
			if query != "" && !strings.Contains(strings.ToLower(strings.Join([]string{contact.Name, contact.Company, email, contact.Phone, contact.Notes}, " ")), query) {
				continue
			}
			if existingIndex, exists := byEmail[email]; exists {
				existing := &contacts[existingIndex]
				existing.Sources = appendMailContactSource(existing.Sources, "alimail")
				if existing.Name == "" || existing.Name == existing.Email {
					existing.Name = contact.Name
				}
				if existing.Company == "" {
					existing.Company = contact.Company
				}
				if existing.Phone == "" {
					existing.Phone = contact.Phone
				}
				if existing.SourceAccountID == nil {
					existing.SourceAccountID = contact.SourceAccountID
					existing.ExternalID = contact.ExternalID
				}
				continue
			}
			contacts = append(contacts, contact)
			byEmail[email] = len(contacts) - 1
		}
	}
	sort.SliceStable(contacts, func(i, j int) bool {
		left := strings.ToLower(firstNonEmptyMail(contacts[i].Name, contacts[i].Company, contacts[i].Email))
		right := strings.ToLower(firstNonEmptyMail(contacts[j].Name, contacts[j].Company, contacts[j].Email))
		return left < right
	})
	return contacts, nil
}

func appendMailContactSource(values []string, source string) []string {
	for _, value := range values {
		if value == source {
			return values
		}
	}
	return append(values, source)
}

func (s *MailService) SaveContact(userID int64, input *model.MailContactInput) (*model.MailContact, error) {
	contact, err := s.mailContactFromInput(userID, input)
	if err != nil {
		return nil, err
	}
	if err := s.repo.UpsertContact(contact); err != nil {
		return nil, err
	}
	return contact, nil
}

func (s *MailService) UpdateContact(userID, contactID int64, input *model.MailContactInput) (*model.MailContact, error) {
	if contactID <= 0 {
		return nil, fmt.Errorf("ERP 客户邮箱请在客户档案中编辑")
	}
	contact, err := s.mailContactFromInput(userID, input)
	if err != nil {
		return nil, err
	}
	contact.ID = contactID
	if err := s.repo.UpdateContact(contact); err != nil {
		return nil, err
	}
	return contact, nil
}

func (s *MailService) mailContactFromInput(userID int64, input *model.MailContactInput) (*model.MailContact, error) {
	if input == nil {
		return nil, fmt.Errorf("联系人资料不能为空")
	}
	parsed, err := stdmail.ParseAddress(strings.TrimSpace(input.Email))
	if err != nil || !strings.Contains(parsed.Address, "@") {
		return nil, fmt.Errorf("请输入有效的联系人邮箱")
	}
	contact := &model.MailContact{
		UserID: userID, TradeCustomerID: input.TradeCustomerID,
		Name: strings.TrimSpace(input.Name), Company: strings.TrimSpace(input.Company),
		Email: strings.ToLower(strings.TrimSpace(parsed.Address)), Phone: strings.TrimSpace(input.Phone),
		Notes: strings.TrimSpace(input.Notes), Source: "saved",
	}
	if contact.TradeCustomerID != nil {
		if s.tradeSvc == nil {
			return nil, fmt.Errorf("客户档案服务尚未初始化")
		}
		customers, listErr := s.tradeSvc.ListCustomers(userID, contact.Email)
		if listErr != nil {
			return nil, listErr
		}
		allowed := false
		for _, customer := range customers {
			if customer.ID == *contact.TradeCustomerID {
				allowed = true
				break
			}
		}
		if !allowed {
			return nil, fmt.Errorf("没有权限关联该客户档案")
		}
	}
	if contact.Name == "" {
		contact.Name = parsed.Name
	}
	if contact.Name == "" {
		contact.Name = contact.Email
	}
	return contact, nil
}

func (s *MailService) DeleteContact(userID, contactID int64) error {
	if contactID <= 0 {
		return fmt.Errorf("ERP 客户邮箱请在客户档案中编辑")
	}
	return s.repo.DeleteContact(userID, contactID)
}

func (s *MailService) ListSignatures(userID int64) ([]model.MailSignature, error) {
	return s.repo.ListSignatures(userID)
}

func (s *MailService) SaveSignature(userID int64, input *model.MailSignatureInput) (*model.MailSignature, error) {
	count, err := s.repo.CountSignatures(userID)
	if err != nil {
		return nil, err
	}
	if count >= 10 {
		return nil, fmt.Errorf("每个邮箱最多保存 10 个落款")
	}
	signature, err := s.mailSignatureFromInput(userID, 0, input)
	if err != nil {
		return nil, err
	}
	if err := s.repo.CreateSignature(signature); err != nil {
		return nil, err
	}
	return signature, nil
}

func (s *MailService) UpdateSignature(userID, signatureID int64, input *model.MailSignatureInput) (*model.MailSignature, error) {
	if signatureID <= 0 {
		return nil, fmt.Errorf("邮件落款不存在")
	}
	signature, err := s.mailSignatureFromInput(userID, signatureID, input)
	if err != nil {
		return nil, err
	}
	if err := s.repo.UpdateSignature(signature); err != nil {
		return nil, err
	}
	return signature, nil
}

func (s *MailService) DeleteSignature(userID, signatureID int64) error {
	if signatureID <= 0 {
		return fmt.Errorf("邮件落款不存在")
	}
	return s.repo.DeleteSignature(userID, signatureID)
}

func (s *MailService) mailSignatureFromInput(userID, signatureID int64, input *model.MailSignatureInput) (*model.MailSignature, error) {
	if input == nil {
		return nil, fmt.Errorf("邮件落款内容不能为空")
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		return nil, fmt.Errorf("请填写落款标题")
	}
	if len([]rune(title)) > 100 {
		return nil, fmt.Errorf("落款标题不能超过 100 个字符")
	}
	content := strings.TrimSpace(s.htmlPolicy.Sanitize(input.HTMLContent))
	if content == "" {
		return nil, fmt.Errorf("请填写落款内容")
	}
	if len(content) > 100000 {
		return nil, fmt.Errorf("落款内容过长")
	}
	return &model.MailSignature{
		ID: signatureID, UserID: userID, Title: title, HTMLContent: content,
		ApplyToNew: input.ApplyToNew, ApplyToReply: input.ApplyToReply,
	}, nil
}

// correspondenceScanLimit caps how many matched messages a single thread request
// is allowed to drain from the provider, so a very long thread cannot turn one
// page view into an unbounded number of upstream calls.
const correspondenceScanLimit = 1000

func (s *MailService) ListCorrespondence(userID int64, email string, page, pageSize int) (*model.MailMessagePage, error) {
	parsed, err := stdmail.ParseAddress(strings.TrimSpace(email))
	if err != nil || !strings.Contains(parsed.Address, "@") {
		return nil, fmt.Errorf("请选择有效的客户邮箱")
	}
	folders, err := s.ListFolders(userID)
	if err != nil {
		return nil, err
	}
	targets := []string{imapInboxName()}
	if sent := folderForRole(folders, "sent"); sent != "" && !strings.EqualFold(sent, targets[0]) {
		targets = append(targets, sent)
	}
	return s.listAcrossFolders(userID, "CORRESPONDENCE", targets, page, pageSize, MailMessageListOptions{Participant: parsed.Address}, false)
}

// SearchAllMessages runs a keyword search over every mailbox folder except
// trash and junk, so sent mail, drafts and custom folders are found together
// with the inbox.
func (s *MailService) SearchAllMessages(userID int64, page, pageSize int, options MailMessageListOptions) (*model.MailMessagePage, error) {
	options.Query = strings.TrimSpace(options.Query)
	if options.Query == "" {
		return nil, fmt.Errorf("请输入搜索关键词")
	}
	folders, err := s.ListFolders(userID)
	if err != nil {
		return nil, err
	}
	return s.listAcrossFolders(userID, "SEARCH", mailSearchFolders(folders), page, pageSize, options, true)
}

func mailSearchFolders(folders []model.MailFolder) []string {
	rank := map[string]int{"inbox": 0, "sent": 1, "drafts": 2}
	candidates := make([]model.MailFolder, 0, len(folders))
	seen := make(map[string]struct{}, len(folders))
	for _, folder := range folders {
		if !folder.Selectable || folder.Role == "trash" || folder.Role == "junk" {
			continue
		}
		key := strings.ToLower(folder.Name)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		candidates = append(candidates, folder)
	}
	sort.SliceStable(candidates, func(i, j int) bool {
		left, ok := rank[candidates[i].Role]
		if !ok {
			left = len(rank)
		}
		right, ok := rank[candidates[j].Role]
		if !ok {
			right = len(rank)
		}
		return left < right
	})
	result := make([]string, 0, len(candidates))
	for _, folder := range candidates {
		result = append(result, folder.Name)
	}
	return result
}

// listAcrossFolders merges one filtered view of several folders into a single
// timeline. Providers do not expose a filtered total across folders, so pages
// are drained from each source and sliced locally; one extra page is drained
// so ordering stays correct across the page boundary. With skipFailing, a
// folder the server refuses to search is skipped unless every folder fails.
func (s *MailService) listAcrossFolders(userID int64, label string, targets []string, page, pageSize int, options MailMessageListOptions, skipFailing bool) (*model.MailMessagePage, error) {
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 30
	}
	if pageSize > 100 {
		pageSize = 100
	}
	sortBy := "date"
	if strings.EqualFold(options.SortBy, "size") {
		sortBy = "size"
	}
	sortOrder := "desc"
	if strings.EqualFold(options.SortOrder, "asc") {
		sortOrder = "asc"
	}
	options.SortBy, options.SortOrder = sortBy, sortOrder
	needed := (page + 1) * pageSize
	if needed > correspondenceScanLimit {
		needed = correspondenceScanLimit
	}
	all := make([]model.MailMessageSummary, 0, needed)
	sourceHasMore := false
	var lastErr error
	succeeded := 0
	for _, folder := range targets {
		fetched := 0
		failed := false
		for sourcePage := 1; fetched < needed; sourcePage++ {
			result, listErr := s.ListMessages(userID, folder, sourcePage, 100, options)
			if listErr != nil {
				if !skipFailing {
					return nil, listErr
				}
				lastErr, failed = listErr, true
				break
			}
			all = append(all, result.Messages...)
			fetched += len(result.Messages)
			if !result.HasMore || len(result.Messages) == 0 {
				break
			}
			sourceHasMore = true
		}
		if !failed {
			succeeded++
		}
	}
	if succeeded == 0 && lastErr != nil {
		return nil, lastErr
	}
	sortMailSummaries(all, sortBy, sortOrder)
	hasMore := len(all) > needed || (sourceHasMore && len(all) >= needed)
	if len(all) > needed {
		all = all[:needed]
	}
	offset := (page - 1) * pageSize
	if offset > len(all) {
		offset = len(all)
	}
	end := offset + pageSize
	if end > len(all) {
		end = len(all)
	}
	return &model.MailMessagePage{
		Folder: label, Messages: all[offset:end], Page: page,
		PageSize: pageSize, Total: len(all), HasMore: hasMore,
	}, nil
}

func (s *MailService) TranslateText(userID int64, input *model.MailTranslateInput) (*AITranslationResult, error) {
	if s.aiSvc == nil {
		return nil, fmt.Errorf("AI 服务尚未初始化")
	}
	if input == nil || strings.TrimSpace(input.SourceText) == "" {
		return nil, fmt.Errorf("请选择或填写需要翻译的邮件内容")
	}
	target := strings.TrimSpace(input.TargetLanguage)
	if target == "" {
		target = "zh-CN"
	}
	if input.Aligned {
		return s.aiSvc.TranslateTextAligned(userID, input.AssistantID, input.SourceText, target)
	}
	return s.aiSvc.TranslateText(userID, input.AssistantID, input.SourceText, target)
}

func firstNonEmptyMail(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func imapInboxName() string { return "INBOX" }
