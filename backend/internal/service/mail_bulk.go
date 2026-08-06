package service

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	stdmail "net/mail"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const (
	mailBulkQueueKey          = "mail:bulk:queue:v1"
	mailBulkMaxRecipients     = 1000
	mailBulkJobWorkers        = 2
	mailBulkRecipientWorkers  = 4
	mailBulkReconcileInterval = 30 * time.Second
	mailBulkStaleAfter        = 10 * time.Minute
)

func (s *MailService) CreateBulkJob(userID int64, input *model.MailBulkSendInput, attachments []MailOutgoingAttachment) (*model.MailBulkJob, error) {
	if input == nil {
		return nil, fmt.Errorf("群发邮件内容不能为空")
	}
	if s.rdb == nil {
		return nil, fmt.Errorf("群发队列尚未连接 Redis")
	}
	account, err := s.repo.GetAccount(userID)
	if repo.IsMailAccountMissing(err) {
		return nil, ErrMailAccountNotConfigured
	}
	if err != nil {
		return nil, err
	}
	if !account.Enabled {
		return nil, fmt.Errorf("当前邮箱账号已停用")
	}
	recipients, err := normalizeBulkRecipients(input.Recipients)
	if err != nil {
		return nil, err
	}
	message := input.Message
	message.To = nil
	message.CC = nil
	message.BCC = nil
	message.InReplyTo = ""
	message.References = nil
	message.SaveToSent = true
	payload, err := json.Marshal(message)
	if err != nil {
		return nil, err
	}
	storedAttachments := make([]model.MailBulkAttachment, 0, len(attachments))
	for index, attachment := range attachments {
		filename := sanitizeMailFilename(attachment.Filename)
		if filename == "" {
			filename = fmt.Sprintf("attachment-%d", index+1)
		}
		contentType := strings.TrimSpace(attachment.ContentType)
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		storedAttachments = append(storedAttachments, model.MailBulkAttachment{
			Filename: filename, ContentType: contentType, Data: attachment.Data,
		})
	}
	job, err := s.repo.CreateBulkJob(
		userID, account.ID, message.Subject, payload, recipients, storedAttachments,
	)
	if err != nil {
		return nil, err
	}
	if err := s.enqueueBulkJobs(context.Background(), []int64{job.ID}); err != nil {
		// PostgreSQL is the source of truth. The reconciler will enqueue the job
		// after Redis recovers, without making the caller create a duplicate job.
		log.Printf("enqueue bulk mail job %d: %v", job.ID, err)
	}
	return job, nil
}

func (s *MailService) ListBulkJobs(userID int64) ([]model.MailBulkJob, error) {
	return s.repo.ListBulkJobs(userID, 30)
}

func (s *MailService) GetBulkJob(userID, jobID int64) (*model.MailBulkJob, error) {
	if jobID <= 0 {
		return nil, fmt.Errorf("群发任务不存在")
	}
	return s.repo.GetBulkJob(userID, jobID)
}

func (s *MailService) CancelBulkJob(userID, jobID int64) (*model.MailBulkJob, error) {
	if jobID <= 0 {
		return nil, fmt.Errorf("群发任务不存在")
	}
	if err := s.repo.CancelBulkJob(userID, jobID); err != nil {
		return nil, err
	}
	return s.repo.GetBulkJob(userID, jobID)
}

func normalizeBulkRecipients(values []string) ([]model.MailBulkRecipient, error) {
	result := make([]model.MailBulkRecipient, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, raw := range values {
		normalized := strings.NewReplacer("；", ",", "，", ",", "\r", ",", "\n", ",", ";", ",").Replace(raw)
		parsed, err := stdmail.ParseAddressList(normalized)
		if err != nil {
			return nil, fmt.Errorf("邮箱地址 %q 无效", raw)
		}
		for _, address := range parsed {
			if address == nil || !strings.Contains(address.Address, "@") {
				return nil, fmt.Errorf("邮箱地址 %q 无效", raw)
			}
			email := strings.ToLower(strings.TrimSpace(address.Address))
			if _, exists := seen[email]; exists {
				continue
			}
			seen[email] = struct{}{}
			result = append(result, model.MailBulkRecipient{Name: strings.TrimSpace(address.Name), Email: email, Status: "pending"})
			if len(result) > mailBulkMaxRecipients {
				return nil, fmt.Errorf("单个群发任务最多支持 %d 位收件人", mailBulkMaxRecipients)
			}
		}
	}
	if len(result) < 2 {
		return nil, fmt.Errorf("群发邮件至少需要 2 位不同的收件人")
	}
	return result, nil
}

func (s *MailService) StartBulkWorkers(ctx context.Context) error {
	if s.rdb == nil {
		return fmt.Errorf("bulk mail workers require Redis")
	}
	if ctx == nil {
		ctx = context.Background()
	}
	if err := s.reconcileBulkQueue(ctx); err != nil {
		return err
	}
	for index := 0; index < mailBulkJobWorkers; index++ {
		go s.runBulkJobWorker(ctx, index+1)
	}
	go s.runBulkQueueReconciler(ctx)
	return nil
}

func (s *MailService) runBulkJobWorker(ctx context.Context, workerID int) {
	for {
		result, err := s.rdb.BLPop(ctx, 5*time.Second, mailBulkQueueKey).Result()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			if err != redis.Nil {
				log.Printf("bulk mail worker %d queue read: %v", workerID, err)
				time.Sleep(time.Second)
			}
			continue
		}
		if len(result) != 2 {
			continue
		}
		jobID, err := strconv.ParseInt(result[1], 10, 64)
		if err != nil || jobID <= 0 {
			continue
		}
		if err := s.processBulkJob(ctx, jobID); err != nil {
			log.Printf("bulk mail worker %d job %d: %v", workerID, jobID, err)
			_ = s.repo.FailBulkJob(jobID, cleanMailError(err))
		}
	}
}

