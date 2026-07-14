package repo

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

type WhatsAppRepo struct{ db *sql.DB }

func NewWhatsAppRepo(db *sql.DB) *WhatsAppRepo { return &WhatsAppRepo{db: db} }

func (r *WhatsAppRepo) GetSettings(keys []string) (map[string]string, error) {
	result := make(map[string]string, len(keys))
	if len(keys) == 0 {
		return result, nil
	}
	rows, err := r.db.Query(`SELECT key, value FROM settings WHERE key = ANY($1)`, pq.Array(keys))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		result[key] = value
	}
	return result, rows.Err()
}

func (r *WhatsAppRepo) UpsertSettings(values map[string]string) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for key, value := range values {
		if _, err := tx.Exec(
			`INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`, key, value,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *WhatsAppRepo) EnsureAccount(userID int64) (*model.WhatsAppAccount, error) {
	if userID <= 0 {
		return nil, fmt.Errorf("invalid user id")
	}
	if _, err := r.db.Exec(
		`INSERT INTO whatsapp_accounts (user_id, enabled, auto_start, created_at, updated_at)
		 VALUES ($1, TRUE, TRUE, NOW(), NOW()) ON CONFLICT (user_id) DO NOTHING`, userID,
	); err != nil {
		return nil, err
	}
	return r.GetAccountByUserID(userID)
}

func (r *WhatsAppRepo) GetAccountByUserID(userID int64) (*model.WhatsAppAccount, error) {
	return scanWhatsAppAccount(r.db.QueryRow(whatsAppAccountSelectSQL()+` WHERE wa.user_id = $1`, userID))
}

func (r *WhatsAppRepo) GetAccountByID(accountID int64) (*model.WhatsAppAccount, error) {
	return scanWhatsAppAccount(r.db.QueryRow(whatsAppAccountSelectSQL()+` WHERE wa.id = $1`, accountID))
}

func (r *WhatsAppRepo) ListAccounts() ([]model.WhatsAppAccount, error) {
	if _, err := r.db.Exec(
		`INSERT INTO whatsapp_accounts (user_id, enabled, auto_start, created_at, updated_at)
		 SELECT id, TRUE, TRUE, NOW(), NOW() FROM users
		 ON CONFLICT (user_id) DO NOTHING`,
	); err != nil {
		return nil, err
	}
	rows, err := r.db.Query(whatsAppAccountSelectSQL() + ` ORDER BY CASE WHEN wa.status = 'ready' THEN 0 ELSE 1 END, u.username, wa.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]model.WhatsAppAccount, 0)
	for rows.Next() {
		account, err := scanWhatsAppAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, *account)
	}
	return accounts, rows.Err()
}

func (r *WhatsAppRepo) ListAutoStartAccounts() ([]model.WhatsAppAccount, error) {
	rows, err := r.db.Query(whatsAppAccountSelectSQL() + ` WHERE wa.enabled AND wa.auto_start
		AND (wa.last_connected_at IS NOT NULL OR wa.whatsapp_id <> '' OR wa.user_id = 1) ORDER BY wa.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	accounts := make([]model.WhatsAppAccount, 0)
	for rows.Next() {
		account, err := scanWhatsAppAccount(rows)
		if err != nil {
			return nil, err
		}
		accounts = append(accounts, *account)
	}
	return accounts, rows.Err()
}

func (r *WhatsAppRepo) UpdateAccountPreferences(userID int64, enabled, autoStart bool) error {
	_, err := r.db.Exec(
		`UPDATE whatsapp_accounts SET enabled = $1, auto_start = $2, updated_at = NOW() WHERE user_id = $3`,
		enabled, autoStart, userID,
	)
	return err
}

func (r *WhatsAppRepo) UpdateAccountRuntime(userID int64, status, whatsappID, displayName, phoneNumber, profilePicURL, about, platform, lastError string) error {
	_, err := r.db.Exec(
		`UPDATE whatsapp_accounts
		    SET status = $1::VARCHAR, whatsapp_id = $2, display_name = $3, phone_number = $4,
		        profile_pic_url = $5, about = $6, platform = $7, last_error = $8,
		        last_connected_at = CASE WHEN $1::VARCHAR = 'ready' THEN NOW() ELSE last_connected_at END,
		        updated_at = NOW()
		  WHERE user_id = $9`,
		status, whatsappID, displayName, phoneNumber, profilePicURL, about, platform, lastError, userID,
	)
	return err
}

func (r *WhatsAppRepo) GetChannelLink(channelID int64) (*model.WhatsAppChannelLink, error) {
	return scanWhatsAppChannelLink(r.db.QueryRow(whatsAppChannelLinkSelectSQL()+` WHERE link.channel_id = $1`, channelID))
}

func (r *WhatsAppRepo) FindChannelLink(accountID int64, chatID string) (*model.WhatsAppChannelLink, error) {
	return scanWhatsAppChannelLink(r.db.QueryRow(
		whatsAppChannelLinkSelectSQL()+` WHERE link.whatsapp_account_id = $1 AND link.whatsapp_chat_id = $2`, accountID, chatID,
	))
}

func (r *WhatsAppRepo) UpsertChannelLink(link *model.WhatsAppChannelLink) error {
	return r.db.QueryRow(
		`INSERT INTO whatsapp_channel_links (
		     channel_id, whatsapp_account_id, whatsapp_chat_id, whatsapp_chat_name,
		     whatsapp_chat_avatar_url, whatsapp_chat_about, whatsapp_is_group, whatsapp_participant_count,
		     sync_inbound, sync_outbound, created_by, created_at, updated_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		 ON CONFLICT (channel_id) DO UPDATE SET
		     whatsapp_account_id = EXCLUDED.whatsapp_account_id,
		     whatsapp_chat_id = EXCLUDED.whatsapp_chat_id,
		     whatsapp_chat_name = EXCLUDED.whatsapp_chat_name,
		     whatsapp_chat_avatar_url = EXCLUDED.whatsapp_chat_avatar_url,
		     whatsapp_chat_about = EXCLUDED.whatsapp_chat_about,
		     whatsapp_is_group = EXCLUDED.whatsapp_is_group,
		     whatsapp_participant_count = EXCLUDED.whatsapp_participant_count,
		     sync_inbound = EXCLUDED.sync_inbound,
		     sync_outbound = EXCLUDED.sync_outbound,
		     updated_at = NOW()
		 RETURNING created_at, updated_at`,
		link.ChannelID, link.WhatsAppAccountID, link.WhatsAppChatID, link.WhatsAppChatName,
		link.WhatsAppChatAvatarURL, link.WhatsAppChatAbout, link.WhatsAppIsGroup, link.WhatsAppParticipantCount,
		link.SyncInbound, link.SyncOutbound, link.CreatedBy,
	).Scan(&link.CreatedAt, &link.UpdatedAt)
}

func (r *WhatsAppRepo) DeleteChannelLink(channelID int64) error {
	result, err := r.db.Exec(`DELETE FROM whatsapp_channel_links WHERE channel_id = $1`, channelID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *WhatsAppRepo) HasExternalMessage(accountID int64, source, externalID string) (bool, error) {
	var exists bool
	err := r.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM channel_messages WHERE external_account_id = $1 AND external_source = $2 AND external_message_id = $3)`,
		accountID, source, externalID,
	).Scan(&exists)
	return exists, err
}

func (r *WhatsAppRepo) CreateExternalMessage(message *model.ChannelMessage) error {
	if message.ExternalAccountID == nil || message.ExternalMessageID == nil || message.ExternalSenderName == nil {
		return errors.New("external message metadata is required")
	}
	return r.db.QueryRow(
		`INSERT INTO channel_messages (
		     channel_id, sender_id, sender_type, content, attachment_id, external_source, external_account_id,
		     external_message_id, external_sender_name, external_sender_address, external_sender_avatar, created_at
		 ) VALUES ($1,NULL,'whatsapp',$2,$3,'whatsapp',$4,$5,$6,$7,$8,NOW())
		 ON CONFLICT DO NOTHING RETURNING id, created_at`,
		message.ChannelID, message.Content, message.AttachmentID, *message.ExternalAccountID, *message.ExternalMessageID,
		*message.ExternalSenderName, message.ExternalSenderAddress, message.ExternalSenderAvatar,
	).Scan(&message.ID, &message.CreatedAt)
}

func (r *WhatsAppRepo) RecordMessageLink(accountID, channelMessageID int64, whatsappMessageID, direction string, ack *int) error {
	_, err := r.db.Exec(
		`INSERT INTO whatsapp_message_links (whatsapp_account_id, channel_message_id, whatsapp_message_id, direction, ack, created_at, updated_at)
		 VALUES ($1,$2,$3,$4,$5,NOW(),NOW())
		 ON CONFLICT (channel_message_id, whatsapp_message_id)
		 DO UPDATE SET whatsapp_account_id = EXCLUDED.whatsapp_account_id,
		               ack = COALESCE(EXCLUDED.ack, whatsapp_message_links.ack), updated_at = NOW()`,
		accountID, channelMessageID, whatsappMessageID, direction, ack,
	)
	return err
}

func (r *WhatsAppRepo) ExternalMessageID(accountID, channelMessageID int64) (string, error) {
	var messageID string
	err := r.db.QueryRow(
		`SELECT whatsapp_message_id FROM whatsapp_message_links
		  WHERE whatsapp_account_id = $1 AND channel_message_id = $2 ORDER BY id DESC LIMIT 1`, accountID, channelMessageID,
	).Scan(&messageID)
	return messageID, err
}

func (r *WhatsAppRepo) UpdateMessageAck(accountID int64, whatsappMessageID string, ack int) error {
	_, err := r.db.Exec(
		`UPDATE whatsapp_message_links SET ack = $1, updated_at = NOW()
		  WHERE whatsapp_account_id = $2 AND whatsapp_message_id = $3`, ack, accountID, whatsappMessageID,
	)
	return err
}

func (r *WhatsAppRepo) TouchChannel(channelID int64) error {
	result, err := r.db.Exec(`UPDATE channels SET updated_at = NOW() WHERE id = $1`, channelID)
	if err != nil {
		return err
	}
	if count, _ := result.RowsAffected(); count == 0 {
		return fmt.Errorf("channel not found")
	}
	return nil
}

func whatsAppAccountSelectSQL() string {
	return `SELECT wa.id, wa.user_id, COALESCE(u.username,''), COALESCE(u.email,''),
	               wa.enabled, wa.auto_start, wa.status, wa.whatsapp_id, wa.display_name, wa.phone_number,
	               wa.profile_pic_url, wa.about, wa.platform, wa.last_error, wa.last_connected_at,
	               wa.created_at, wa.updated_at
	          FROM whatsapp_accounts wa JOIN users u ON u.id = wa.user_id`
}

func scanWhatsAppAccount(scanner interface{ Scan(...any) error }) (*model.WhatsAppAccount, error) {
	var account model.WhatsAppAccount
	var connectedAt sql.NullTime
	err := scanner.Scan(
		&account.ID, &account.UserID, &account.Username, &account.Email,
		&account.Enabled, &account.AutoStart, &account.Status, &account.WhatsAppID, &account.DisplayName,
		&account.PhoneNumber, &account.ProfilePicURL, &account.About, &account.Platform, &account.LastError,
		&connectedAt, &account.CreatedAt, &account.UpdatedAt,
	)
	if connectedAt.Valid {
		account.LastConnectedAt = &connectedAt.Time
	}
	return &account, err
}

func whatsAppChannelLinkSelectSQL() string {
	return `SELECT link.channel_id, COALESCE(link.whatsapp_account_id,0), COALESCE(account.user_id,0),
	               COALESCE(u.username,''), COALESCE(NULLIF(account.display_name,''), u.username, ''),
	               link.whatsapp_chat_id, link.whatsapp_chat_name, link.whatsapp_chat_avatar_url,
	               link.whatsapp_chat_about, link.whatsapp_is_group, link.whatsapp_participant_count,
	               link.sync_inbound, link.sync_outbound, COALESCE(link.created_by,0), link.created_at, link.updated_at
	          FROM whatsapp_channel_links link
	          LEFT JOIN whatsapp_accounts account ON account.id = link.whatsapp_account_id
	          LEFT JOIN users u ON u.id = account.user_id`
}

func scanWhatsAppChannelLink(scanner interface{ Scan(...any) error }) (*model.WhatsAppChannelLink, error) {
	var link model.WhatsAppChannelLink
	err := scanner.Scan(
		&link.ChannelID, &link.WhatsAppAccountID, &link.WhatsAppUserID, &link.WhatsAppUsername, &link.WhatsAppDisplayName,
		&link.WhatsAppChatID, &link.WhatsAppChatName, &link.WhatsAppChatAvatarURL, &link.WhatsAppChatAbout,
		&link.WhatsAppIsGroup, &link.WhatsAppParticipantCount, &link.SyncInbound, &link.SyncOutbound,
		&link.CreatedBy, &link.CreatedAt, &link.UpdatedAt,
	)
	return &link, err
}
