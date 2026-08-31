package repo

import (
	"database/sql"
	"encoding/json"
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

const deletedTradeOrderSelect = `
	SELECT o.id, o.order_no, o.title, o.stage, c.name, c.company_name,
	       o.owner_id, COALESCE(owner.username, ''), o.workbook_id, COALESCE(w.name, ''),
	       (SELECT COUNT(*) FROM trade_order_items item WHERE item.order_id = o.id),
	       (SELECT COUNT(*) FROM trade_supplier_quotes quote WHERE quote.order_id = o.id),
	       (SELECT COUNT(*) FROM trade_customer_quote_rounds quote WHERE quote.order_id = o.id),
	       (SELECT COUNT(*) FROM trade_order_stage_events event WHERE event.order_id = o.id),
	       (SELECT COUNT(*) FROM trade_inspection_photos photo WHERE photo.order_id = o.id),
	       o.deleted_at, o.deleted_by, deleter.username, o.created_at, o.updated_at
	FROM trade_orders o
	JOIN trade_customers c ON c.id = o.customer_id
	LEFT JOIN users owner ON owner.id = o.owner_id
	LEFT JOIN users deleter ON deleter.id = o.deleted_by
	LEFT JOIN workbooks w ON w.id = o.workbook_id`

const deletedTradePaymentProofSelect = `
	SELECT p.id,p.order_id,o.order_no,o.title,p.quote_id,q.round_no,p.attachment_id,
	       a.filename,a.mime_type,a.size,p.note,p.uploaded_by,COALESCE(u.username,''),
	       p.deleted_at,p.deleted_by,COALESCE(deleter.username,''),p.created_at
	FROM trade_customer_payment_proofs p
	JOIN trade_orders o ON o.id=p.order_id
	JOIN trade_customer_quote_rounds q ON q.id=p.quote_id
	JOIN attachments a ON a.id=p.attachment_id
	LEFT JOIN users u ON u.id=p.uploaded_by
	LEFT JOIN users deleter ON deleter.id=p.deleted_by`

func scanDeletedTradeOrder(scanner interface{ Scan(...any) error }) (*model.DeletedTradeOrder, error) {
	var order model.DeletedTradeOrder
	if err := scanner.Scan(
		&order.ID, &order.OrderNo, &order.Title, &order.Stage,
		&order.CustomerName, &order.CustomerCompany, &order.OwnerID, &order.OwnerName,
		&order.WorkbookID, &order.WorkbookName, &order.ItemCount, &order.SupplierQuoteCount,
		&order.CustomerQuoteCount, &order.StageEventCount, &order.InspectionPhotoCount,
		&order.DeletedAt, &order.DeletedByID, &order.DeletedByName,
		&order.CreatedAt, &order.UpdatedAt,
	); err != nil {
		return nil, err
	}
	return &order, nil
}

func scanDeletedTradePaymentProof(scanner interface{ Scan(...any) error }) (*model.DeletedTradePaymentProof, error) {
	var proof model.DeletedTradePaymentProof
	if err := scanner.Scan(
		&proof.ID, &proof.OrderID, &proof.OrderNo, &proof.OrderTitle, &proof.QuoteID,
		&proof.QuoteRoundNo, &proof.AttachmentID, &proof.Filename, &proof.MimeType,
		&proof.Size, &proof.Note, &proof.UploadedBy, &proof.UploadedByName,
		&proof.DeletedAt, &proof.DeletedByID, &proof.DeletedByName, &proof.CreatedAt,
	); err != nil {
		return nil, err
	}
	return &proof, nil
}

func (r *RecycleBinRepo) List(userID int64, includeAll bool) ([]model.Folder, []model.Workbook, []model.DeletedTradeOrder, error) {
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
		return nil, nil, nil, fmt.Errorf("list deleted folders: %w", err)
	}
	defer folderRows.Close()

	folders := make([]model.Folder, 0)
	for folderRows.Next() {
		var folder model.Folder
		if err := folderRows.Scan(
			&folder.ID, &folder.Name, &folder.ParentID, &folder.OwnerID, &folder.OwnerName,
			&folder.DeletedAt, &folder.DeletedByID, &folder.DeletedByName, &folder.CreatedAt, &folder.UpdatedAt,
		); err != nil {
			return nil, nil, nil, fmt.Errorf("scan deleted folder: %w", err)
		}
		folders = append(folders, folder)
	}
	if err := folderRows.Err(); err != nil {
		return nil, nil, nil, fmt.Errorf("iterate deleted folders: %w", err)
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
		   AND NOT EXISTS (
		       SELECT 1
		       FROM trade_orders trade_order
		       WHERE trade_order.workbook_id = w.id
		         AND trade_order.deleted_at IS NOT NULL
		   )
		 ORDER BY w.deleted_at DESC, w.id DESC`,
		userID, includeAll,
	)
	if err != nil {
		return nil, nil, nil, fmt.Errorf("list deleted workbooks: %w", err)
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
			return nil, nil, nil, fmt.Errorf("scan deleted workbook: %w", err)
		}
		workbooks = append(workbooks, workbook)
	}
	if err := workbookRows.Err(); err != nil {
		return nil, nil, nil, fmt.Errorf("iterate deleted workbooks: %w", err)
	}

	tradeOrders := make([]model.DeletedTradeOrder, 0)
	if includeAll {
		orderRows, err := r.db.Query(deletedTradeOrderSelect + `
			WHERE o.deleted_at IS NOT NULL
			ORDER BY o.deleted_at DESC, o.id DESC`)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("list deleted trade orders: %w", err)
		}
		defer orderRows.Close()
		for orderRows.Next() {
			order, err := scanDeletedTradeOrder(orderRows)
			if err != nil {
				return nil, nil, nil, fmt.Errorf("scan deleted trade order: %w", err)
			}
			tradeOrders = append(tradeOrders, *order)
		}
		if err := orderRows.Err(); err != nil {
			return nil, nil, nil, fmt.Errorf("iterate deleted trade orders: %w", err)
		}
	}

	return folders, workbooks, tradeOrders, nil
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
		 WHERE w.id = $1 AND w.deleted_at IS NOT NULL
		   AND NOT EXISTS (
		       SELECT 1 FROM trade_orders trade_order
		       WHERE trade_order.workbook_id = w.id
		         AND trade_order.deleted_at IS NOT NULL
		   )`,
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

func (r *RecycleBinRepo) GetDeletedTradeOrder(id int64) (*model.DeletedTradeOrder, error) {
	order, err := scanDeletedTradeOrder(r.db.QueryRow(
		deletedTradeOrderSelect+` WHERE o.id = $1 AND o.deleted_at IS NOT NULL`, id,
	))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("deleted trade order %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get deleted trade order: %w", err)
	}
	return order, nil
}

func (r *RecycleBinRepo) ListDeletedTradePaymentProofs() ([]model.DeletedTradePaymentProof, error) {
	rows, err := r.db.Query(deletedTradePaymentProofSelect + `
		WHERE p.deleted_at IS NOT NULL
		ORDER BY p.deleted_at DESC,p.id DESC`)
	if err != nil {
		return nil, fmt.Errorf("list deleted trade payment proofs: %w", err)
	}
	defer rows.Close()
	proofs := make([]model.DeletedTradePaymentProof, 0)
	for rows.Next() {
		proof, err := scanDeletedTradePaymentProof(rows)
		if err != nil {
			return nil, fmt.Errorf("scan deleted trade payment proof: %w", err)
		}
		proofs = append(proofs, *proof)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate deleted trade payment proofs: %w", err)
	}
	return proofs, nil
}

func (r *RecycleBinRepo) GetDeletedTradePaymentProof(id int64) (*model.DeletedTradePaymentProof, error) {
	proof, err := scanDeletedTradePaymentProof(r.db.QueryRow(
		deletedTradePaymentProofSelect+` WHERE p.id=$1 AND p.deleted_at IS NOT NULL`, id,
	))
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("deleted trade payment proof %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get deleted trade payment proof: %w", err)
	}
	return proof, nil
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
			  AND NOT EXISTS (
			      SELECT 1 FROM trade_orders trade_order
			      WHERE trade_order.workbook_id = workbooks.id
			        AND trade_order.deleted_at IS NOT NULL
			  )
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

func (r *RecycleBinRepo) RestoreTradeOrder(id, restoredBy int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin restoring trade order: %w", err)
	}
	defer tx.Rollback()

	var workbookID sql.NullInt64
	var stage string
	var orderNo string
	var title string
	if err := tx.QueryRow(
		`SELECT workbook_id, stage, order_no, title
		 FROM trade_orders
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 FOR UPDATE`, id,
	).Scan(&workbookID, &stage, &orderNo, &title); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("deleted trade order %d not found", id)
		}
		return fmt.Errorf("lock deleted trade order: %w", err)
	}

	if workbookID.Valid {
		if _, err := tx.Exec(
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
			workbookID.Int64,
		); err != nil {
			return fmt.Errorf("restore trade order workbook: %w", err)
		}
	}

	result, err := tx.Exec(
		`UPDATE trade_orders
		 SET deleted_at = NULL, deleted_by = NULL, updated_at = NOW()
		 WHERE id = $1 AND deleted_at IS NOT NULL`, id,
	)
	if err != nil {
		return fmt.Errorf("restore trade order: %w", err)
	}
	if rows, _ := result.RowsAffected(); rows == 0 {
		return fmt.Errorf("deleted trade order %d not found", id)
	}

	snapshot, err := json.Marshal(map[string]any{
		"order_no": orderNo,
		"title":    title,
		"restored": true,
	})
	if err != nil {
		return fmt.Errorf("encode restored trade order event: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO trade_order_stage_events (order_id, from_stage, to_stage, actor_id, note, snapshot)
		 VALUES ($1, $2, $2, $3, '从回收站还原业务单', $4::jsonb)`,
		id, stage, restoredBy, string(snapshot),
	); err != nil {
		return fmt.Errorf("record restored trade order event: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit restoring trade order: %w", err)
	}
	return nil
}

func (r *RecycleBinRepo) RestoreTradePaymentProof(id int64) error {
	result, err := r.db.Exec(
		`UPDATE trade_customer_payment_proofs
		 SET deleted_at=NULL,deleted_by=NULL
		 WHERE id=$1 AND deleted_at IS NOT NULL`, id,
	)
	if err != nil {
		return fmt.Errorf("restore trade payment proof: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return fmt.Errorf("deleted trade payment proof %d not found", id)
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

func (r *RecycleBinRepo) DeleteTradeOrderPermanently(id int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin permanent trade order deletion: %w", err)
	}
	defer tx.Rollback()

	var workbookID sql.NullInt64
	if err := tx.QueryRow(
		`SELECT workbook_id FROM trade_orders
		 WHERE id = $1 AND deleted_at IS NOT NULL
		 FOR UPDATE`, id,
	).Scan(&workbookID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("deleted trade order %d not found", id)
		}
		return fmt.Errorf("lock deleted trade order: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM trade_orders WHERE id = $1 AND deleted_at IS NOT NULL`, id); err != nil {
		return fmt.Errorf("permanently delete trade order: %w", err)
	}
	if workbookID.Valid {
		if _, err := tx.Exec(
			`DELETE FROM workbooks workbook
			 WHERE workbook.id = $1
			   AND workbook.deleted_at IS NOT NULL
			   AND NOT EXISTS (
			       SELECT 1 FROM trade_orders other_order
			       WHERE other_order.workbook_id = workbook.id
			   )`, workbookID.Int64,
		); err != nil {
			return fmt.Errorf("permanently delete trade order workbook: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit permanent trade order deletion: %w", err)
	}
	return nil
}

func (r *RecycleBinRepo) DeleteTradePaymentProofPermanently(id int64) error {
	result, err := r.db.Exec(
		`DELETE FROM trade_customer_payment_proofs WHERE id=$1 AND deleted_at IS NOT NULL`, id,
	)
	if err != nil {
		return fmt.Errorf("permanently delete trade payment proof: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return fmt.Errorf("deleted trade payment proof %d not found", id)
	}
	return nil
}

func (r *RecycleBinRepo) ListExpiredTradePaymentProofAttachmentIDs(cutoff time.Time) ([]int64, error) {
	rows, err := r.db.Query(
		`SELECT attachment_id FROM trade_customer_payment_proofs
		 WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff,
	)
	if err != nil {
		return nil, fmt.Errorf("list expired trade payment proof attachments: %w", err)
	}
	defer rows.Close()
	attachmentIDs := make([]int64, 0)
	for rows.Next() {
		var attachmentID int64
		if err := rows.Scan(&attachmentID); err != nil {
			return nil, err
		}
		attachmentIDs = append(attachmentIDs, attachmentID)
	}
	return attachmentIDs, rows.Err()
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
		  AND deleted_by IS NOT DISTINCT FROM $3
		  AND NOT EXISTS (
		      SELECT 1 FROM trade_orders trade_order
		      WHERE trade_order.workbook_id = workbooks.id
		        AND trade_order.deleted_at IS NOT NULL
		  )`,
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

	paymentProofResult, err := tx.Exec(`DELETE FROM trade_customer_payment_proofs WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted trade payment proofs: %w", err)
	}
	tradeOrderResult, err := tx.Exec(`DELETE FROM trade_orders WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted trade orders: %w", err)
	}
	workbookResult, err := tx.Exec(`DELETE FROM workbooks WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted workbooks: %w", err)
	}
	folderResult, err := tx.Exec(`DELETE FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < $1`, cutoff)
	if err != nil {
		return 0, fmt.Errorf("purge deleted folders: %w", err)
	}

	paymentProofCount, _ := paymentProofResult.RowsAffected()
	tradeOrderCount, _ := tradeOrderResult.RowsAffected()
	workbookCount, _ := workbookResult.RowsAffected()
	folderCount, _ := folderResult.RowsAffected()
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit recycle bin cleanup: %w", err)
	}
	return paymentProofCount + tradeOrderCount + workbookCount + folderCount, nil
}