func (s *MailService) processBulkJob(ctx context.Context, jobID int64) error {
	job, payload, claimed, err := s.repo.ClaimBulkJob(jobID)
	if err != nil || !claimed {
		return err
	}
	var template model.MailSendInput
	if err := json.Unmarshal(payload, &template); err != nil {
		return err
	}
	account, err := s.repo.GetAccountByID(job.UserID, job.AccountID)
	if err != nil {
		return err
	}
	recipients, err := s.repo.ListBulkRecipients(job.ID)
	if err != nil {
		return err
	}
	storedAttachments, err := s.repo.ListBulkAttachments(job.ID)
	if err != nil {
		return err
	}
	attachments := make([]MailOutgoingAttachment, 0, len(storedAttachments))
	for _, attachment := range storedAttachments {
		attachments = append(attachments, MailOutgoingAttachment{
			Filename: attachment.Filename, ContentType: attachment.ContentType, Data: attachment.Data,
		})
	}
	queue := make(chan model.MailBulkRecipient)
	operationErrors := make(chan error, mailBulkRecipientWorkers)
	var workers sync.WaitGroup
	workerCount := mailBulkRecipientWorkers
	if len(recipients) < workerCount {
		workerCount = len(recipients)
	}
	for index := 0; index < workerCount; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for recipient := range queue {
				if ctx.Err() != nil || recipient.Status != "pending" {
					continue
				}
				marked, markErr := s.repo.MarkBulkRecipientSending(recipient.ID)
				if markErr != nil {
					select {
					case operationErrors <- markErr:
					default:
					}
					continue
				}
				if !marked {
					continue
				}
				select {
				case <-ctx.Done():
					select {
					case operationErrors <- ctx.Err():
					default:
					}
					continue
				case s.bulkSendSem <- struct{}{}:
				}
				message := personalizeBulkMessage(template, recipient)
				result, sendErr := s.sendMessageForAccount(account, &message, attachments)
				<-s.bulkSendSem
				if sendErr != nil {
					if completeErr := s.completeBulkRecipient(recipient.ID, "failed", "", cleanMailError(sendErr)); completeErr != nil {
						select {
						case operationErrors <- completeErr:
						default:
						}
					}
					continue
				}
				messageID := ""
				if result != nil {
					messageID = result.MessageID
				}
				if completeErr := s.completeBulkRecipient(recipient.ID, "sent", messageID, ""); completeErr != nil {
					select {
					case operationErrors <- completeErr:
					default:
					}
				}
			}
		}()
	}
	for _, recipient := range recipients {
		select {
		case <-ctx.Done():
			close(queue)
			workers.Wait()
			return ctx.Err()
		case queue <- recipient:
		}
	}
	close(queue)
	workers.Wait()
	select {
	case operationErr := <-operationErrors:
		return operationErr
	default:
	}
	return s.repo.FinishBulkJob(job.ID)
}

func (s *MailService) completeBulkRecipient(recipientID int64, status, messageID, errorMessage string) error {
	var err error
	for attempt := 0; attempt < 3; attempt++ {
		if err = s.repo.CompleteBulkRecipient(recipientID, status, messageID, errorMessage); err == nil {
			return nil
		}
		time.Sleep(time.Duration(attempt+1) * 100 * time.Millisecond)
	}
	return err
}

func personalizeBulkMessage(template model.MailSendInput, recipient model.MailBulkRecipient) model.MailSendInput {
	replace := func(value string) string {
		value = strings.ReplaceAll(value, "{{name}}", recipient.Name)
		return strings.ReplaceAll(value, "{{email}}", recipient.Email)
	}
	template.Subject = replace(template.Subject)
	template.TextBody = replace(template.TextBody)
	template.HTMLBody = replace(template.HTMLBody)
	template.To = []string{(&stdmail.Address{Name: recipient.Name, Address: recipient.Email}).String()}
	template.CC = nil
	template.BCC = nil
	return template
}

func (s *MailService) runBulkQueueReconciler(ctx context.Context) {
	ticker := time.NewTicker(mailBulkReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.reconcileBulkQueue(ctx); err != nil {
				log.Printf("reconcile bulk mail queue: %v", err)
			}
		}
	}
}

func (s *MailService) reconcileBulkQueue(ctx context.Context) error {
	if _, err := s.repo.RecoverStaleBulkJobs(time.Now().Add(-mailBulkStaleAfter)); err != nil {
		return err
	}
	ids, err := s.repo.ListQueuedBulkJobIDs(1000)
	if err != nil || len(ids) == 0 {
		return err
	}
	return s.enqueueBulkJobs(ctx, ids)
}

func (s *MailService) enqueueBulkJobs(ctx context.Context, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	_, err := s.rdb.Pipelined(ctx, func(pipe redis.Pipeliner) error {
		for _, id := range ids {
			pipe.RPush(ctx, mailBulkQueueKey, strconv.FormatInt(id, 10))
		}
		return nil
	})
	return err
}
