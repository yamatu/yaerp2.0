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
	return scanMailAccount(r.db.QueryRow(mailAccountSelectSQL()+` WHERE account.user_id = $1`, userID))
}

func (r *MailRepo) UpsertAccount(account *model.MailAccount) error {
	if account == nil || account.UserID <= 0 {
		return fmt.Errorf("invalid mail account")
	}
	return r.db.QueryRow(
		`INSERT INTO mail_accounts (
		     user_id, email_address, display_name, username, password_encrypted,
		     signature_html, enabled, auto_forward_enabled, auto_forward_to, forward_attachments,
		     forward_uid_validity, forward_last_uid,
		     last_verified_at, last_error, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW(),NOW())
		 ON CONFLICT (user_id) DO UPDATE SET
		     email_address=EXCLUDED.email_address,
		     display_name=EXCLUDED.display_name,
		     username=EXCLUDED.username,
		     password_encrypted=EXCLUDED.password_encrypted,
		     signature_html=EXCLUDED.signature_html,
		     enabled=EXCLUDED.enabled,
		     auto_forward_enabled=EXCLUDED.auto_forward_enabled,
		     auto_forward_to=EXCLUDED.auto_forward_to,
		     forward_attachments=EXCLUDED.forward_attachments,
		     forward_uid_validity=EXCLUDED.forward_uid_validity,
		     forward_last_uid=EXCLUDED.forward_last_uid,
		     last_verified_at=EXCLUDED.last_verified_at,
		     last_error=EXCLUDED.last_error,
		     updated_at=NOW()
		 RETURNING id, created_at, updated_at`,
		account.UserID, account.EmailAddress, account.DisplayName, account.LoginUsername,
		account.PasswordEncrypted, account.SignatureHTML, account.Enabled,
		account.AutoForwardEnabled, pq.Array(account.AutoForwardTo), account.ForwardAttachments,
		account.ForwardUIDValidity, account.ForwardLastUID,
		account.LastVerifiedAt, account.LastError,
	).Scan(&account.ID, &account.CreatedAt, &account.UpdatedAt)
}

func (r *MailRepo) DeleteAccount(userID int64) error {
	result, err := r.db.Exec(`DELETE FROM mail_accounts WHERE user_id = $1`, userID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *MailRepo) UpdateAccountStatus(userID int64, verified bool, syncAt bool, lastError string) error {
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
		  WHERE user_id = $1`,
		userID, verified, syncAt, lastError,
	)
	return err
}

func (r *MailRepo) ListAccounts() ([]model.MailAccount, error) {
	rows, err := r.db.Query(mailAccountSelectSQL() + ` WHERE account.id IS NOT NULL ORDER BY usr.username`)
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
	              account.email_address, account.display_name, account.username,
	              account.password_encrypted, account.signature_html, account.enabled,
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
	var emailAddress, displayName, loginUsername, encryptedPassword, signature, lastError sql.NullString
	var enabled sql.NullBool
	var autoForwardEnabled, forwardAttachments sql.NullBool
	var forwardUIDValidity, forwardLastUID sql.NullInt64
	var verifiedAt, syncAt, createdAt, updatedAt sql.NullTime
	err := scanner.Scan(
		&id, &account.UserID, &account.Username, &account.UserEmail,
		&emailAddress, &displayName, &loginUsername, &encryptedPassword, &signature, &enabled,
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
	account.EmailAddress = emailAddress.String
	account.DisplayName = displayName.String
	account.LoginUsername = loginUsername.String
	account.PasswordEncrypted = encryptedPassword.String
	account.PasswordConfigured = strings.TrimSpace(encryptedPassword.String) != ""
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
