package repo

import (
	"database/sql"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

func (r *ChannelRepo) ListAllMessages(channelID int64) ([]model.ChannelMessage, error) {
	rows, err := r.db.Query(
		channelMessageSelectSQL()+` WHERE m.channel_id = $1 ORDER BY m.created_at ASC, m.id ASC`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	messages := make([]model.ChannelMessage, 0)
	for rows.Next() {
		message, err := scanChannelMessage(rows)
		if err != nil {
			return nil, err
		}
		messages = append(messages, *message)
	}
	return messages, rows.Err()
}

func (r *ChannelRepo) CreateBackup(backup *model.ChannelBackup) error {
	return r.db.QueryRow(
		`INSERT INTO channel_backups (
		     source_channel_id, source_channel_name, created_by, filename, attachment_id, message_count, size,
		     checksum, snapshot_version, verified_at, created_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()) RETURNING id, created_at`,
		backup.SourceChannelID, backup.SourceChannelName, backup.CreatedBy, backup.Filename,
		backup.AttachmentID, backup.MessageCount, backup.Size, backup.Checksum, backup.SnapshotVersion, backup.VerifiedAt,
	).Scan(&backup.ID, &backup.CreatedAt)
}

func (r *ChannelRepo) ListBackups(userID int64) ([]model.ChannelBackup, error) {
	rows, err := r.db.Query(
		`SELECT b.id, b.source_channel_id, b.source_channel_name, b.created_by,
		        COALESCE(u.username, ''), b.filename, b.attachment_id, b.message_count, b.size,
		        b.checksum, b.snapshot_version, b.verified_at,
		        COUNT(br.id), MAX(br.created_at), b.created_at
		   FROM channel_backups b
		   LEFT JOIN users u ON u.id = b.created_by
		   LEFT JOIN channel_backup_restores br ON br.backup_id = b.id
		  WHERE b.created_by = $1 OR EXISTS (
		        SELECT 1 FROM channels c
		        LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $1
		         WHERE c.id = b.source_channel_id AND (c.owner_id = $1 OR cm.user_id IS NOT NULL)
		  )
		  GROUP BY b.id, u.username
		  ORDER BY b.created_at DESC`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	backups := make([]model.ChannelBackup, 0)
	for rows.Next() {
		backup, err := scanChannelBackup(rows)
		if err != nil {
			return nil, err
		}
		backups = append(backups, *backup)
	}
	return backups, rows.Err()
}

func (r *ChannelRepo) GetBackup(id int64) (*model.ChannelBackup, error) {
	return scanChannelBackup(r.db.QueryRow(
		`SELECT b.id, b.source_channel_id, b.source_channel_name, b.created_by,
		        COALESCE(u.username, ''), b.filename, b.attachment_id, b.message_count, b.size,
		        b.checksum, b.snapshot_version, b.verified_at,
		        COUNT(br.id), MAX(br.created_at), b.created_at
		   FROM channel_backups b
		   LEFT JOIN users u ON u.id = b.created_by
		   LEFT JOIN channel_backup_restores br ON br.backup_id = b.id
		  WHERE b.id = $1
		  GROUP BY b.id, u.username`, id,
	))
}

func (r *ChannelRepo) DeleteBackup(id int64) (int64, error) {
	var attachmentID int64
	err := r.db.QueryRow(`DELETE FROM channel_backups WHERE id = $1 RETURNING attachment_id`, id).Scan(&attachmentID)
	return attachmentID, err
}

func (r *ChannelRepo) CreateBackupRestore(restore *model.ChannelBackupRestore) error {
	return r.db.QueryRow(
		`INSERT INTO channel_backup_restores (backup_id, target_channel_id, restored_by, message_count, created_at)
		 VALUES ($1,$2,$3,$4,NOW()) RETURNING id, created_at`,
		restore.BackupID, restore.TargetChannelID, restore.RestoredBy, restore.MessageCount,
	).Scan(&restore.ID, &restore.CreatedAt)
}

func (r *ChannelRepo) MarkBackupVerified(backupID int64, checksum string, version int) error {
	_, err := r.db.Exec(
		`UPDATE channel_backups
		 SET checksum = CASE WHEN checksum = '' THEN $1 ELSE checksum END,
		     snapshot_version = $2, verified_at = NOW()
		 WHERE id = $3`, checksum, version, backupID,
	)
	return err
}

func (r *ChannelRepo) ListBackupRestores(backupID int64) ([]model.ChannelBackupRestore, error) {
	rows, err := r.db.Query(
		`SELECT br.id, br.backup_id, br.target_channel_id, COALESCE(c.name, ''), br.restored_by,
		        COALESCE(u.username, ''), br.message_count, br.created_at
		   FROM channel_backup_restores br
		   LEFT JOIN channels c ON c.id = br.target_channel_id
		   LEFT JOIN users u ON u.id = br.restored_by
		  WHERE br.backup_id = $1 ORDER BY br.created_at DESC`, backupID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	restores := make([]model.ChannelBackupRestore, 0)
	for rows.Next() {
		var restore model.ChannelBackupRestore
		var targetID, restoredBy sql.NullInt64
		if err := rows.Scan(&restore.ID, &restore.BackupID, &targetID, &restore.TargetName, &restoredBy,
			&restore.RestoredByName, &restore.MessageCount, &restore.CreatedAt); err != nil {
			return nil, err
		}
		if targetID.Valid {
			restore.TargetChannelID = &targetID.Int64
		}
		if restoredBy.Valid {
			restore.RestoredBy = &restoredBy.Int64
		}
		restores = append(restores, restore)
	}
	return restores, rows.Err()
}

func (r *ChannelRepo) RestoreMessage(message *model.ChannelMessage) error {
	return restoreChannelMessage(r.db, message)
}

type channelMessageQueryer interface {
	QueryRow(query string, args ...any) *sql.Row
}

func restoreChannelMessage(queryer channelMessageQueryer, message *model.ChannelMessage) error {
	return queryer.QueryRow(
		`INSERT INTO channel_messages (
		     channel_id, sender_id, content, attachment_id, linked_workbook_id, linked_sheet_id,
		     linked_summary_id, reply_to_message_id, sender_type, assistant_id,
		     external_source, external_sender_name, external_sender_address, external_sender_avatar,
		     reply_external_message_id, reply_snapshot_sender, reply_snapshot_content,
		     forwarded_from_message_id, recalled_at, edited_at, created_at
		 ) VALUES (
		     $1, (SELECT id FROM users WHERE id = NULLIF($2,0)), $3,
		     (SELECT id FROM attachments WHERE id = $4),
		     (SELECT id FROM workbooks WHERE id = $5),
		     (SELECT id FROM sheets WHERE id = $6),
		     (SELECT id FROM ai_summary_pages WHERE id = $7), $8,
		     CASE WHEN $9 IN ('user','ai','whatsapp') THEN $9 ELSE 'user' END,
		     (SELECT id FROM ai_assistants WHERE id = $10), $11, $12, $13, $14, $15, $16, $17,
		     $18, $19, $20, $21
		 ) RETURNING id, created_at`,
		message.ChannelID, message.SenderID, message.Content, message.AttachmentID,
		message.LinkedWorkbookID, message.LinkedSheetID, message.LinkedSummaryID, message.ReplyToMessageID,
		message.SenderType, message.AssistantID, message.ExternalSource, message.ExternalSenderName,
		message.ExternalSenderAddress, message.ExternalSenderAvatar, message.ReplyExternalMessageID,
		message.ReplySnapshotSender, message.ReplySnapshotContent, message.ForwardedFromMessageID,
		message.RecalledAt, message.EditedAt, message.CreatedAt,
	).Scan(&message.ID, &message.CreatedAt)
}

func (r *ChannelRepo) RestoreBackupSnapshot(items []model.ChannelRestoreMessage, restore *model.ChannelBackupRestore) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	messageMap := make(map[int64]int64, len(items))
	for index := range items {
		items[index].Message.ReplyToMessageID = nil
		items[index].Message.ForwardedFromMessageID = nil
		if err := restoreChannelMessage(tx, &items[index].Message); err != nil {
			return fmt.Errorf("restore message %d: %w", index+1, err)
		}
		if strings.TrimSpace(items[index].Message.TranslatedContent) != "" {
			language := strings.TrimSpace(items[index].Message.TranslationLanguage)
			if language == "" {
				language = "zh-CN"
			}
			translatedAt := items[index].Message.TranslatedAt
			if translatedAt == nil {
				translatedAt = &items[index].Message.CreatedAt
			}
			if _, err := tx.Exec(
				`INSERT INTO channel_message_translations
				 (message_id, target_language, source_content, translated_content, created_at, updated_at)
				 VALUES ($1,$2,$3,$4,$5,$5)
				 ON CONFLICT (message_id, target_language) DO UPDATE SET
				 source_content = EXCLUDED.source_content, translated_content = EXCLUDED.translated_content,
				 updated_at = EXCLUDED.updated_at`,
				items[index].Message.ID, language, items[index].Message.Content,
				items[index].Message.TranslatedContent, translatedAt,
			); err != nil {
				return fmt.Errorf("restore message translation %d: %w", index+1, err)
			}
		}
		messageMap[items[index].OriginalID] = items[index].Message.ID
	}
	for index := range items {
		var replyID, forwardedID *int64
		if original := items[index].OriginalReplyToMessageID; original != nil {
			if restored, exists := messageMap[*original]; exists {
				replyID = &restored
			}
		}
		if original := items[index].OriginalForwardedMessageID; original != nil {
			if restored, exists := messageMap[*original]; exists {
				forwardedID = &restored
			}
		}
		if replyID == nil && forwardedID == nil {
			continue
		}
		if _, err := tx.Exec(
			`UPDATE channel_messages SET reply_to_message_id = $1, forwarded_from_message_id = $2 WHERE id = $3`,
			replyID, forwardedID, items[index].Message.ID,
		); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(`UPDATE channels SET updated_at = NOW() WHERE id = $1`, restore.TargetChannelID); err != nil {
		return err
	}
	if err := tx.QueryRow(
		`INSERT INTO channel_backup_restores (backup_id, target_channel_id, restored_by, message_count, created_at)
		 VALUES ($1,$2,$3,$4,NOW()) RETURNING id, created_at`,
		restore.BackupID, restore.TargetChannelID, restore.RestoredBy, restore.MessageCount,
	).Scan(&restore.ID, &restore.CreatedAt); err != nil {
		return err
	}
	return tx.Commit()
}

func scanChannelBackup(scanner interface{ Scan(...any) error }) (*model.ChannelBackup, error) {
	var backup model.ChannelBackup
	var sourceID, createdBy sql.NullInt64
	var lastRestored, verifiedAt sql.NullTime
	if err := scanner.Scan(
		&backup.ID, &sourceID, &backup.SourceChannelName, &createdBy, &backup.CreatedByName,
		&backup.Filename, &backup.AttachmentID, &backup.MessageCount, &backup.Size,
		&backup.Checksum, &backup.SnapshotVersion, &verifiedAt,
		&backup.RestoreCount, &lastRestored, &backup.CreatedAt,
	); err != nil {
		return nil, fmt.Errorf("scan channel backup: %w", err)
	}
	if sourceID.Valid {
		backup.SourceChannelID = &sourceID.Int64
	}
	if createdBy.Valid {
		backup.CreatedBy = &createdBy.Int64
	}
	if lastRestored.Valid {
		backup.LastRestoredAt = &lastRestored.Time
	}
	if verifiedAt.Valid {
		backup.VerifiedAt = &verifiedAt.Time
	}
	return &backup, nil
}
