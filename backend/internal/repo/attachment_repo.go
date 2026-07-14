package repo

import (
	"database/sql"
	"fmt"

	"yaerp/internal/model"
)

type AttachmentRepo struct {
	db *sql.DB
}

func NewAttachmentRepo(db *sql.DB) *AttachmentRepo {
	return &AttachmentRepo{db: db}
}

func (r *AttachmentRepo) Create(a *model.Attachment) error {
	return r.db.QueryRow(
		`INSERT INTO attachments (filename, mime_type, size, bucket, object_key, uploader_id)
		 VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
		a.Filename, a.MimeType, a.Size, a.Bucket, a.ObjectKey, a.UploaderID,
	).Scan(&a.ID, &a.CreatedAt)
}

func (r *AttachmentRepo) GetByID(id int64) (*model.Attachment, error) {
	a := &model.Attachment{}
	err := r.db.QueryRow(
		`SELECT a.id, a.filename, a.mime_type, a.size, a.bucket, a.object_key, a.uploader_id,
		        COALESCE(u.username, ''), a.created_at
		 FROM attachments a
		 LEFT JOIN users u ON u.id = a.uploader_id
		 WHERE a.id = $1`, id,
	).Scan(&a.ID, &a.Filename, &a.MimeType, &a.Size, &a.Bucket, &a.ObjectKey, &a.UploaderID, &a.UploaderName, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (r *AttachmentRepo) UpdateFilename(id int64, filename string) error {
	result, err := r.db.Exec(`UPDATE attachments SET filename = $1 WHERE id = $2`, filename, id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return sql.ErrNoRows
	}
	return nil
}

func (r *AttachmentRepo) ListByMimePrefix(prefix string, page, size int) ([]*model.Attachment, int64, error) {
	return r.ListByMimePrefixFiltered(prefix, page, size, nil, nil)
}

func (r *AttachmentRepo) ListByMimePrefixFiltered(prefix string, page, size int, directoryID *int64, channelID *int64) ([]*model.Attachment, int64, error) {
	return r.ListAccessibleByMimePrefixFiltered(prefix, page, size, 0, directoryID, channelID)
}

func (r *AttachmentRepo) ListAccessibleByMimePrefixFiltered(prefix string, page, size int, userID int64, directoryID *int64, channelID *int64) ([]*model.Attachment, int64, error) {
	where := ` WHERE a.mime_type LIKE $1 AND EXISTS (
		SELECT 1 FROM gallery_images gi
		LEFT JOIN gallery_directories gd ON gd.id = gi.directory_id
		WHERE gi.attachment_id = a.id`
	args := []any{prefix + "%", userID}
	if directoryID != nil {
		args = append(args, *directoryID)
		where += fmt.Sprintf(` AND gi.directory_id = $%d`, len(args))
	}
	if channelID != nil {
		args = append(args, *channelID)
		where += fmt.Sprintf(` AND COALESCE(gi.channel_id, gd.channel_id) = $%d`, len(args))
	}
	where += ` AND (
			a.uploader_id = $2
			OR EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $2 AND r.code = 'admin')
			OR (gi.directory_id IS NULL AND gi.saved_by = $2)
			OR gd.owner_id = $2
			OR gd.visibility = 'public'
			OR EXISTS (SELECT 1 FROM gallery_directory_permissions gdp WHERE gdp.directory_id = gd.id AND gdp.user_id = $2 AND (gdp.can_view OR gdp.can_edit))
			OR (gd.visibility = 'channel' AND EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = gd.channel_id AND cm.user_id = $2))
		))`

	var total int64
	err := r.db.QueryRow(
		`SELECT COUNT(*) FROM attachments a`+where,
		args...,
	).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * size
	args = append(args, size, offset)
	rows, err := r.db.Query(
		`SELECT a.id, a.filename, a.mime_type, a.size, a.bucket, a.object_key, a.uploader_id,
		        COALESCE(u.username, ''), a.created_at
		 FROM attachments a
		 LEFT JOIN users u ON u.id = a.uploader_id`+where+fmt.Sprintf(` ORDER BY a.created_at DESC LIMIT $%d OFFSET $%d`, len(args)-1, len(args)),
		args...,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var list []*model.Attachment
	for rows.Next() {
		a := &model.Attachment{}
		if err := rows.Scan(&a.ID, &a.Filename, &a.MimeType, &a.Size, &a.Bucket, &a.ObjectKey, &a.UploaderID, &a.UploaderName, &a.CreatedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, a)
	}
	return list, total, nil
}

func (r *AttachmentRepo) Delete(id int64) (*model.Attachment, error) {
	a := &model.Attachment{}
	err := r.db.QueryRow(
		`DELETE FROM attachments WHERE id = $1
		 RETURNING id, filename, mime_type, size, bucket, object_key, uploader_id, created_at`, id,
	).Scan(&a.ID, &a.Filename, &a.MimeType, &a.Size, &a.Bucket, &a.ObjectKey, &a.UploaderID, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	return a, nil
}
