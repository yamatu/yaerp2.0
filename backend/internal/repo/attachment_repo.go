package repo

import (
	"database/sql"

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
		`SELECT id, filename, mime_type, size, bucket, object_key, uploader_id, created_at
		 FROM attachments WHERE id = $1`, id,
	).Scan(&a.ID, &a.Filename, &a.MimeType, &a.Size, &a.Bucket, &a.ObjectKey, &a.UploaderID, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	return a, nil
}

func (r *AttachmentRepo) ListByMimePrefix(prefix string, page, size int) ([]*model.Attachment, int64, error) {
	var total int64
	err := r.db.QueryRow(
		`SELECT COUNT(*) FROM attachments WHERE mime_type LIKE $1`,
		prefix+"%",
	).Scan(&total)
	if err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * size
	rows, err := r.db.Query(
		`SELECT id, filename, mime_type, size, bucket, object_key, uploader_id, created_at
		 FROM attachments WHERE mime_type LIKE $1
		 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
		prefix+"%", size, offset,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var list []*model.Attachment
	for rows.Next() {
		a := &model.Attachment{}
		if err := rows.Scan(&a.ID, &a.Filename, &a.MimeType, &a.Size, &a.Bucket, &a.ObjectKey, &a.UploaderID, &a.CreatedAt); err != nil {
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
