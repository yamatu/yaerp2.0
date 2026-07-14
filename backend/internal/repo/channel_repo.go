package repo

import (
	"database/sql"
	"fmt"
	"strings"

	"yaerp/internal/model"
)

type ChannelRepo struct {
	db *sql.DB
}

func NewChannelRepo(db *sql.DB) *ChannelRepo {
	return &ChannelRepo{db: db}
}

func (r *ChannelRepo) CreateChannel(channel *model.Channel) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := tx.QueryRow(
		`INSERT INTO channels (name, description, owner_id, channel_type, ai_assistant_id, created_at, updated_at)
		 VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'group'), $5, NOW(), NOW())
		 RETURNING id, created_at, updated_at`,
		channel.Name, channel.Description, channel.OwnerID, channel.ChannelType, channel.AIAssistantID,
	).Scan(&channel.ID, &channel.CreatedAt, &channel.UpdatedAt); err != nil {
		return err
	}

	if _, err := tx.Exec(
		`INSERT INTO channel_members (channel_id, user_id, role, is_pinned, created_by, created_at)
		 VALUES ($1, $2, 'owner', FALSE, $2, NOW())
		 ON CONFLICT (channel_id, user_id) DO UPDATE SET role = 'owner'`,
		channel.ID, channel.OwnerID,
	); err != nil {
		return err
	}
	if channel.AIAssistantID != nil {
		if _, err := tx.Exec(
			`INSERT INTO channel_ai_members (channel_id, assistant_id, added_by)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (channel_id, assistant_id) DO NOTHING`,
			channel.ID, *channel.AIAssistantID, channel.OwnerID,
		); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`INSERT INTO channel_read_states (channel_id, user_id, last_read_at, updated_at)
		 VALUES ($1, $2, NOW(), NOW())
		 ON CONFLICT (channel_id, user_id) DO UPDATE SET last_read_at = NOW(), updated_at = NOW()`,
		channel.ID, channel.OwnerID,
	); err != nil {
		return err
	}

	return tx.Commit()
}

func (r *ChannelRepo) ListChannels(userID int64, includeAll bool) ([]model.Channel, error) {
	rows, err := r.db.Query(
		`SELECT c.id, c.name, c.description, c.owner_id, COALESCE(u.username, ''), c.avatar_attachment_id,
		        c.channel_type, c.ai_assistant_id, COALESCE(primary_ai.name, ''),
		        (SELECT COUNT(*)::INT FROM channel_ai_members cam WHERE cam.channel_id = c.id),
		        (SELECT COUNT(*)::INT FROM channel_members cm WHERE cm.channel_id = c.id),
		        COALESCE(cm_self.is_pinned, FALSE),
		        COALESCE(cm_self.pin_sort_order, 0),
		        CASE WHEN c.owner_id = $1 OR cm_self.user_id IS NOT NULL THEN (
		            SELECT COUNT(*)::INT
		              FROM channel_messages unread
		             WHERE unread.channel_id = c.id
		               AND unread.created_at > COALESCE(crs.last_read_at, 'epoch'::timestamptz)
			               AND (unread.sender_type = 'ai' OR unread.sender_id IS DISTINCT FROM $1)
		        ) ELSE 0 END,
		        latest.id, latest.sender_id, latest.created_at,
		        c.created_at, c.updated_at
		   FROM channels c
		   LEFT JOIN users u ON u.id = c.owner_id
		   LEFT JOIN ai_assistants primary_ai ON primary_ai.id = c.ai_assistant_id
		   LEFT JOIN channel_members cm_self ON cm_self.channel_id = c.id AND cm_self.user_id = $1
		   LEFT JOIN channel_read_states crs ON crs.channel_id = c.id AND crs.user_id = $1
		   LEFT JOIN LATERAL (
			       SELECT m.id, CASE WHEN m.sender_type = 'ai' THEN NULL ELSE m.sender_id END AS sender_id, m.created_at
		         FROM channel_messages m
		        WHERE m.channel_id = c.id
		        ORDER BY m.created_at DESC, m.id DESC
		        LIMIT 1
		   ) latest ON TRUE
		  WHERE (c.channel_type = 'ai_private' AND c.owner_id = $1)
		     OR (c.channel_type <> 'ai_private' AND ($2 OR c.owner_id = $1 OR cm_self.user_id IS NOT NULL))
		  ORDER BY COALESCE(cm_self.is_pinned, FALSE) DESC,
		           CASE WHEN COALESCE(cm_self.is_pinned, FALSE) THEN COALESCE(cm_self.pin_sort_order, 0) ELSE 0 END,
		           c.updated_at DESC, c.id DESC`,
		userID, includeAll,
	)
	if err != nil {
		return nil, fmt.Errorf("list channels: %w", err)
	}
	defer rows.Close()

	channels := make([]model.Channel, 0)
	for rows.Next() {
		channel, err := scanChannel(rows)
		if err != nil {
			return nil, err
		}
		channels = append(channels, *channel)
	}
	return channels, rows.Err()
}

