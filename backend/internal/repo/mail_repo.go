package repo

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

type MailRepo struct{ db *sql.DB }

func NewMailRepo(db *sql.DB) *MailRepo { return &MailRepo{db: db} }

func (r *MailRepo) GetSettings() (*model.MailServerSettings, error) {
	settings := &model.MailServerSettings{}
	err := r.db.QueryRow(
		`SELECT enabled, imap_host, imap_port, imap_security,
		        smtp_host, smtp_port, smtp_security, default_domain,
		        allow_insecure_tls, max_attachment_mb,
		        proxy_type, proxy_host, proxy_port, proxy_username, proxy_password_encrypted,
		        updated_at
		   FROM mail_server_settings WHERE id = 1`,
	).Scan(
		&settings.Enabled, &settings.IMAPHost, &settings.IMAPPort, &settings.IMAPSecurity,
		&settings.SMTPHost, &settings.SMTPPort, &settings.SMTPSecurity, &settings.DefaultDomain,
		&settings.AllowInsecureTLS, &settings.MaxAttachmentMB,
		&settings.ProxyType, &settings.ProxyHost, &settings.ProxyPort, &settings.ProxyUsername,
		&settings.ProxyPasswordEncrypted, &settings.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	settings.Configured = strings.TrimSpace(settings.IMAPHost) != "" && strings.TrimSpace(settings.SMTPHost) != ""
	settings.ProxyPasswordConfigured = strings.TrimSpace(settings.ProxyPasswordEncrypted) != ""
	return settings, nil
}

func (r *MailRepo) UpdateSettings(userID int64, settings *model.MailServerSettings) error {
	if settings == nil {
		return fmt.Errorf("mail settings cannot be nil")
	}
	_, err := r.db.Exec(
		`UPDATE mail_server_settings
		    SET enabled=$1, imap_host=$2, imap_port=$3, imap_security=$4,
		        smtp_host=$5, smtp_port=$6, smtp_security=$7, default_domain=$8,
		        allow_insecure_tls=$9, max_attachment_mb=$10,
		        proxy_type=$11, proxy_host=$12, proxy_port=$13, proxy_username=$14,
		        proxy_password_encrypted=$15, updated_by=$16, updated_at=NOW()
		  WHERE id=1`,
		settings.Enabled, settings.IMAPHost, settings.IMAPPort, settings.IMAPSecurity,
		settings.SMTPHost, settings.SMTPPort, settings.SMTPSecurity, settings.DefaultDomain,
		settings.AllowInsecureTLS, settings.MaxAttachmentMB,
		settings.ProxyType, settings.ProxyHost, settings.ProxyPort, settings.ProxyUsername,
		settings.ProxyPasswordEncrypted, userID,
	)
	return err
}

func (r *MailRepo) GetAccount(userID int64) (*model.MailAccount, error) {
	return scanMailAccount(r.db.QueryRow(
		mailAccountSelectSQL()+` WHERE account.user_id = $1 ORDER BY account.is_default DESC, account.id LIMIT 1`,
		userID,
	))
}

func (r *MailRepo) GetAccountByID(userID, accountID int64) (*model.MailAccount, error) {
	return scanMailAccount(r.db.QueryRow(
		mailAccountSelectSQL()+` WHERE account.user_id = $1 AND account.id = $2`,
		userID, accountID,
	))
}

func (r *MailRepo) ListOwnAccounts(userID int64) ([]model.MailAccount, error) {
	rows, err := r.db.Query(
		mailAccountSelectSQL()+` WHERE account.user_id = $1 ORDER BY account.is_default DESC, account.id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]model.MailAccount, 0)
	for rows.Next() {
		account, scanErr := scanMailAccount(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		accounts = append(accounts, *account)
	}
	return accounts, rows.Err()
}

func (r *MailRepo) UpsertAccount(account *model.MailAccount) error {
	return r.SaveAccount(account)
}

func (r *MailRepo) SaveAccount(account *model.MailAccount) error {
	if account == nil || account.UserID <= 0 {
		return fmt.Errorf("invalid mail account")
	}
	// PostgreSQL treats pq.Array(nil) as SQL NULL. The forwarding column is
	// intentionally NOT NULL, so providers without forwarding support (such as
	// AliMail) must persist an empty array instead.
	account.AutoForwardTo = nonNilMailAddresses(account.AutoForwardTo)
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockMailAccountOwner(tx, account.UserID); err != nil {
		return err
	}
	if !account.IsDefault {
		var defaultCount int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM mail_accounts WHERE user_id=$1 AND is_default`, account.UserID).Scan(&defaultCount); err != nil {
			return err
		}
		account.IsDefault = defaultCount == 0
	}
	if account.IsDefault {
		if _, err := tx.Exec(`UPDATE mail_accounts SET is_default=FALSE, updated_at=NOW() WHERE user_id=$1 AND ($2=0 OR id<>$2)`, account.UserID, account.ID); err != nil {
			return err
		}
	}
	if account.ID > 0 {
		err = tx.QueryRow(
			`UPDATE mail_accounts SET
			     provider=$3, email_address=$4, display_name=$5, username=$6,
			     password_encrypted=$7, api_base_url=$8, client_id=$9,
			     client_secret_encrypted=$10, is_default=$11,
			     signature_html=$12, enabled=$13,
			     auto_forward_enabled=$14, auto_forward_to=$15, forward_attachments=$16,
			     forward_uid_validity=$17, forward_last_uid=$18,
			     last_verified_at=$19, last_error=$20, updated_at=NOW()
			 WHERE id=$1 AND user_id=$2
			 RETURNING created_at,updated_at`,
			account.ID, account.UserID, account.Provider, account.EmailAddress, account.DisplayName,
			account.LoginUsername, account.PasswordEncrypted, account.APIBaseURL, account.ClientID,
			account.ClientSecretEncrypted, account.IsDefault, account.SignatureHTML, account.Enabled,
			account.AutoForwardEnabled, pq.Array(account.AutoForwardTo), account.ForwardAttachments,
			account.ForwardUIDValidity, account.ForwardLastUID, account.LastVerifiedAt, account.LastError,
		).Scan(&account.CreatedAt, &account.UpdatedAt)
	} else {
		err = tx.QueryRow(
			`INSERT INTO mail_accounts (
			     user_id,provider,email_address,display_name,username,password_encrypted,
			     api_base_url,client_id,client_secret_encrypted,is_default,
			     signature_html,enabled,auto_forward_enabled,auto_forward_to,forward_attachments,
			     forward_uid_validity,forward_last_uid,last_verified_at,last_error,created_at,updated_at
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),NOW())
			 RETURNING id,created_at,updated_at`,
			account.UserID, account.Provider, account.EmailAddress, account.DisplayName,
			account.LoginUsername, account.PasswordEncrypted, account.APIBaseURL, account.ClientID,
			account.ClientSecretEncrypted, account.IsDefault, account.SignatureHTML, account.Enabled,
			account.AutoForwardEnabled, pq.Array(account.AutoForwardTo), account.ForwardAttachments,
			account.ForwardUIDValidity, account.ForwardLastUID, account.LastVerifiedAt, account.LastError,
		).Scan(&account.ID, &account.CreatedAt, &account.UpdatedAt)
	}
	if err != nil {
		return err
	}
	if !account.Enabled && account.IsDefault {
		var replacementID int64
		replacementErr := tx.QueryRow(
			`SELECT id FROM mail_accounts
			  WHERE user_id=$1 AND id<>$2 AND enabled
			  ORDER BY id LIMIT 1`,
			account.UserID, account.ID,
		).Scan(&replacementID)
		if replacementErr == nil {
			if _, err := tx.Exec(`UPDATE mail_accounts SET is_default=FALSE,updated_at=NOW() WHERE id=$1`, account.ID); err != nil {
				return err
			}
			if _, err := tx.Exec(`UPDATE mail_accounts SET is_default=TRUE,updated_at=NOW() WHERE id=$1`, replacementID); err != nil {
				return err
			}
			account.IsDefault = false
		} else if !errors.Is(replacementErr, sql.ErrNoRows) {
			return replacementErr
		}
	}
	return tx.Commit()
}

