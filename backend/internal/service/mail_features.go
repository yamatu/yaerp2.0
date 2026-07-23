package service

import (
	"fmt"
	stdmail "net/mail"
	"sort"
	"strings"

	"yaerp/internal/model"
)

func (s *MailService) ListContacts(userID int64, query string) ([]model.MailContact, error) {
	contacts, err := s.repo.ListContacts(userID, query)
	if err != nil {
		return nil, err
	}
	byEmail := make(map[string]int, len(contacts))
	for index := range contacts {
		contacts[index].Email = strings.ToLower(strings.TrimSpace(contacts[index].Email))
		byEmail[contacts[index].Email] = index
	}
	if s.tradeSvc != nil {
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
				Notes: customer.Notes, Source: "erp",
			})
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

func (s *MailService) ListCorrespondence(userID int64, email string, page, pageSize int) (*model.MailMessagePage, error) {
	parsed, err := stdmail.ParseAddress(strings.TrimSpace(email))
	if err != nil || !strings.Contains(parsed.Address, "@") {
		return nil, fmt.Errorf("请选择有效的客户邮箱")
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
	folders, err := s.ListFolders(userID)
	if err != nil {
		return nil, err
	}
	targets := []string{imapInboxName()}
	if sent := folderForRole(folders, "sent"); sent != "" && !strings.EqualFold(sent, targets[0]) {
		targets = append(targets, sent)
	}
	needed := page * pageSize
	if needed < 100 {
		needed = 100
	}
	if needed > 500 {
		needed = 500
	}
	all := make([]model.MailMessageSummary, 0, needed*len(targets))
	total := 0
	for _, folder := range targets {
		fetched := 0
		for sourcePage := 1; fetched < needed; sourcePage++ {
			result, listErr := s.ListMessages(userID, folder, sourcePage, 100, MailMessageListOptions{Participant: parsed.Address})
			if listErr != nil {
				return nil, listErr
			}
			if sourcePage == 1 {
				total += result.Total
			}
			all = append(all, result.Messages...)
			fetched += len(result.Messages)
			if !result.HasMore || len(result.Messages) == 0 {
				break
			}
		}
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].Date.After(all[j].Date) })
	offset := (page - 1) * pageSize
	if offset > len(all) {
		offset = len(all)
	}
	end := offset + pageSize
	if end > len(all) {
		end = len(all)
	}
	return &model.MailMessagePage{
		Folder: "CORRESPONDENCE", Messages: all[offset:end], Page: page,
		PageSize: pageSize, Total: total, HasMore: page*pageSize < total,
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