func (r *ChannelRepo) GetChannel(id, userID int64) (*model.Channel, error) {
	row := r.db.QueryRow(
		`SELECT c.id, c.name, c.description, c.owner_id, COALESCE(u.username, ''), c.avatar_attachment_id,
		        c.channel_type, c.ai_assistant_id, COALESCE(primary_ai.name, ''),
		        (SELECT COUNT(*)::INT FROM channel_ai_members cam WHERE cam.channel_id = c.id),
		        (SELECT COUNT(*)::INT FROM channel_members cm WHERE cm.channel_id = c.id),
		        COALESCE((SELECT cm.is_pinned FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2), FALSE),
		        COALESCE((SELECT cm.pin_sort_order FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2), 0),
		        CASE WHEN c.owner_id = $2 OR EXISTS (
		            SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = $2
		        ) THEN (
		            SELECT COUNT(*)::INT
		              FROM channel_messages unread
		             WHERE unread.channel_id = c.id
		               AND unread.created_at > COALESCE((
		                   SELECT crs.last_read_at FROM channel_read_states crs
		                    WHERE crs.channel_id = c.id AND crs.user_id = $2
		               ), 'epoch'::timestamptz)
			               AND (unread.sender_type = 'ai' OR unread.sender_id IS DISTINCT FROM $2)
		        ) ELSE 0 END,
		        latest.id, latest.sender_id, latest.created_at,
		        c.created_at, c.updated_at
		   FROM channels c
		   LEFT JOIN users u ON u.id = c.owner_id
		   LEFT JOIN ai_assistants primary_ai ON primary_ai.id = c.ai_assistant_id
		   LEFT JOIN LATERAL (
			       SELECT m.id, CASE WHEN m.sender_type = 'ai' THEN NULL ELSE m.sender_id END AS sender_id, m.created_at
		         FROM channel_messages m
		        WHERE m.channel_id = c.id
		        ORDER BY m.created_at DESC, m.id DESC
		        LIMIT 1
		   ) latest ON TRUE
		  WHERE c.id = $1`,
		id, userID,
	)
	return scanChannel(row)
}

func (r *ChannelRepo) IsChannelMember(channelID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
			SELECT 1 FROM channels c
			LEFT JOIN channel_members cm ON cm.channel_id = c.id AND cm.user_id = $2
				WHERE c.id = $1 AND (
				    (c.channel_type = 'ai_private' AND c.owner_id = $2)
				    OR (c.channel_type <> 'ai_private' AND (c.owner_id = $2 OR cm.user_id IS NOT NULL OR EXISTS (
				        SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
				         WHERE ur.user_id = $2 AND r.code = 'admin'
				    )))
				)
		)`,
		channelID, userID,
	).Scan(&allowed)
	return allowed, err
}

func (r *ChannelRepo) UpdateChannel(channelID int64, name string, description *string) error {
	result, err := r.db.Exec(
		`UPDATE channels SET name = $1, description = $2, updated_at = NOW() WHERE id = $3`,
		name, description, channelID,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *ChannelRepo) UpdateChannelAvatar(channelID int64, attachmentID *int64) error {
	result, err := r.db.Exec(
		`UPDATE channels SET avatar_attachment_id = $1, updated_at = NOW() WHERE id = $2`,
		attachmentID, channelID,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *ChannelRepo) DeleteChannel(channelID int64) error {
	result, err := r.db.Exec(`DELETE FROM channels WHERE id = $1`, channelID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *ChannelRepo) ListChannelMembers(channelID int64) ([]model.ChannelMember, error) {
	rows, err := r.db.Query(
		`SELECT cm.channel_id, cm.user_id, COALESCE(u.username, ''), COALESCE(u.email, ''), u.avatar, cm.role, cm.created_at
		   FROM channel_members cm
		   JOIN users u ON u.id = cm.user_id
		  WHERE cm.channel_id = $1
		  ORDER BY CASE cm.role WHEN 'owner' THEN 0 ELSE 1 END, u.username, u.id`,
		channelID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	members := make([]model.ChannelMember, 0)
	for rows.Next() {
		var member model.ChannelMember
		var avatar sql.NullString
		if err := rows.Scan(
			&member.ChannelID, &member.UserID, &member.Username, &member.Email,
			&avatar, &member.Role, &member.CreatedAt,
		); err != nil {
			return nil, err
		}
		if avatar.Valid {
			member.Avatar = &avatar.String
		}
		members = append(members, member)
	}
	return members, rows.Err()
}

func (r *ChannelRepo) AddChannelMembers(channelID, createdBy int64, userIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	for _, userID := range userIDs {
		if _, err := tx.Exec(
			`INSERT INTO channel_members (channel_id, user_id, role, is_pinned, created_by, created_at)
			 VALUES ($1, $2, 'member', FALSE, $3, NOW())
			 ON CONFLICT (channel_id, user_id) DO NOTHING`,
			channelID, userID, createdBy,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO channel_read_states (channel_id, user_id, last_read_at, updated_at)
			 VALUES ($1, $2, NOW(), NOW())
			 ON CONFLICT (channel_id, user_id) DO NOTHING`,
			channelID, userID,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *ChannelRepo) RemoveChannelMember(channelID, userID int64) error {
	_, err := r.db.Exec(
		`DELETE FROM channel_members WHERE channel_id = $1 AND user_id = $2 AND role <> 'owner'`,
		channelID, userID,
	)
	return err
}

