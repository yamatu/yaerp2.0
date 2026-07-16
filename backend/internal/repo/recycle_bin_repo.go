package repo

import (
	"database/sql"
	"fmt"
	"time"

	"yaerp/internal/model"
)

type RecycleBinRepo struct {
	db *sql.DB
}

func NewRecycleBinRepo(db *sql.DB) *RecycleBinRepo {
	return &RecycleBinRepo{db: db}
}

func (r *RecycleBinRepo) List(userID int64, includeAll bool) ([]model.Folder, []model.Workbook, error) {
	folderRows, err := r.db.Query(
		`SELECT f.id, f.name, f.parent_id, f.owner_id, owner.username,
		        f.deleted_at, f.deleted_by, deleter.username, f.created_at, f.updated_at
		 FROM folders f
		 LEFT JOIN users owner ON owner.id = f.owner_id
		 LEFT JOIN users deleter ON deleter.id = f.deleted_by
		 WHERE f.deleted_at IS NOT NULL
		   AND ($2 OR f.owner_id = $1 OR f.deleted_by = $1)
		   AND NOT EXISTS (
		       SELECT 1
		       FROM folders parent
		       WHERE parent.id = f.parent_id
		         AND parent.deleted_at = f.deleted_at
		         AND parent.deleted_by IS NOT DISTINCT FROM f.deleted_by
		   )
		 ORDER BY f.deleted_at DESC, f.id DESC`,
		userID, includeAll,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("list deleted folders: %w", err)
	}
	defer folderRows.Close()

	folders := make([]model.Folder, 0)
	for folderRows.Next() {
		var folder model.Folder
		if err := folderRows.Scan(
			&folder.ID, &folder.Name, &folder.ParentID, &folder.OwnerID, &folder.OwnerName,
			&folder.DeletedAt, &folder.DeletedByID, &folder.DeletedByName, &folder.CreatedAt, &folder.UpdatedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("scan deleted folder: %w", err)
		}
		folders = append(folders, folder)
	}
	if err := folderRows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate deleted folders: %w", err)
	}

	workbookRows, err := r.db.Query(
		`SELECT w.id, w.name, w.description, w.owner_id, owner.username, w.folder_id,
		        w.metadata, w.is_template, w.status, w.deleted_at, w.deleted_by,
		        deleter.username, w.created_at, w.updated_at
		 FROM workbooks w
		 LEFT JOIN users owner ON owner.id = w.owner_id
		 LEFT JOIN users deleter ON deleter.id = w.deleted_by
		 WHERE w.deleted_at IS NOT NULL
		   AND ($2 OR w.owner_id = $1 OR w.deleted_by = $1)
		   AND NOT EXISTS (
		       SELECT 1
		       FROM folders folder_batch
		       WHERE folder_batch.id = w.folder_id
		         AND folder_batch.deleted_at = w.deleted_at
		         AND folder_batch.deleted_by IS NOT DISTINCT FROM w.deleted_by
		   )
		 ORDER BY w.deleted_at DESC, w.id DESC`,
		userID, includeAll,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("list deleted workbooks: %w", err)
	}
	defer workbookRows.Close()

	workbooks := make([]model.Workbook, 0)
	for workbookRows.Next() {
		var workbook model.Workbook
		if err := workbookRows.Scan(
			&workbook.ID, &workbook.Name, &workbook.Description, &workbook.OwnerID, &workbook.OwnerName,
			&workbook.FolderID, &workbook.Metadata, &workbook.IsTemplate, &workbook.Status,
			&workbook.DeletedAt, &workbook.DeletedByID, &workbook.DeletedByName,
			&workbook.CreatedAt, &workbook.UpdatedAt,
		); err != nil {
			return nil, nil, fmt.Errorf("scan deleted workbook: %w", err)
		}
		workbooks = append(workbooks, workbook)
	}
	if err := workbookRows.Err(); err != nil {
		return nil, nil, fmt.Errorf("iterate deleted workbooks: %w", err)
	}

	return folders, workbooks, nil
}

func (r *RecycleBinRepo) GetDeletedWorkbook(id int64) (*model.Workbook, error) {
	var workbook model.Workbook
	err := r.db.QueryRow(
		`SELECT w.id, w.name, w.description, w.owner_id, owner.username, w.folder_id,
		        w.metadata, w.is_template, w.status, w.deleted_at, w.deleted_by,
		        deleter.username, w.created_at, w.updated_at
		 FROM workbooks w
		 LEFT JOIN users owner ON owner.id = w.owner_id
		 LEFT JOIN users deleter ON deleter.id = w.deleted_by
		 WHERE w.id = $1 AND w.deleted_at IS NOT NULL`,
		id,
	).Scan(
		&workbook.ID, &workbook.Name, &workbook.Description, &workbook.OwnerID, &workbook.OwnerName,
		&workbook.FolderID, &workbook.Metadata, &workbook.IsTemplate, &workbook.Status,
		&workbook.DeletedAt, &workbook.DeletedByID, &workbook.DeletedByName,
		&workbook.CreatedAt, &workbook.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("deleted workbook %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get deleted workbook: %w", err)
	}
	return &workbook, nil
}

func (r *RecycleBinRepo) GetDeletedFolder(id int64) (*model.Folder, error) {
	var folder model.Folder
	err := r.db.QueryRow(
		`SELECT f.id, f.name, f.parent_id, f.owner_id, owner.username,
		        f.deleted_at, f.deleted_by, deleter.username, f.created_at, f.updated_at
		 FROM folders f
		 LEFT JOIN users owner ON owner.id = f.owner_id
		 LEFT JOIN users deleter ON deleter.id = f.deleted_by
		 WHERE f.id = $1 AND f.deleted_at IS NOT NULL`,
		id,
	).Scan(
		&folder.ID, &folder.Name, &folder.ParentID, &folder.OwnerID, &folder.OwnerName,
		&folder.DeletedAt, &folder.DeletedByID, &folder.DeletedByName, &folder.CreatedAt, &folder.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("deleted folder %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get deleted folder: %w", err)
	}
	return &folder, nil
}

