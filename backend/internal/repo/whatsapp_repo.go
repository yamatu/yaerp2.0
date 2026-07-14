package repo

import (
	"database/sql"
	"errors"
	"fmt"

	"github.com/lib/pq"

	"yaerp/internal/model"
)

type WhatsAppRepo struct {
	db *sql.DB
}

func NewWhatsAppRepo(db *sql.DB) *WhatsAppRepo {
	return &WhatsAppRepo{db: db}
}

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
			 ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
			key, value,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *WhatsAppRepo) GetChannelLink(channelID int64) (*model.WhatsAppChannelLink, error) {
	link := &model.WhatsAppChannelLink{}
	err := r.db.QueryRow(
		`SELECT channel_id, whatsapp_chat_id, whatsapp_chat_name, sync_inbound, sync_outbound,
		        COALESCE(created_by, 0), created_at, updated_at
		   FROM whatsapp_channel_links WHERE channel_id = $1`, channelID,
	).Scan(&link.ChannelID, &link.WhatsAppChatID, &link.WhatsAppChatName, &link.SyncInbound,
		&link.SyncOutbound, &link.CreatedBy, &link.CreatedAt, &link.UpdatedAt)
	return link, err
}

func (r *WhatsAppRepo) FindChannelLinkByChatID(chatID string) (*model.WhatsAppChannelLink, error) {
	link := &model.WhatsAppChannelLink{}
	err := r.db.QueryRow(
		`SELECT channel_id, whatsapp_chat_id, whatsapp_chat_name, sync_inbound, sync_outbound,
		        COALESCE(created_by, 0), created_at, updated_at
		   FROM whatsapp_channel_links WHERE whatsapp_chat_id = $1`, chatID,
	).Scan(&link.ChannelID, &link.WhatsAppChatID, &link.WhatsAppChatName, &link.SyncInbound,
		&link.SyncOutbound, &link.CreatedBy, &link.CreatedAt, &link.UpdatedAt)
	return link, err
}

func (r *WhatsAppRepo) UpsertChannelLink(link *model.WhatsAppChannelLink) error {
	return r.db.QueryRow(
		`INSERT INTO whatsapp_channel_links (
		     channel_id, whatsapp_chat_id, whatsapp_chat_name, sync_inbound, sync_outbound, created_by, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
		 ON CONFLICT (channel_id) DO UPDATE SET
		     whatsapp_chat_id = EXCLUDED.whatsapp_chat_id,
		     whatsapp_chat_name = EXCLUDED.whatsapp_chat_name,
		     sync_inbound = EXCLUDED.sync_inbound,
		     sync_outbound = EXCLUDED.sync_outbound,
		     updated_at = NOW()
		 RETURNING created_at, updated_at`,
		link.ChannelID, link.WhatsAppChatID, link.WhatsAppChatName, link.SyncInbound, link.SyncOutbound, link.CreatedBy,
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

func (r *WhatsAppRepo) HasExternalMessage(source, externalID string) (bool, error) {
	var exists bool
	err := r.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM channel_messages WHERE external_source = $1 AND external_message_id = $2)`,
		source, externalID,
	).Scan(&exists)
	return exists, err
}

func (r *WhatsAppRepo) CreateExternalMessage(message *model.ChannelMessage) error {
	if message.ExternalMessageID == nil || message.ExternalSenderName == nil {
		return errors.New("external message metadata is required")
	}
	return r.db.QueryRow(
		`INSERT INTO channel_messages (
		     channel_id, sender_id, sender_type, content, attachment_id, external_source,
		     external_message_id, external_sender_name, external_sender_address, created_at
		 ) VALUES ($1, NULL, 'whatsapp', $2, $3, 'whatsapp', $4, $5, $6, NOW())
		 ON CONFLICT DO NOTHING
		 RETURNING id, created_at`,
		message.ChannelID, message.Content, message.AttachmentID, *message.ExternalMessageID,
		*message.ExternalSenderName, message.ExternalSenderAddress,
	).Scan(&message.ID, &message.CreatedAt)
}

func (r *WhatsAppRepo) RecordMessageLink(channelMessageID int64, whatsappMessageID, direction string, ack *int) error {
	_, err := r.db.Exec(
		`INSERT INTO whatsapp_message_links (channel_message_id, whatsapp_message_id, direction, ack, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, NOW(), NOW())
		 ON CONFLICT (channel_message_id, whatsapp_message_id)
		 DO UPDATE SET ack = COALESCE(EXCLUDED.ack, whatsapp_message_links.ack), updated_at = NOW()`,
		channelMessageID, whatsappMessageID, direction, ack,
	)
	return err
}

func (r *WhatsAppRepo) ExternalMessageID(channelMessageID int64) (string, error) {
	var messageID string
	err := r.db.QueryRow(
		`SELECT whatsapp_message_id FROM whatsapp_message_links
		  WHERE channel_message_id = $1 ORDER BY id DESC LIMIT 1`, channelMessageID,
	).Scan(&messageID)
	return messageID, err
}

func (r *WhatsAppRepo) UpdateMessageAck(whatsappMessageID string, ack int) error {
	_, err := r.db.Exec(
		`UPDATE whatsapp_message_links SET ack = $1, updated_at = NOW() WHERE whatsapp_message_id = $2`,
		ack, whatsappMessageID,
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