func (r *ChannelRepo) ListChannelAIMembers(channelID int64) ([]model.ChannelAIMember, error) {
	rows, err := r.db.Query(
		`SELECT cam.channel_id, a.id, a.name, a.description, a.model, a.is_default, a.enabled, a.supports_vision, a.supports_files, cam.created_at
		   FROM channel_ai_members cam
		   JOIN ai_assistants a ON a.id = cam.assistant_id
		  WHERE cam.channel_id = $1
		  ORDER BY a.is_default DESC, a.name, a.id`,
		channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("list channel AI members: %w", err)
	}
	defer rows.Close()
	items := make([]model.ChannelAIMember, 0)
	for rows.Next() {
		var item model.ChannelAIMember
		if err := rows.Scan(&item.ChannelID, &item.AssistantID, &item.Name, &item.Description, &item.Model, &item.IsDefault, &item.Enabled, &item.SupportsVision, &item.SupportsFiles, &item.CreatedAt); err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (r *ChannelRepo) SetChannelAIMembers(channelID, addedBy int64, assistantIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM channel_ai_members WHERE channel_id = $1`, channelID); err != nil {
		return err
	}
	for _, assistantID := range assistantIDs {
		if _, err := tx.Exec(
			`INSERT INTO channel_ai_members (channel_id, assistant_id, added_by)
			 VALUES ($1, $2, $3)`, channelID, assistantID, addedBy,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *ChannelRepo) HasChannelAIMember(channelID, assistantID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
			SELECT 1 FROM channel_ai_members cam
			JOIN ai_assistants a ON a.id = cam.assistant_id
			WHERE cam.channel_id = $1 AND cam.assistant_id = $2 AND a.enabled = TRUE
		)`, channelID, assistantID,
	).Scan(&exists)
	return exists, err
}

func (r *ChannelRepo) FindAIPrivateChannel(ownerID, assistantID int64) (*model.Channel, error) {
	var channelID int64
	err := r.db.QueryRow(
		`SELECT id FROM channels
		  WHERE owner_id = $1 AND ai_assistant_id = $2 AND channel_type = 'ai_private'
		  LIMIT 1`, ownerID, assistantID,
	).Scan(&channelID)
	if err != nil {
		return nil, err
	}
	return r.GetChannel(channelID, ownerID)
}

func (r *ChannelRepo) SetChannelPinned(channelID, userID int64, pinned bool) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(
		`INSERT INTO channel_members (channel_id, user_id, role, is_pinned, pin_sort_order, created_by, created_at)
		 VALUES ($1, $2, 'member', $3,
		         CASE WHEN $3 THEN COALESCE((SELECT MAX(pin_sort_order) + 1 FROM channel_members WHERE user_id = $2 AND is_pinned), 1) ELSE 0 END,
		         $2, NOW())
		 ON CONFLICT (channel_id, user_id) DO UPDATE
		 SET is_pinned = EXCLUDED.is_pinned,
		     pin_sort_order = CASE
		         WHEN EXCLUDED.is_pinned AND channel_members.is_pinned = FALSE
		         THEN COALESCE((SELECT MAX(cm.pin_sort_order) + 1 FROM channel_members cm WHERE cm.user_id = $2 AND cm.is_pinned), 1)
		         WHEN EXCLUDED.is_pinned THEN channel_members.pin_sort_order
		         ELSE 0
		     END`,
		channelID, userID, pinned,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO channel_read_states (channel_id, user_id, last_read_at, updated_at)
		 VALUES ($1, $2, NOW(), NOW())
		 ON CONFLICT (channel_id, user_id) DO NOTHING`,
		channelID, userID,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *ChannelRepo) ReorderPinnedChannels(userID int64, channelIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var pinnedCount int
	if err := tx.QueryRow(
		`SELECT COUNT(*)::INT FROM channel_members WHERE user_id = $1 AND is_pinned`,
		userID,
	).Scan(&pinnedCount); err != nil {
		return err
	}
	if pinnedCount != len(channelIDs) {
		return fmt.Errorf("置顶频道列表已变化，请刷新后重试")
	}

	seen := make(map[int64]struct{}, len(channelIDs))
	for index, channelID := range channelIDs {
		if channelID <= 0 {
			return fmt.Errorf("无效的频道顺序")
		}
		if _, exists := seen[channelID]; exists {
			return fmt.Errorf("频道顺序中存在重复项")
		}
		seen[channelID] = struct{}{}
		result, err := tx.Exec(
			`UPDATE channel_members
			    SET pin_sort_order = $1
			  WHERE user_id = $2 AND channel_id = $3 AND is_pinned`,
			index+1, userID, channelID,
		)
		if err != nil {
			return err
		}
		rows, _ := result.RowsAffected()
		if rows != 1 {
			return fmt.Errorf("频道顺序中包含未置顶频道")
		}
	}
	return tx.Commit()
}

func (r *ChannelRepo) MarkChannelRead(channelID, userID int64) error {
	_, err := r.db.Exec(
		`INSERT INTO channel_read_states (channel_id, user_id, last_read_at, updated_at)
		 VALUES ($1, $2, NOW(), NOW())
		 ON CONFLICT (channel_id, user_id)
		 DO UPDATE SET last_read_at = EXCLUDED.last_read_at, updated_at = NOW()`,
		channelID, userID,
	)
	return err
}

func (r *ChannelRepo) CreateMessage(message *model.ChannelMessage) error {
	return r.db.QueryRow(
		`INSERT INTO channel_messages (
		     channel_id, sender_id, content, attachment_id, linked_workbook_id, linked_sheet_id,
		     linked_summary_id, forwarded_from_message_id, reply_to_message_id, sender_type, assistant_id, created_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE(NULLIF($10, ''), 'user'), $11, NOW())
		 RETURNING id, created_at`,
		message.ChannelID, message.SenderID, message.Content, message.AttachmentID,
		message.LinkedWorkbookID, message.LinkedSheetID, message.LinkedSummaryID, message.ForwardedFromMessageID, message.ReplyToMessageID,
		message.SenderType, message.AssistantID,
	).Scan(&message.ID, &message.CreatedAt)
}

func (r *ChannelRepo) RecallMessage(messageID, userID int64) error {
	result, err := r.db.Exec(
		`UPDATE channel_messages
		    SET recalled_at = NOW(), recalled_by = $1
			  WHERE id = $2 AND sender_id = $1 AND sender_type = 'user' AND recalled_at IS NULL`,
		userID, messageID,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *ChannelRepo) GetMessage(id int64) (*model.ChannelMessage, error) {
	row := r.db.QueryRow(channelMessageSelectSQL()+` WHERE m.id = $1`, id)
	return scanChannelMessage(row)
}

func (r *ChannelRepo) ListMessages(channelID int64, page, size int) ([]model.ChannelMessage, int64, error) {
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM channel_messages WHERE channel_id = $1`, channelID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count channel messages: %w", err)
	}

	end := int(total) - (page-1)*size
	if end < 0 {
		end = 0
	}
	offset := end - size
	if offset < 0 {
		offset = 0
	}
	limit := end - offset
	rows, err := r.db.Query(
		channelMessageSelectSQL()+` WHERE m.channel_id = $1 ORDER BY m.created_at ASC, m.id ASC LIMIT $2 OFFSET $3`,
		channelID, limit, offset,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("list channel messages: %w", err)
	}
	defer rows.Close()

	messages := make([]model.ChannelMessage, 0)
	for rows.Next() {
		message, err := scanChannelMessage(rows)
		if err != nil {
			return nil, 0, err
		}
		messages = append(messages, *message)
	}
	return messages, total, rows.Err()
}