func nonNilMailAddresses(addresses []string) []string {
	if addresses == nil {
		return []string{}
	}
	return addresses
}

func lockMailAccountOwner(tx *sql.Tx, userID int64) error {
	var lockedUserID int64
	return tx.QueryRow(`SELECT id FROM users WHERE id=$1 FOR UPDATE`, userID).Scan(&lockedUserID)
}

type mailAccountExecer interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func switchDefaultMailAccount(execer mailAccountExecer, userID, accountID int64) error {
	if _, err := execer.Exec(
		`UPDATE mail_accounts SET is_default=FALSE,updated_at=NOW()
		  WHERE user_id=$1 AND is_default`,
		userID,
	); err != nil {
		return err
	}
	result, err := execer.Exec(
		`UPDATE mail_accounts SET is_default=TRUE,updated_at=NOW()
		  WHERE id=$1 AND user_id=$2 AND enabled`,
		accountID, userID,
	)
	if err != nil {
		return err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected != 1 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *MailRepo) SetDefaultAccount(userID, accountID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockMailAccountOwner(tx, userID); err != nil {
		return err
	}
	if err := switchDefaultMailAccount(tx, userID, accountID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *MailRepo) DeleteAccount(userID, accountID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := lockMailAccountOwner(tx, userID); err != nil {
		return err
	}
	if accountID <= 0 {
		if err := tx.QueryRow(`SELECT id FROM mail_accounts WHERE user_id=$1 ORDER BY is_default DESC,id LIMIT 1`, userID).Scan(&accountID); err != nil {
			return err
		}
	}
	var wasDefault bool
	if err := tx.QueryRow(`SELECT is_default FROM mail_accounts WHERE id=$1 AND user_id=$2`, accountID, userID).Scan(&wasDefault); err != nil {
		return err
	}
	result, err := tx.Exec(`DELETE FROM mail_accounts WHERE id=$1 AND user_id=$2`, accountID, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	if wasDefault {
		if _, err := tx.Exec(`UPDATE mail_accounts SET is_default=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM mail_accounts WHERE user_id=$1 ORDER BY id LIMIT 1)`, userID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *MailRepo) UpdateAccountStatus(accountID int64, verified bool, syncAt bool, lastError string) error {
	lastError = strings.TrimSpace(lastError)
	if len(lastError) > 1000 {
		lastError = lastError[:1000]
	}
	_, err := r.db.Exec(
		`UPDATE mail_accounts
		    SET last_verified_at = CASE WHEN $2 THEN NOW() ELSE last_verified_at END,
		        last_sync_at = CASE WHEN $3 THEN NOW() ELSE last_sync_at END,
		        last_error = $4,
		        updated_at = NOW()
		  WHERE id = $1`,
		accountID, verified, syncAt, lastError,
	)
	return err
}

func (r *MailRepo) ListAccounts() ([]model.MailAccount, error) {
	rows, err := r.db.Query(mailAccountSelectSQL() + ` WHERE account.id IS NOT NULL ORDER BY usr.username, account.is_default DESC, account.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]model.MailAccount, 0)
	for rows.Next() {
		account, err := scanMailAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, *account)
	}
	return accounts, rows.Err()
}

func (r *MailRepo) ListForwardingAccounts() ([]model.MailAccount, error) {
	rows, err := r.db.Query(mailAccountSelectSQL() + `
		WHERE account.id IS NOT NULL
		  AND account.provider = 'imap'
		  AND account.enabled = TRUE
		  AND account.auto_forward_enabled = TRUE
		  AND cardinality(account.auto_forward_to) > 0
		ORDER BY account.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]model.MailAccount, 0)
	for rows.Next() {
		account, scanErr := scanMailAccount(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		accounts = append(accounts, *account)
	}
	return accounts, rows.Err()
}

func (r *MailRepo) UpdateForwardCursor(accountID int64, uidValidity, lastUID uint32) error {
	_, err := r.db.Exec(
		`UPDATE mail_accounts
		    SET forward_uid_validity=$2, forward_last_uid=$3, updated_at=NOW()
		  WHERE id=$1`,
		accountID, uidValidity, lastUID,
	)
	return err
}

func (r *MailRepo) RecordForwardEvent(accountID int64, folder string, uidValidity, uid uint32, messageID string, recipients []string, status, errorMessage string) error {
	_, err := r.db.Exec(
		`INSERT INTO mail_forward_events(
		     account_id,folder,uid_validity,message_uid,message_id,recipients,status,error_message,created_at
		 ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW())
		 ON CONFLICT (account_id,folder,uid_validity,message_uid) DO UPDATE SET
		     message_id=EXCLUDED.message_id, recipients=EXCLUDED.recipients,
		     status=EXCLUDED.status, error_message=EXCLUDED.error_message`,
		accountID, folder, uidValidity, uid, strings.TrimSpace(messageID), pq.Array(recipients), status, errorMessage,
	)
	return err
}

type mailScanner interface{ Scan(...any) error }

func mailAccountSelectSQL() string {
	return `SELECT account.id, usr.id, usr.username, usr.email,
	              account.provider, account.email_address, account.display_name, account.username,
	              account.password_encrypted, account.api_base_url, account.client_id,
	              account.client_secret_encrypted, account.is_default,
	              account.signature_html, account.enabled,
	              account.auto_forward_enabled, account.auto_forward_to, account.forward_attachments,
	              account.forward_uid_validity, account.forward_last_uid,
	              account.last_verified_at, account.last_sync_at, account.last_error,
	              account.created_at, account.updated_at
	         FROM users usr
	         LEFT JOIN mail_accounts account ON account.user_id = usr.id`
}

func scanMailAccount(scanner mailScanner) (*model.MailAccount, error) {
	var account model.MailAccount
	var id sql.NullInt64
	var provider, emailAddress, displayName, loginUsername, encryptedPassword sql.NullString
	var apiBaseURL, clientID, encryptedClientSecret, signature, lastError sql.NullString
	var isDefault, enabled sql.NullBool
	var autoForwardEnabled, forwardAttachments sql.NullBool
	var forwardUIDValidity, forwardLastUID sql.NullInt64
	var verifiedAt, syncAt, createdAt, updatedAt sql.NullTime
	err := scanner.Scan(
		&id, &account.UserID, &account.Username, &account.UserEmail,
		&provider, &emailAddress, &displayName, &loginUsername, &encryptedPassword,
		&apiBaseURL, &clientID, &encryptedClientSecret, &isDefault, &signature, &enabled,
		&autoForwardEnabled, pq.Array(&account.AutoForwardTo), &forwardAttachments,
		&forwardUIDValidity, &forwardLastUID,
		&verifiedAt, &syncAt, &lastError, &createdAt, &updatedAt,
	)
	if err != nil {
		return nil, err
	}
	if !id.Valid {
		return nil, sql.ErrNoRows
	}
	account.ID = id.Int64
	account.Provider = provider.String
	if account.Provider == "" {
		account.Provider = "imap"
	}
	if account.Provider == "alimail" {
		account.ProviderLabel = "阿里邮箱"
	} else {
		account.ProviderLabel = "Poste.io / IMAP"
	}
	account.EmailAddress = emailAddress.String
	account.DisplayName = displayName.String
	account.LoginUsername = loginUsername.String
	account.PasswordEncrypted = encryptedPassword.String
	account.PasswordConfigured = strings.TrimSpace(encryptedPassword.String) != ""
	account.APIBaseURL = apiBaseURL.String
	account.ClientID = clientID.String
	account.ClientSecretEncrypted = encryptedClientSecret.String
	account.ClientSecretConfigured = strings.TrimSpace(encryptedClientSecret.String) != ""
	account.IsDefault = isDefault.Bool
	account.SignatureHTML = signature.String
	account.Enabled = enabled.Bool
	account.AutoForwardEnabled = autoForwardEnabled.Bool
	account.ForwardAttachments = !forwardAttachments.Valid || forwardAttachments.Bool
	if forwardUIDValidity.Valid && forwardUIDValidity.Int64 > 0 {
		account.ForwardUIDValidity = uint32(forwardUIDValidity.Int64)
	}
	if forwardLastUID.Valid && forwardLastUID.Int64 > 0 {
		account.ForwardLastUID = uint32(forwardLastUID.Int64)
	}
	account.LastError = lastError.String
	account.CreatedAt = nullMailTime(createdAt)
	account.UpdatedAt = nullMailTime(updatedAt)
	if verifiedAt.Valid {
		value := verifiedAt.Time
		account.LastVerifiedAt = &value
	}
	if syncAt.Valid {
		value := syncAt.Time
		account.LastSyncAt = &value
	}
	return &account, nil
}

func (r *MailRepo) ResolveRemoteMessageUID(accountID int64, remoteID, folderID string) (uint32, error) {
	remoteID = strings.TrimSpace(remoteID)
	if accountID <= 0 || remoteID == "" {
		return 0, fmt.Errorf("invalid remote mail reference")
	}
	var uid int64
	err := r.db.QueryRow(
		`INSERT INTO mail_remote_message_refs(account_id,remote_id,folder_id,created_at,updated_at)
		 VALUES($1,$2,$3,NOW(),NOW())
		 ON CONFLICT(account_id,remote_id) DO UPDATE SET folder_id=EXCLUDED.folder_id,updated_at=NOW()
		 RETURNING uid`,
		accountID, remoteID, strings.TrimSpace(folderID),
	).Scan(&uid)
	if err != nil {
		return 0, err
	}
	if uid <= 0 || uid > int64(^uint32(0)) {
		return 0, fmt.Errorf("remote mail reference limit exceeded")
	}
	return uint32(uid), nil
}

func (r *MailRepo) GetRemoteMessageRef(accountID int64, uid uint32) (string, string, error) {
	var remoteID, folderID string
	err := r.db.QueryRow(
		`SELECT remote_id,folder_id FROM mail_remote_message_refs WHERE account_id=$1 AND uid=$2`,
		accountID, uid,
	).Scan(&remoteID, &folderID)
	return remoteID, folderID, err
}

func (r *MailRepo) CreateBulkJob(userID, accountID int64, subject string, payload []byte, recipients []model.MailBulkRecipient, attachments []model.MailBulkAttachment) (*model.MailBulkJob, error) {
	if userID <= 0 || accountID <= 0 || len(payload) == 0 || len(recipients) == 0 || len(recipients) > 1000 {
		return nil, fmt.Errorf("invalid bulk mail job")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	job := &model.MailBulkJob{}
	err = tx.QueryRow(
		`INSERT INTO mail_bulk_jobs(user_id,account_id,status,subject,payload,total_count,created_at,updated_at)
		 SELECT $1,$2,'queued',$3,$4::jsonb,$5,NOW(),NOW()
		   FROM mail_accounts
		  WHERE id=$2 AND user_id=$1 AND enabled
		 RETURNING id,user_id,account_id,status,subject,total_count,sent_count,failed_count,
		           last_error,created_at,started_at,finished_at,updated_at`,
		userID, accountID, strings.TrimSpace(subject), payload, len(recipients),
	).Scan(
		&job.ID, &job.UserID, &job.AccountID, &job.Status, &job.Subject,
		&job.TotalCount, &job.SentCount, &job.FailedCount, &job.LastError,
		&job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	recipientStmt, err := tx.Prepare(pq.CopyIn("mail_bulk_recipients", "job_id", "name", "email", "status"))
	if err != nil {
		return nil, err
	}
	for _, recipient := range recipients {
		if _, err := recipientStmt.Exec(job.ID, strings.TrimSpace(recipient.Name), strings.ToLower(strings.TrimSpace(recipient.Email)), "pending"); err != nil {
			_ = recipientStmt.Close()
			return nil, err
		}
	}
	if _, err := recipientStmt.Exec(); err != nil {
		_ = recipientStmt.Close()
		return nil, err
	}
	if err := recipientStmt.Close(); err != nil {
		return nil, err
	}
	if len(attachments) > 0 {
		attachmentStmt, err := tx.Prepare(pq.CopyIn("mail_bulk_attachments", "job_id", "filename", "content_type", "data"))
		if err != nil {
			return nil, err
		}
		for _, attachment := range attachments {
			if _, err := attachmentStmt.Exec(job.ID, attachment.Filename, attachment.ContentType, attachment.Data); err != nil {
				_ = attachmentStmt.Close()
				return nil, err
			}
		}
		if _, err := attachmentStmt.Exec(); err != nil {
			_ = attachmentStmt.Close()
			return nil, err
		}
		if err := attachmentStmt.Close(); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return job, nil
}

func (r *MailRepo) ListBulkJobs(userID int64, limit int) ([]model.MailBulkJob, error) {
	if limit < 1 || limit > 100 {
		limit = 30
	}
	rows, err := r.db.Query(
		`SELECT id,user_id,account_id,status,subject,total_count,sent_count,failed_count,
		        last_error,created_at,started_at,finished_at,updated_at
		   FROM mail_bulk_jobs WHERE user_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2`,
		userID, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.MailBulkJob, 0)
	for rows.Next() {
		job, scanErr := scanMailBulkJob(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		result = append(result, *job)
	}
	return result, rows.Err()
}

func (r *MailRepo) GetBulkJob(userID, jobID int64) (*model.MailBulkJob, error) {
	job, err := scanMailBulkJob(r.db.QueryRow(
		`SELECT id,user_id,account_id,status,subject,total_count,sent_count,failed_count,
		        last_error,created_at,started_at,finished_at,updated_at
		   FROM mail_bulk_jobs WHERE id=$1 AND user_id=$2`,
		jobID, userID,
	))
	if err != nil {
		return nil, err
	}
	recipients, err := r.ListBulkRecipients(job.ID)
	if err != nil {
		return nil, err
	}
	job.Recipients = recipients
	return job, nil
}

func (r *MailRepo) ClaimBulkJob(jobID int64) (*model.MailBulkJob, []byte, bool, error) {
	job := &model.MailBulkJob{}
	var payload []byte
	err := r.db.QueryRow(
		`UPDATE mail_bulk_jobs
		    SET status='running',started_at=COALESCE(started_at,NOW()),updated_at=NOW()
		  WHERE id=$1 AND status='queued'
		 RETURNING id,user_id,account_id,status,subject,total_count,sent_count,failed_count,
		           last_error,created_at,started_at,finished_at,updated_at,payload`,
		jobID,
	).Scan(
		&job.ID, &job.UserID, &job.AccountID, &job.Status, &job.Subject,
		&job.TotalCount, &job.SentCount, &job.FailedCount, &job.LastError,
		&job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt, &payload,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, false, nil
	}
	return job, payload, err == nil, err
}

func (r *MailRepo) ListBulkRecipients(jobID int64) ([]model.MailBulkRecipient, error) {
	rows, err := r.db.Query(
		`SELECT id,job_id,name,email,status,message_id,error_message,sent_at
		   FROM mail_bulk_recipients WHERE job_id=$1 ORDER BY id`,
		jobID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.MailBulkRecipient, 0)
	for rows.Next() {
		var recipient model.MailBulkRecipient
		if err := rows.Scan(
			&recipient.ID, &recipient.JobID, &recipient.Name, &recipient.Email,
			&recipient.Status, &recipient.MessageID, &recipient.ErrorMessage, &recipient.SentAt,
		); err != nil {
			return nil, err
		}
		result = append(result, recipient)
	}
	return result, rows.Err()
}

func (r *MailRepo) ListBulkAttachments(jobID int64) ([]model.MailBulkAttachment, error) {
	rows, err := r.db.Query(
		`SELECT id,job_id,filename,content_type,data FROM mail_bulk_attachments WHERE job_id=$1 ORDER BY id`,
		jobID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.MailBulkAttachment, 0)
	for rows.Next() {
		var attachment model.MailBulkAttachment
		if err := rows.Scan(&attachment.ID, &attachment.JobID, &attachment.Filename, &attachment.ContentType, &attachment.Data); err != nil {
			return nil, err
		}
		result = append(result, attachment)
	}
	return result, rows.Err()
}

func (r *MailRepo) MarkBulkRecipientSending(recipientID int64) (bool, error) {
	result, err := r.db.Exec(
		`WITH marked AS (
		     UPDATE mail_bulk_recipients AS recipient
		        SET status='sending',updated_at=NOW()
		      WHERE recipient.id=$1 AND recipient.status='pending'
		        AND EXISTS (
		            SELECT 1 FROM mail_bulk_jobs AS job
		             WHERE job.id=recipient.job_id AND job.status='running'
		        )
		  RETURNING recipient.job_id
		 )
		 UPDATE mail_bulk_jobs AS job SET updated_at=NOW()
		   FROM marked WHERE job.id=marked.job_id`,
		recipientID,
	)
	if err != nil {
		return false, err
	}
	affected, err := result.RowsAffected()
	return affected > 0, err
}

func (r *MailRepo) CompleteBulkRecipient(recipientID int64, status, messageID, errorMessage string) error {
	if status != "sent" && status != "failed" {
		return fmt.Errorf("invalid bulk recipient status")
	}
	_, err := r.db.Exec(completeBulkRecipientSQL,
		recipientID, status, strings.TrimSpace(messageID), strings.TrimSpace(errorMessage),
	)
	return err
}

const completeBulkRecipientSQL = `WITH completed AS (
     UPDATE mail_bulk_recipients
        SET status=$2::VARCHAR(16),message_id=$3::TEXT,error_message=$4::TEXT,
            sent_at=CASE WHEN $2::VARCHAR(16)='sent' THEN NOW() ELSE NULL END,updated_at=NOW()
      WHERE id=$1 AND status='sending'
  RETURNING job_id
 )
 UPDATE mail_bulk_jobs AS job
    SET sent_count=sent_count + CASE WHEN $2::VARCHAR(16)='sent' THEN 1 ELSE 0 END,
        failed_count=failed_count + CASE WHEN $2::VARCHAR(16)='failed' THEN 1 ELSE 0 END,
        last_error=CASE WHEN $2::VARCHAR(16)='failed' THEN $4::TEXT ELSE last_error END,
        updated_at=NOW()
   FROM completed WHERE job.id=completed.job_id`

func (r *MailRepo) FinishBulkJob(jobID int64) error {
	_, err := r.db.Exec(
		`WITH counts AS (
		     SELECT job_id,
		            COUNT(*) FILTER (WHERE status='sent')::INTEGER AS sent_count,
		            COUNT(*) FILTER (WHERE status='failed')::INTEGER AS failed_count,
		            COUNT(*) FILTER (WHERE status IN ('pending','sending'))::INTEGER AS active_count
		       FROM mail_bulk_recipients WHERE job_id=$1 GROUP BY job_id
		 )
		 UPDATE mail_bulk_jobs AS job
		    SET sent_count=counts.sent_count,failed_count=counts.failed_count,
		        status=CASE
		            WHEN job.status='cancelled' THEN 'cancelled'
		            WHEN counts.active_count > 0 THEN job.status
		            WHEN counts.failed_count=0 THEN 'completed'
		            WHEN counts.sent_count=0 THEN 'failed'
		            ELSE 'partial'
		        END,
		        finished_at=CASE WHEN counts.active_count=0 OR job.status='cancelled' THEN NOW() ELSE finished_at END,
		        updated_at=NOW()
		   FROM counts WHERE job.id=counts.job_id`,
		jobID,
	)
	return err
}

func (r *MailRepo) FailBulkJob(jobID int64, errorMessage string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`UPDATE mail_bulk_recipients
		    SET status='failed',error_message=$2::TEXT,updated_at=NOW()
		  WHERE job_id=$1 AND status IN ('pending','sending')`,
		jobID, strings.TrimSpace(errorMessage),
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`UPDATE mail_bulk_jobs AS job
		    SET sent_count=(SELECT COUNT(*)::INTEGER FROM mail_bulk_recipients WHERE job_id=job.id AND status='sent'),
		        failed_count=(SELECT COUNT(*)::INTEGER FROM mail_bulk_recipients WHERE job_id=job.id AND status='failed'),
		        status=CASE
		            WHEN job.status='cancelled' THEN 'cancelled'
		            WHEN EXISTS (SELECT 1 FROM mail_bulk_recipients WHERE job_id=job.id AND status='sent') THEN 'partial'
		            ELSE 'failed'
		        END,
		        last_error=$2::TEXT,finished_at=NOW(),updated_at=NOW()
		  WHERE job.id=$1`,
		jobID, strings.TrimSpace(errorMessage),
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *MailRepo) CancelBulkJob(userID, jobID int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(
		`UPDATE mail_bulk_jobs
		    SET status='cancelled',finished_at=NOW(),updated_at=NOW()
		  WHERE id=$1 AND user_id=$2 AND status IN ('queued','running')`,
		jobID, userID,
	)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	if _, err := tx.Exec(
		`UPDATE mail_bulk_recipients SET status='cancelled',updated_at=NOW()
		  WHERE job_id=$1 AND status='pending'`,
		jobID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *MailRepo) RecoverStaleBulkJobs(staleBefore time.Time) ([]int64, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`UPDATE mail_bulk_recipients AS recipient
		    SET status='failed',error_message='服务中断，发送结果未知，已停止自动重试',updated_at=NOW()
		  WHERE recipient.status='sending'
		    AND EXISTS (
		        SELECT 1 FROM mail_bulk_jobs AS job
		         WHERE job.id=recipient.job_id AND job.status='running' AND job.updated_at < $1
		    )`,
		staleBefore,
	); err != nil {
		return nil, err
	}
	rows, err := tx.Query(
		`UPDATE mail_bulk_jobs AS job
		    SET status='queued',
		        sent_count=(SELECT COUNT(*)::INTEGER FROM mail_bulk_recipients WHERE job_id=job.id AND status='sent'),
		        failed_count=(SELECT COUNT(*)::INTEGER FROM mail_bulk_recipients WHERE job_id=job.id AND status='failed'),
		        updated_at=NOW()
		  WHERE job.status='running' AND job.updated_at < $1
		 RETURNING job.id`,
		staleBefore,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return ids, nil
}

func (r *MailRepo) ListQueuedBulkJobIDs(limit int) ([]int64, error) {
	if limit < 1 || limit > 5000 {
		limit = 1000
	}
	rows, err := r.db.Query(`SELECT id FROM mail_bulk_jobs WHERE status='queued' ORDER BY created_at,id LIMIT $1`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func scanMailBulkJob(scanner mailScanner) (*model.MailBulkJob, error) {
	job := &model.MailBulkJob{}
	err := scanner.Scan(
		&job.ID, &job.UserID, &job.AccountID, &job.Status, &job.Subject,
		&job.TotalCount, &job.SentCount, &job.FailedCount, &job.LastError,
		&job.CreatedAt, &job.StartedAt, &job.FinishedAt, &job.UpdatedAt,
	)
	return job, err
}

func (r *MailRepo) ListContacts(userID int64, query string) ([]model.MailContact, error) {
	rows, err := r.db.Query(
		`SELECT id,user_id,trade_customer_id,name,company,email,phone,notes,created_at,updated_at
		   FROM mail_contacts
		  WHERE user_id=$1
		    AND ($2='' OR CONCAT_WS(' ',name,company,email,phone,notes) ILIKE '%' || $2 || '%')
		  ORDER BY lower(name),lower(email)
		  LIMIT 500`,
		userID, strings.TrimSpace(query),
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	contacts := make([]model.MailContact, 0)
	for rows.Next() {
		contact, scanErr := scanMailContact(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		contacts = append(contacts, *contact)
	}
	return contacts, rows.Err()
}

func (r *MailRepo) UpsertContact(contact *model.MailContact) error {
	if contact == nil || contact.UserID <= 0 {
		return fmt.Errorf("invalid mail contact")
	}
	return r.db.QueryRow(
		`INSERT INTO mail_contacts(user_id,trade_customer_id,name,company,email,phone,notes,created_at,updated_at)
		 VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
		 ON CONFLICT (user_id,email) DO UPDATE SET
		     trade_customer_id=EXCLUDED.trade_customer_id,name=EXCLUDED.name,
		     company=EXCLUDED.company,phone=EXCLUDED.phone,notes=EXCLUDED.notes,updated_at=NOW()
		 RETURNING id,created_at,updated_at`,
		contact.UserID, contact.TradeCustomerID, contact.Name, contact.Company,
		contact.Email, contact.Phone, contact.Notes,
	).Scan(&contact.ID, &contact.CreatedAt, &contact.UpdatedAt)
}

func (r *MailRepo) UpdateContact(contact *model.MailContact) error {
	if contact == nil || contact.ID <= 0 || contact.UserID <= 0 {
		return fmt.Errorf("invalid mail contact")
	}
	return r.db.QueryRow(
		`UPDATE mail_contacts
		    SET trade_customer_id=$3,name=$4,company=$5,email=$6,phone=$7,notes=$8,updated_at=NOW()
		  WHERE id=$1 AND user_id=$2
		 RETURNING created_at,updated_at`,
		contact.ID, contact.UserID, contact.TradeCustomerID, contact.Name, contact.Company,
		contact.Email, contact.Phone, contact.Notes,
	).Scan(&contact.CreatedAt, &contact.UpdatedAt)
}

func (r *MailRepo) DeleteContact(userID, contactID int64) error {
	result, err := r.db.Exec(`DELETE FROM mail_contacts WHERE id=$1 AND user_id=$2`, contactID, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *MailRepo) ListSignatures(userID int64) ([]model.MailSignature, error) {
	rows, err := r.db.Query(
		`SELECT id,user_id,title,html_content,apply_to_new,apply_to_reply,created_at,updated_at
		   FROM mail_signatures WHERE user_id=$1 ORDER BY created_at,id`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make([]model.MailSignature, 0)
	for rows.Next() {
		var signature model.MailSignature
		if err := rows.Scan(
			&signature.ID, &signature.UserID, &signature.Title, &signature.HTMLContent,
			&signature.ApplyToNew, &signature.ApplyToReply, &signature.CreatedAt, &signature.UpdatedAt,
		); err != nil {
			return nil, err
		}
		result = append(result, signature)
	}
	return result, rows.Err()
}

func (r *MailRepo) CountSignatures(userID int64) (int, error) {
	var count int
	err := r.db.QueryRow(`SELECT COUNT(*) FROM mail_signatures WHERE user_id=$1`, userID).Scan(&count)
	return count, err
}

func (r *MailRepo) CreateSignature(signature *model.MailSignature) error {
	return r.saveSignature(signature, false)
}

func (r *MailRepo) UpdateSignature(signature *model.MailSignature) error {
	return r.saveSignature(signature, true)
}

func (r *MailRepo) saveSignature(signature *model.MailSignature, update bool) error {
	if signature == nil || signature.UserID <= 0 {
		return fmt.Errorf("invalid mail signature")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if signature.ApplyToNew {
		if _, err := tx.Exec(`UPDATE mail_signatures SET apply_to_new=FALSE,updated_at=NOW() WHERE user_id=$1`, signature.UserID); err != nil {
			return err
		}
	}
	if signature.ApplyToReply {
		if _, err := tx.Exec(`UPDATE mail_signatures SET apply_to_reply=FALSE,updated_at=NOW() WHERE user_id=$1`, signature.UserID); err != nil {
			return err
		}
	}
	if update {
		err = tx.QueryRow(
			`UPDATE mail_signatures
			    SET title=$3,html_content=$4,apply_to_new=$5,apply_to_reply=$6,updated_at=NOW()
			  WHERE id=$1 AND user_id=$2
			 RETURNING created_at,updated_at`,
			signature.ID, signature.UserID, signature.Title, signature.HTMLContent,
			signature.ApplyToNew, signature.ApplyToReply,
		).Scan(&signature.CreatedAt, &signature.UpdatedAt)
	} else {
		err = tx.QueryRow(
			`INSERT INTO mail_signatures(user_id,title,html_content,apply_to_new,apply_to_reply,created_at,updated_at)
			 VALUES($1,$2,$3,$4,$5,NOW(),NOW()) RETURNING id,created_at,updated_at`,
			signature.UserID, signature.Title, signature.HTMLContent,
			signature.ApplyToNew, signature.ApplyToReply,
		).Scan(&signature.ID, &signature.CreatedAt, &signature.UpdatedAt)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (r *MailRepo) DeleteSignature(userID, signatureID int64) error {
	result, err := r.db.Exec(`DELETE FROM mail_signatures WHERE id=$1 AND user_id=$2`, signatureID, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func scanMailContact(scanner mailScanner) (*model.MailContact, error) {
	var contact model.MailContact
	var customerID sql.NullInt64
	if err := scanner.Scan(
		&contact.ID, &contact.UserID, &customerID, &contact.Name, &contact.Company,
		&contact.Email, &contact.Phone, &contact.Notes, &contact.CreatedAt, &contact.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if customerID.Valid {
		value := customerID.Int64
		contact.TradeCustomerID = &value
	}
	contact.Source = "saved"
	return &contact, nil
}

func nullMailTime(value sql.NullTime) time.Time {
	if value.Valid {
		return value.Time
	}
	return time.Time{}
}

func IsMailAccountMissing(err error) bool { return errors.Is(err, sql.ErrNoRows) }