func (r *RecycleBinRepo) RestoreWorkbook(id int64) error {
	result, err := r.db.Exec(
		`UPDATE workbooks workbook
		 SET folder_id = CASE
		       WHEN workbook.folder_id IS NULL OR EXISTS (
		           SELECT 1 FROM folders folder
		           WHERE folder.id = workbook.folder_id AND folder.deleted_at IS NULL
		       ) THEN workbook.folder_id
		       ELSE NULL
		     END,
		     deleted_at = NULL,
		     deleted_by = NULL,
		     updated_at = NOW()
		 WHERE workbook.id = $1 AND workbook.deleted_at IS NOT NULL`,
		id,
	)
	if err != nil {
		return fmt.Errorf("restore workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("deleted workbook %d not found", id)
	}
	return nil
}

func (r *RecycleBinRepo) RestoreFolder(folder *model.Folder) error {
	if folder.DeletedAt == nil {
		return fmt.Errorf("folder %d is not deleted", folder.ID)
	}

	var folderCount int
	var workbookCount int
	err := r.db.QueryRow(
		`WITH RECURSIVE folder_tree AS (
			SELECT id
			FROM folders
			WHERE id = $1 AND deleted_at = $2 AND deleted_by IS NOT DISTINCT FROM $3
			UNION ALL
			SELECT child.id
			FROM folders child
			INNER JOIN folder_tree parent ON child.parent_id = parent.id
			WHERE child.deleted_at = $2 AND child.deleted_by IS NOT DISTINCT FROM $3
		), restored_workbooks AS (
			UPDATE workbooks
			SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
			WHERE folder_id IN (SELECT id FROM folder_tree)
			  AND deleted_at = $2
			  AND deleted_by IS NOT DISTINCT FROM $3
			RETURNING id
		), restored_folders AS (
			UPDATE folders
			SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
			WHERE id IN (SELECT id FROM folder_tree)
			RETURNING id
		)
		SELECT (SELECT COUNT(*) FROM restored_folders), (SELECT COUNT(*) FROM restored_workbooks)`,
		folder.ID, *folder.DeletedAt, folder.DeletedByID,
	).Scan(&folderCount, &workbookCount)
	if err != nil {
		return fmt.Errorf("restore folder: %w", err)
	}
	if folderCount == 0 {
		return fmt.Errorf("deleted folder %d not found", folder.ID)
	}

	if _, err := r.db.Exec(
		`UPDATE folders folder
		 SET parent_id = NULL, updated_at = NOW()
		 WHERE folder.id = $1
		   AND folder.parent_id IS NOT NULL
		   AND EXISTS (
		       SELECT 1 FROM folders parent
		       WHERE parent.id = folder.parent_id AND parent.deleted_at IS NOT NULL
		   )`,
		folder.ID,
	); err != nil {
		return fmt.Errorf("repair restored folder parent: %w", err)
	}

	return nil
}

func (r *RecycleBinRepo) DeleteWorkbookPermanently(id int64) error {
	result, err := r.db.Exec(`DELETE FROM workbooks WHERE id = $1 AND deleted_at IS NOT NULL`, id)
	if err != nil {
		return fmt.Errorf("permanently delete workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("deleted workbook %d not found", id)
	}
	return nil
}

func (r *RecycleBinRepo) DeleteFolderPermanently(folder *model.Folder) error {
	if folder.DeletedAt == nil {
		return fmt.Errorf("folder %d is not deleted", folder.ID)
	}
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin permanent folder deletion: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(
		`WITH RECURSIVE folder_tree AS (
			SELECT id
			FROM folders
			WHERE id = $1 AND deleted_at = $2 AND deleted_by IS NOT DISTINCT FROM $3
			UNION ALL
			SELECT child.id
			FROM folders child
			INNER JOIN folder_tree parent ON child.parent_id = parent.id
			WHERE child.deleted_at = $2 AND child.deleted_by IS NOT DISTINCT FROM $3
		)
		DELETE FROM workbooks
		WHERE folder_id IN (SELECT id FROM folder_tree)
		  AND deleted_at = $2
		  AND deleted_by IS NOT DISTINCT FROM $3`,
		folder.ID, *folder.DeletedAt, folder.DeletedByID,
	); err != nil {
		return fmt.Errorf("permanently delete folder workbooks: %w", err)
	}

	result, err := tx.Exec(`DELETE FROM folders WHERE id = $1 AND deleted_at IS NOT NULL`, folder.ID)
	if err != nil {
		return fmt.Errorf("permanently delete folder: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("deleted folder %d not found", folder.ID)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit permanent folder deletion: %w", err)
	}
	return nil
}

func (r *RecycleBinRepo) PurgeDeletedBefore(cutoff time.Time) (int64, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return 0, fmt.Errorf("begin recycle bin cleanup: %w", err)
	}
	defer tx.Rollback()

	workbookResult, err := tx.Exec(`DELETE FROM workbooks WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted workbooks: %w", err)
	}
	folderResult, err := tx.Exec(`DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted folders: %w", err)
	}

	workbookCount, _ := workbookResult.RowsAffected()
	folderCount, _ := folderResult.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit recycle bin cleanup: %w", err)
	}
	return workbookCount + folderCount, nil
}