func (r *ChannelRepo) SearchMessages(userID int64, includeAll bool, filter model.ChannelMessageSearchFilter) ([]model.ChannelMessageSearchResult, int64, error) {
	where := []string{`m.recalled_at IS NULL`, `(
		(c.channel_type = 'ai_private' AND c.owner_id = $2)
		OR (c.channel_type <> 'ai_private' AND ($1 OR c.owner_id = $2 OR EXISTS (
			SELECT 1 FROM channel_members cm
			WHERE cm.channel_id = c.id AND cm.user_id = $2
		)))
	)`}
	args := []any{includeAll, userID}
	addCondition := func(condition string, value any) {
		args = append(args, value)
		where = append(where, fmt.Sprintf(condition, len(args)))
	}

	if filter.ChannelID != nil {
		addCondition(`c.id = $%d`, *filter.ChannelID)
	}
	if filter.SenderID != nil {
		addCondition(`m.sender_id = $%d`, *filter.SenderID)
	}
	if filter.From != nil {
		addCondition(`m.created_at >= $%d`, *filter.From)
	}
	if filter.To != nil {
		addCondition(`m.created_at <= $%d`, *filter.To)
	}

	searchable := `(COALESCE(m.content, '') || ' ' || COALESCE(a.filename, '') || ' ' ||
		COALESCE(w.name, '') || ' ' || COALESCE(s.name, '') || ' ' || COALESCE(asp.title, ''))`
	if filter.Keyword != "" {
		switch filter.MatchMode {
		case "exact":
			args = append(args, filter.Keyword)
			placeholder := len(args)
			where = append(where, fmt.Sprintf(
				`(BTRIM(COALESCE(m.content, '')) = $%d OR COALESCE(a.filename, '') = $%d OR COALESCE(w.name, '') = $%d OR COALESCE(s.name, '') = $%d OR COALESCE(asp.title, '') = $%d)`,
				placeholder, placeholder, placeholder, placeholder, placeholder,
			))
		case "regex":
			addCondition(searchable+` ~ $%d`, filter.Keyword)
		default:
			addCondition(searchable+` ILIKE '%%' || $%d || '%%'`, filter.Keyword)
		}
	}

	switch filter.MessageType {
	case "image":
		where = append(where, `COALESCE(a.mime_type, '') LIKE 'image/%'`)
	case "text":
		where = append(where, `BTRIM(COALESCE(m.content, '')) <> ''`)
	}

	fromSQL := channelMessageSearchFromSQL()
	whereSQL := ` WHERE ` + strings.Join(where, ` AND `)
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) `+fromSQL+whereSQL, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count searched channel messages: %w", err)
	}

	offset := (filter.Page - 1) * filter.Size
	queryArgs := append(append([]any{}, args...), filter.Size, offset)
	rows, err := r.db.Query(
		`SELECT c.name, `+channelMessageColumnsSQL()+` `+fromSQL+whereSQL+
			fmt.Sprintf(` ORDER BY m.created_at DESC, m.id DESC LIMIT $%d OFFSET $%d`, len(queryArgs)-1, len(queryArgs)),
		queryArgs...,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("search channel messages: %w", err)
	}
	defer rows.Close()

	results := make([]model.ChannelMessageSearchResult, 0)
	for rows.Next() {
		result, err := scanChannelMessageSearchResult(rows)
		if err != nil {
			return nil, 0, err
		}
		results = append(results, *result)
	}
	return results, total, rows.Err()
}

func (r *ChannelRepo) TouchChannel(channelID int64) error {
	_, err := r.db.Exec(`UPDATE channels SET updated_at = NOW() WHERE id = $1`, channelID)
	return err
}

func (r *ChannelRepo) CreateGalleryDirectory(directory *model.GalleryDirectory) error {
	return r.db.QueryRow(
		`INSERT INTO gallery_directories (name, owner_id, channel_id, visibility, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, NOW(), NOW())
		 RETURNING id, created_at, updated_at`,
		directory.Name, directory.OwnerID, directory.ChannelID, directory.Visibility,
	).Scan(&directory.ID, &directory.CreatedAt, &directory.UpdatedAt)
}

func (r *ChannelRepo) DeleteGalleryDirectory(directoryID int64) error {
	result, err := r.db.Exec(`DELETE FROM gallery_directories WHERE id = $1`, directoryID)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *ChannelRepo) ListGalleryDirectories(userID int64, channelID *int64) ([]model.GalleryDirectory, error) {
	query := `SELECT gd.id, gd.name, gd.owner_id, COALESCE(u.username, ''), gd.channel_id, gd.visibility,
	                  (gd.owner_id = $1 OR EXISTS (
	                      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
	                       WHERE ur.user_id = $1 AND r.code = 'admin'
	                  )) AS can_manage,
	                  (gd.owner_id = $1 OR EXISTS (
	                      SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
	                       WHERE ur.user_id = $1 AND r.code = 'admin'
	                  ) OR EXISTS (
	                      SELECT 1 FROM gallery_directory_permissions gdp
	                       WHERE gdp.directory_id = gd.id AND gdp.user_id = $1 AND gdp.can_edit
	                  ) OR (gd.visibility = 'channel' AND EXISTS (
	                      SELECT 1 FROM channel_members cm
	                       WHERE cm.channel_id = gd.channel_id AND cm.user_id = $1
	                  ))) AS can_edit,
	                  gd.created_at, gd.updated_at
	            FROM gallery_directories gd
	            LEFT JOIN users u ON u.id = gd.owner_id
	           WHERE (gd.owner_id = $1
	              OR gd.visibility = 'public'
	              OR EXISTS (
	                  SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
	                   WHERE ur.user_id = $1 AND r.code = 'admin'
	              )
	              OR EXISTS (
	                  SELECT 1 FROM gallery_directory_permissions gdp
	                   WHERE gdp.directory_id = gd.id AND gdp.user_id = $1 AND (gdp.can_view OR gdp.can_edit)
	              )
	              OR (gd.visibility = 'channel' AND EXISTS (
	                  SELECT 1 FROM channel_members cm
	                   WHERE cm.channel_id = gd.channel_id AND cm.user_id = $1
	              )))`
	args := []any{userID}
	if channelID != nil {
		query += ` AND gd.channel_id = $2`
		args = append(args, *channelID)
	}
	query += ` ORDER BY gd.channel_id NULLS FIRST, gd.updated_at DESC, gd.id DESC`

	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("list gallery directories: %w", err)
	}
	defer rows.Close()

	list := make([]model.GalleryDirectory, 0)
	for rows.Next() {
		directory, err := scanGalleryDirectory(rows)
		if err != nil {
			return nil, err
		}
		list = append(list, *directory)
	}
	return list, rows.Err()
}

func (r *ChannelRepo) GetGalleryDirectory(id int64) (*model.GalleryDirectory, error) {
	row := r.db.QueryRow(
		`SELECT gd.id, gd.name, gd.owner_id, COALESCE(u.username, ''), gd.channel_id, gd.visibility,
		        FALSE, FALSE, gd.created_at, gd.updated_at
		   FROM gallery_directories gd
		   LEFT JOIN users u ON u.id = gd.owner_id
		  WHERE gd.id = $1`,
		id,
	)
	return scanGalleryDirectory(row)
}

func (r *ChannelRepo) CanViewGalleryDirectory(directoryID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
		    SELECT 1 FROM gallery_directories gd
		     WHERE gd.id = $1 AND (
		         gd.owner_id = $2 OR gd.visibility = 'public'
		         OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $2 AND r.code = 'admin')
		         OR EXISTS (SELECT 1 FROM gallery_directory_permissions gdp WHERE gdp.directory_id = gd.id AND gdp.user_id = $2 AND (gdp.can_view OR gdp.can_edit))
		         OR (gd.visibility = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = gd.channel_id AND cm.user_id = $2))
		     )
		)`, directoryID, userID,
	).Scan(&allowed)
	return allowed, err
}

