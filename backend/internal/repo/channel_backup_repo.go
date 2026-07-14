package repo

import (
	"database/sql"
	"fmt"

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
		     source_channel_id, source_channel_name, created_by, filename, attachment_id, message_count, size, created_at
		 ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW()) RETURNING id, created_at`,
		backup.SourceChannelID, backup.SourceChannelName, backup.CreatedBy, backup.Filename,
		backup.AttachmentID, backup.MessageCount, backup.Size,
	).Scan(&backup.ID, &backup.CreatedAt)
}

func (r *ChannelRepo) ListBackups(userID int64, includeAll bool) ([]model.ChannelBackup, error) {
	rows, err := r.db.Query(
		`SELECT b.id, b.source_channel_id, b.source_channel_name, b.created_by,
		        COALESCE(u.username, ''), b.filename, b.attachment_id, b.message_count, b.size,
		        COUNT(br.id), MAX(br.created_at), b.created_at
		   FROM channel_backups b
		   LEFT JOIN users u ON u.id = b.created_by
		   LEFT JOIN channel_backup_restores br ON br.backup_id = b.id
		  WHERE $1 OR b.created_by = $2 OR EXISTS (
		        SELECT 1 FROM channels c
		         WHERE c.id = b.source_channel_id AND c.owner_id = $2
		  )
		  GROUP BY b.id, u.username
		  ORDER BY b.created_at DESC`, includeAll, userID,
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
	return r.db.QueryRow(
		`INSERT INTO channel_messages (
		     channel_id, sender_id, content, attachment_id, linked_workbook_id, linked_sheet_id,
		     linked_summary_id, reply_to_message_id, sender_type, assistant_id,
		     external_source, external_sender_name, external_sender_address, external_sender_avatar,
		     reply_external_message_id, reply_snapshot_sender, reply_snapshot_content,
		     recalled_at, edited_at, created_at
		 ) VALUES (
		     $1, (SELECT id FROM users WHERE id = NULLIF($2,0)), $3,
		     (SELECT id FROM attachments WHERE id = $4),
		     (SELECT id FROM workbooks WHERE id = $5),
		     (SELECT id FROM sheets WHERE id = $6),
		     (SELECT id FROM ai_summary_pages WHERE id = $7), $8,
		     CASE WHEN $9 IN ('user','ai','whatsapp') THEN $9 ELSE 'user' END,
		     (SELECT id FROM ai_assistants WHERE id = $10), $11, $12, $13, $14, $15, $16, $17,
		     $18, $19, $20
		 ) RETURNING id, created_at`,
		message.ChannelID, message.SenderID, message.Content, message.AttachmentID,
		message.LinkedWorkbookID, message.LinkedSheetID, message.LinkedSummaryID, message.ReplyToMessageID,
		message.SenderType, message.AssistantID, message.ExternalSource, message.ExternalSenderName,
		message.ExternalSenderAddress, message.ExternalSenderAvatar, message.ReplyExternalMessageID,
		message.ReplySnapshotSender, message.ReplySnapshotContent, message.RecalledAt, message.EditedAt, message.CreatedAt,
	).Scan(&message.ID, &message.CreatedAt)
}

func scanChannelBackup(scanner interface{ Scan(...any) error }) (*model.ChannelBackup, error) {
	var backup model.ChannelBackup
	var sourceID, createdBy sql.NullInt64
	var lastRestored sql.NullTime
	if err := scanner.Scan(
		&backup.ID, &sourceID, &backup.SourceChannelName, &createdBy, &backup.CreatedByName,
		&backup.Filename, &backup.AttachmentID, &backup.MessageCount, &backup.Size,
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
	return &backup, nil
}