func (r *ChannelRepo) CanEditGalleryDirectory(directoryID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
		    SELECT 1 FROM gallery_directories gd
		     WHERE gd.id = $1 AND (
		         gd.owner_id = $2
		         OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $2 AND r.code = 'admin')
		         OR EXISTS (SELECT 1 FROM gallery_directory_permissions gdp WHERE gdp.directory_id = gd.id AND gdp.user_id = $2 AND gdp.can_edit)
		         OR (gd.visibility = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = gd.channel_id AND cm.user_id = $2))
		     )
		)`, directoryID, userID,
	).Scan(&allowed)
	return allowed, err
}

func (r *ChannelRepo) CanManageGalleryDirectory(directoryID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
		    SELECT 1 FROM gallery_directories gd
		     WHERE gd.id = $1 AND (
		         gd.owner_id = $2
		         OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $2 AND r.code = 'admin')
		     )
		)`, directoryID, userID,
	).Scan(&allowed)
	return allowed, err
}

func (r *ChannelRepo) GetGalleryDirectoryAccess(directoryID int64) (*model.GalleryDirectoryAccess, error) {
	access := &model.GalleryDirectoryAccess{DirectoryID: directoryID, ViewUserIDs: []int64{}, EditUserIDs: []int64{}}
	if err := r.db.QueryRow(`SELECT visibility FROM gallery_directories WHERE id = $1`, directoryID).Scan(&access.Visibility); err != nil {
		return nil, err
	}
	rows, err := r.db.Query(
		`SELECT user_id, can_view, can_edit
		   FROM gallery_directory_permissions
		  WHERE directory_id = $1
		  ORDER BY user_id`,
		directoryID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var userID int64
		var canView, canEdit bool
		if err := rows.Scan(&userID, &canView, &canEdit); err != nil {
			return nil, err
		}
		if canEdit {
			access.EditUserIDs = append(access.EditUserIDs, userID)
		} else if canView {
			access.ViewUserIDs = append(access.ViewUserIDs, userID)
		}
	}
	return access, rows.Err()
}

func (r *ChannelRepo) UpdateGalleryDirectoryAccess(directoryID int64, visibility string, viewUserIDs, editUserIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`UPDATE gallery_directories SET visibility = $1, updated_at = NOW() WHERE id = $2`, visibility, directoryID); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM gallery_directory_permissions WHERE directory_id = $1`, directoryID); err != nil {
		return err
	}
	permissions := make(map[int64]bool, len(viewUserIDs)+len(editUserIDs))
	for _, userID := range viewUserIDs {
		if userID > 0 {
			permissions[userID] = false
		}
	}
	for _, userID := range editUserIDs {
		if userID > 0 {
			permissions[userID] = true
		}
	}
	for userID, canEdit := range permissions {
		if _, err := tx.Exec(
			`INSERT INTO gallery_directory_permissions (directory_id, user_id, can_view, can_edit, created_at, updated_at)
			 VALUES ($1, $2, TRUE, $3, NOW(), NOW())`,
			directoryID, userID, canEdit,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (r *ChannelRepo) SaveGalleryImage(attachmentID int64, directoryID *int64, channelID *int64, savedBy int64) error {
	_, err := r.db.Exec(
		`INSERT INTO gallery_images (attachment_id, directory_id, channel_id, saved_by, created_at)
		 VALUES ($1, $2, $3, $4, NOW())
		 ON CONFLICT (attachment_id, directory_id, channel_id) DO NOTHING`,
		attachmentID, directoryID, channelID, savedBy,
	)
	return err
}

func (r *ChannelRepo) IsGalleryImage(attachmentID int64) (bool, error) {
	var exists bool
	err := r.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM gallery_images WHERE attachment_id = $1)`,
		attachmentID,
	).Scan(&exists)
	return exists, err
}

func (r *ChannelRepo) CanManageGalleryImage(attachmentID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
			SELECT 1
			  FROM attachments a
			 WHERE a.id = $1
			   AND (
			       a.uploader_id = $2
			       OR EXISTS (
			           SELECT 1
			             FROM gallery_images gi
			             LEFT JOIN gallery_directories gd ON gd.id = gi.directory_id
			             LEFT JOIN channels c ON c.id = COALESCE(gi.channel_id, gd.channel_id)
			            WHERE gi.attachment_id = a.id
			              AND (gi.saved_by = $2 OR gd.owner_id = $2 OR c.owner_id = $2
			                  OR EXISTS (SELECT 1 FROM gallery_directory_permissions gdp WHERE gdp.directory_id = gd.id AND gdp.user_id = $2 AND gdp.can_edit)
			                  OR (gd.visibility = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = gd.channel_id AND cm.user_id = $2)))
			       )
			   )
		)`,
		attachmentID, userID,
	).Scan(&allowed)
	return allowed, err
}

func (r *ChannelRepo) CanAccessGalleryImage(attachmentID, userID int64) (bool, error) {
	var allowed bool
	err := r.db.QueryRow(
		`SELECT EXISTS(
		    SELECT 1 FROM attachments a
		     WHERE a.id = $1 AND (
		         a.uploader_id = $2
		         OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $2 AND r.code = 'admin')
		         OR EXISTS (
		             SELECT 1 FROM gallery_images gi
		             LEFT JOIN gallery_directories gd ON gd.id = gi.directory_id
		              WHERE gi.attachment_id = a.id AND (
		                  gd.owner_id = $2 OR gd.visibility = 'public'
		                  OR EXISTS (SELECT 1 FROM gallery_directory_permissions gdp WHERE gdp.directory_id = gd.id AND gdp.user_id = $2 AND (gdp.can_view OR gdp.can_edit))
		                  OR (gd.visibility = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = gd.channel_id AND cm.user_id = $2))
		                  OR (gi.directory_id IS NULL AND gi.saved_by = $2)
		              )
		         )
		     )
		)`, attachmentID, userID,
	).Scan(&allowed)
	return allowed, err
}

func scanChannel(scanner interface {
	Scan(dest ...any) error
}) (*model.Channel, error) {
	var channel model.Channel
	var description sql.NullString
	var ownerID sql.NullInt64
	var avatarAttachmentID sql.NullInt64
	var aiAssistantID sql.NullInt64
	var lastMessageID sql.NullInt64
	var lastMessageSenderID sql.NullInt64
	var lastMessageAt sql.NullTime
	if err := scanner.Scan(
		&channel.ID, &channel.Name, &description, &ownerID, &channel.OwnerName, &avatarAttachmentID,
		&channel.ChannelType, &aiAssistantID, &channel.AIAssistantName, &channel.AIAssistantCount,
		&channel.MemberCount, &channel.IsPinned, &channel.PinSortOrder, &channel.UnreadCount,
		&lastMessageID, &lastMessageSenderID, &lastMessageAt,
		&channel.CreatedAt, &channel.UpdatedAt,
	); err != nil {
		return nil, err
	}
	if description.Valid {
		channel.Description = &description.String
	}
	if ownerID.Valid {
		channel.OwnerID = ownerID.Int64
	}
	if avatarAttachmentID.Valid {
		channel.AvatarAttachmentID = &avatarAttachmentID.Int64
	}
	if aiAssistantID.Valid {
		channel.AIAssistantID = &aiAssistantID.Int64
	}
	if lastMessageID.Valid {
		channel.LastMessageID = &lastMessageID.Int64
	}
	if lastMessageSenderID.Valid {
		channel.LastMessageSenderID = &lastMessageSenderID.Int64
	}
	if lastMessageAt.Valid {
		channel.LastMessageAt = &lastMessageAt.Time
	}
	return &channel, nil
}

func channelMessageSelectSQL() string {
	return `SELECT ` + channelMessageColumnsSQL() + `
		  FROM channel_messages m
		  LEFT JOIN users u ON u.id = m.sender_id
		  LEFT JOIN attachments a ON a.id = m.attachment_id
		  LEFT JOIN workbooks w ON w.id = m.linked_workbook_id
		  LEFT JOIN sheets s ON s.id = m.linked_sheet_id
		  LEFT JOIN ai_summary_pages asp ON asp.id = m.linked_summary_id
		  LEFT JOIN channel_messages rm ON rm.id = m.reply_to_message_id
		  LEFT JOIN users ru ON ru.id = rm.sender_id
		  LEFT JOIN attachments ra ON ra.id = rm.attachment_id
		  LEFT JOIN ai_assistants ai ON ai.id = m.assistant_id
		  LEFT JOIN ai_assistants rai ON rai.id = rm.assistant_id`
}

func channelMessageColumnsSQL() string {
	return `m.id, m.channel_id, m.sender_id,
		CASE
		    WHEN m.sender_type = 'ai' THEN COALESCE(ai.name, 'AI 助手')
		    WHEN m.sender_type = 'whatsapp' THEN COALESCE(NULLIF(m.external_sender_name, ''), 'WhatsApp 联系人')
		    ELSE COALESCE(u.username, '')
		END,
		CASE WHEN m.sender_type IN ('ai', 'whatsapp') THEN NULL ELSE u.avatar END,
		m.sender_type, m.external_source, m.external_account_id, m.external_message_id, m.external_sender_name, m.external_sender_address, m.external_sender_avatar,
		m.assistant_id, COALESCE(ai.name, ''), COALESCE(m.content, ''),
		m.attachment_id, a.filename, a.mime_type, a.size,
		m.linked_workbook_id, w.name, m.linked_sheet_id, s.name, m.linked_summary_id, asp.title,
		m.forwarded_from_message_id, m.reply_to_message_id,
		rm.sender_id, CASE
		    WHEN rm.sender_type = 'ai' THEN COALESCE(rai.name, 'AI 助手')
		    WHEN rm.sender_type = 'whatsapp' THEN COALESCE(NULLIF(rm.external_sender_name, ''), 'WhatsApp 联系人')
		    ELSE ru.username
		END, rm.content, ra.filename, rm.recalled_at,
		m.recalled_at, m.recalled_by, m.created_at`
}

func channelMessageSearchFromSQL() string {
	return `FROM channel_messages m
		JOIN channels c ON c.id = m.channel_id
		LEFT JOIN users u ON u.id = m.sender_id
		LEFT JOIN attachments a ON a.id = m.attachment_id
		LEFT JOIN workbooks w ON w.id = m.linked_workbook_id
		LEFT JOIN sheets s ON s.id = m.linked_sheet_id
		LEFT JOIN ai_summary_pages asp ON asp.id = m.linked_summary_id
		LEFT JOIN channel_messages rm ON rm.id = m.reply_to_message_id
		LEFT JOIN users ru ON ru.id = rm.sender_id
		LEFT JOIN attachments ra ON ra.id = rm.attachment_id
		LEFT JOIN ai_assistants ai ON ai.id = m.assistant_id
		LEFT JOIN ai_assistants rai ON rai.id = rm.assistant_id`
}

func scanChannelMessage(scanner interface {
	Scan(dest ...any) error
}) (*model.ChannelMessage, error) {
	return scanChannelMessageValues(scanner, nil)
}

func scanChannelMessageSearchResult(scanner interface {
	Scan(dest ...any) error
}) (*model.ChannelMessageSearchResult, error) {
	var channelName string
	message, err := scanChannelMessageValues(scanner, &channelName)
	if err != nil {
		return nil, err
	}
	return &model.ChannelMessageSearchResult{ChannelMessage: *message, ChannelName: channelName}, nil
}

func scanChannelMessageValues(scanner interface {
	Scan(dest ...any) error
}, channelName *string) (*model.ChannelMessage, error) {
	var message model.ChannelMessage
	var senderID sql.NullInt64
	var senderAvatar sql.NullString
	var externalSource sql.NullString
	var externalAccountID sql.NullInt64
	var externalMessageID sql.NullString
	var externalSenderName sql.NullString
	var externalSenderAddress sql.NullString
	var externalSenderAvatar sql.NullString
	var assistantID sql.NullInt64
	var attachmentID sql.NullInt64
	var attachmentFilename sql.NullString
	var attachmentMimeType sql.NullString
	var attachmentSize sql.NullInt64
	var workbookID sql.NullInt64
	var workbookName sql.NullString
	var sheetID sql.NullInt64
	var sheetName sql.NullString
	var summaryID sql.NullInt64
	var summaryTitle sql.NullString
	var forwardedFrom sql.NullInt64
	var replyToMessageID sql.NullInt64
	var replySenderID sql.NullInt64
	var replySenderName sql.NullString
	var replyContent sql.NullString
	var replyAttachmentName sql.NullString
	var replyRecalledAt sql.NullTime
	var recalledAt sql.NullTime
	var recalledBy sql.NullInt64
	destinations := make([]any, 0, 37)
	if channelName != nil {
		destinations = append(destinations, channelName)
	}
	destinations = append(destinations,
		&message.ID, &message.ChannelID, &senderID, &message.SenderName, &senderAvatar,
		&message.SenderType, &externalSource, &externalAccountID, &externalMessageID, &externalSenderName, &externalSenderAddress, &externalSenderAvatar,
		&assistantID, &message.AssistantName, &message.Content,
		&attachmentID, &attachmentFilename, &attachmentMimeType, &attachmentSize,
		&workbookID, &workbookName, &sheetID, &sheetName, &summaryID, &summaryTitle, &forwardedFrom, &replyToMessageID,
		&replySenderID, &replySenderName, &replyContent, &replyAttachmentName, &replyRecalledAt,
		&recalledAt, &recalledBy, &message.CreatedAt,
	)
	if err := scanner.Scan(destinations...); err != nil {
		return nil, err
	}
	if senderID.Valid {
		message.SenderID = senderID.Int64
	}
	if senderAvatar.Valid {
		message.SenderAvatar = &senderAvatar.String
	}
	if externalSource.Valid {
		message.ExternalSource = &externalSource.String
	}
	if externalAccountID.Valid {
		message.ExternalAccountID = &externalAccountID.Int64
	}
	if externalMessageID.Valid {
		message.ExternalMessageID = &externalMessageID.String
	}
	if externalSenderName.Valid {
		message.ExternalSenderName = &externalSenderName.String
	}
	if externalSenderAddress.Valid {
		message.ExternalSenderAddress = &externalSenderAddress.String
	}
	if externalSenderAvatar.Valid {
		message.ExternalSenderAvatar = &externalSenderAvatar.String
	}
	if assistantID.Valid {
		message.AssistantID = &assistantID.Int64
	}
	if attachmentID.Valid {
		message.AttachmentID = &attachmentID.Int64
	}
	if attachmentFilename.Valid {
		message.AttachmentFilename = &attachmentFilename.String
	}
	if attachmentMimeType.Valid {
		message.AttachmentMimeType = &attachmentMimeType.String
	}
	if attachmentSize.Valid {
		message.AttachmentSize = &attachmentSize.Int64
	}
	if workbookID.Valid {
		message.LinkedWorkbookID = &workbookID.Int64
	}
	if workbookName.Valid {
		message.LinkedWorkbookName = &workbookName.String
	}
	if sheetID.Valid {
		message.LinkedSheetID = &sheetID.Int64
	}
	if sheetName.Valid {
		message.LinkedSheetName = &sheetName.String
	}
	if summaryID.Valid {
		message.LinkedSummaryID = &summaryID.Int64
	}
	if summaryTitle.Valid {
		message.LinkedSummaryTitle = &summaryTitle.String
	}
	if forwardedFrom.Valid {
		message.ForwardedFromMessageID = &forwardedFrom.Int64
	}
	if replyToMessageID.Valid {
		message.ReplyToMessageID = &replyToMessageID.Int64
	}
	if replySenderID.Valid {
		message.ReplySenderID = &replySenderID.Int64
	}
	if replySenderName.Valid {
		message.ReplySenderName = &replySenderName.String
	}
	if replyContent.Valid {
		message.ReplyContent = &replyContent.String
	}
	if replyAttachmentName.Valid {
		message.ReplyAttachmentName = &replyAttachmentName.String
	}
	if replyRecalledAt.Valid {
		message.ReplyRecalledAt = &replyRecalledAt.Time
	}
	if recalledAt.Valid {
		message.RecalledAt = &recalledAt.Time
	}
	if recalledBy.Valid {
		message.RecalledBy = &recalledBy.Int64
	}
	return &message, nil
}

func scanGalleryDirectory(scanner interface {
	Scan(dest ...any) error
}) (*model.GalleryDirectory, error) {
	var directory model.GalleryDirectory
	var ownerID sql.NullInt64
	var channelID sql.NullInt64
	if err := scanner.Scan(&directory.ID, &directory.Name, &ownerID, &directory.OwnerName, &channelID, &directory.Visibility, &directory.CanManage, &directory.CanEdit, &directory.CreatedAt, &directory.UpdatedAt); err != nil {
		return nil, err
	}
	if ownerID.Valid {
		directory.OwnerID = ownerID.Int64
	}
	if channelID.Valid {
		directory.ChannelID = &channelID.Int64
	}
	return &directory, nil
}
