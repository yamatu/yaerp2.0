package repo

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"yaerp/internal/model"
)

type SheetHistoryRepo struct {
	db *sql.DB
}

func NewSheetHistoryRepo(db *sql.DB) *SheetHistoryRepo {
	return &SheetHistoryRepo{db: db}
}

func (r *SheetHistoryRepo) LoadSheetSnapshot(sheetID int64) (json.RawMessage, error) {
	var snapshot json.RawMessage
	err := r.db.QueryRow(
		`SELECT jsonb_build_object(
			'schema_version', 1,
			'sheet', jsonb_build_object(
				'name', s.name,
				'sort_order', s.sort_order,
				'columns', s.columns,
				'frozen', s.frozen,
				'config', s.config
			),
			'rows', COALESCE((
				SELECT jsonb_agg(
					jsonb_build_object('row_index', r.row_index, 'data', r.data)
					ORDER BY r.row_index
				)
				FROM rows r
				WHERE r.sheet_id = s.id
			), '[]'::jsonb)
		)
		FROM sheets s
		WHERE s.id = $1`,
		sheetID,
	).Scan(&snapshot)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sheet %d not found", sheetID)
	}
	if err != nil {
		return nil, fmt.Errorf("load sheet snapshot: %w", err)
	}
	return snapshot, nil
}

func (r *SheetHistoryRepo) SaveSheetVersion(capture model.SheetVersionCapture, snapshot json.RawMessage, checksum string, coalesceWindow time.Duration) (*model.SheetVersion, bool, error) {
	tx, err := r.db.Begin()
	if err != nil {
		return nil, false, fmt.Errorf("begin sheet version transaction: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`SELECT pg_advisory_xact_lock($1)`, capture.SheetID); err != nil {
		return nil, false, fmt.Errorf("lock sheet version sequence: %w", err)
	}

	latest, err := getLatestSheetVersionTx(tx, capture.SheetID)
	if err != nil {
		return nil, false, err
	}
	if latest != nil && latest.Checksum == checksum && !capture.Force {
		return latest, false, nil
	}

	now := time.Now()
	canCoalesce := capture.Coalesce && latest != nil && latest.CreatedBy != nil &&
		*latest.CreatedBy == capture.UserID && latest.Source == capture.Source &&
		latest.RestoredFromID == nil && now.Sub(latest.UpdatedAt) <= coalesceWindow
	if canCoalesce {
		err = tx.QueryRow(
			`UPDATE sheet_versions
			 SET snapshot = $1, checksum = $2, summary = $3,
			     change_count = change_count + 1, updated_at = $4
			 WHERE id = $5
			 RETURNING id, sheet_id, version_number, created_by, source, summary, checksum,
			           change_count, restored_from_id, created_at, updated_at`,
			snapshot, checksum, capture.Summary, now, latest.ID,
		).Scan(
			&latest.ID, &latest.SheetID, &latest.VersionNumber, &latest.CreatedBy,
			&latest.Source, &latest.Summary, &latest.Checksum, &latest.ChangeCount,
			&latest.RestoredFromID, &latest.CreatedAt, &latest.UpdatedAt,
		)
		if err != nil {
			return nil, false, fmt.Errorf("coalesce sheet version: %w", err)
		}
		if err := tx.Commit(); err != nil {
			return nil, false, fmt.Errorf("commit sheet version: %w", err)
		}
		return latest, true, nil
	}

	versionNumber := int64(1)
	if latest != nil {
		versionNumber = latest.VersionNumber + 1
	}
	version := &model.SheetVersion{}
	err = tx.QueryRow(
		`INSERT INTO sheet_versions
			(sheet_id, version_number, created_by, source, summary, snapshot, checksum,
			 change_count, restored_from_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, $9)
		 RETURNING id, sheet_id, version_number, created_by, source, summary, checksum,
		           change_count, restored_from_id, created_at, updated_at`,
		capture.SheetID, versionNumber, nullablePositiveInt64(capture.UserID), capture.Source,
		capture.Summary, snapshot, checksum, capture.RestoredFromID, now,
	).Scan(
		&version.ID, &version.SheetID, &version.VersionNumber, &version.CreatedBy,
		&version.Source, &version.Summary, &version.Checksum, &version.ChangeCount,
		&version.RestoredFromID, &version.CreatedAt, &version.UpdatedAt,
	)
	if err != nil {
		return nil, false, fmt.Errorf("create sheet version: %w", err)
	}

	if _, err := tx.Exec(
		`DELETE FROM sheet_versions
		 WHERE id IN (
			SELECT id FROM sheet_versions
			 WHERE sheet_id = $1 AND source IN ('web', 'ai', 'sync', 'import')
			 ORDER BY updated_at DESC, id DESC
			 OFFSET 150
		 )`,
		capture.SheetID,
	); err != nil {
		return nil, false, fmt.Errorf("prune sheet versions: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("commit sheet version: %w", err)
	}
	return version, true, nil
}

func getLatestSheetVersionTx(tx *sql.Tx, sheetID int64) (*model.SheetVersion, error) {
	version := &model.SheetVersion{}
	err := tx.QueryRow(
		`SELECT id, sheet_id, version_number, created_by, source, summary, checksum,
		        change_count, restored_from_id, created_at, updated_at
		 FROM sheet_versions
		 WHERE sheet_id = $1
		 ORDER BY version_number DESC
		 LIMIT 1
		 FOR UPDATE`,
		sheetID,
	).Scan(
		&version.ID, &version.SheetID, &version.VersionNumber, &version.CreatedBy,
		&version.Source, &version.Summary, &version.Checksum, &version.ChangeCount,
		&version.RestoredFromID, &version.CreatedAt, &version.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("load latest sheet version: %w", err)
	}
	return version, nil
}

func (r *SheetHistoryRepo) ListSheetVersions(sheetID int64, page, size int) ([]model.SheetVersion, int64, error) {
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM sheet_versions WHERE sheet_id = $1`, sheetID).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count sheet versions: %w", err)
	}

	rows, err := r.db.Query(
		`SELECT v.id, v.sheet_id, v.version_number, v.created_by,
		        COALESCE(u.username, '已删除账号'), v.source, v.summary, v.checksum,
		        v.change_count, v.restored_from_id, restored.version_number,
		        v.created_at, v.updated_at
		 FROM sheet_versions v
		 LEFT JOIN users u ON u.id = v.created_by
		 LEFT JOIN sheet_versions restored ON restored.id = v.restored_from_id
		 WHERE v.sheet_id = $1
		 ORDER BY v.version_number DESC
		 LIMIT $2 OFFSET $3`,
		sheetID, size, (page-1)*size,
	)
	if err != nil {
		return nil, 0, fmt.Errorf("list sheet versions: %w", err)
	}
	defer rows.Close()

	versions := make([]model.SheetVersion, 0)
	for rows.Next() {
		var version model.SheetVersion
		var restoredVersion sql.NullInt64
		if err := rows.Scan(
			&version.ID, &version.SheetID, &version.VersionNumber, &version.CreatedBy,
			&version.CreatedByName, &version.Source, &version.Summary, &version.Checksum,
			&version.ChangeCount, &version.RestoredFromID, &restoredVersion,
			&version.CreatedAt, &version.UpdatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan sheet version: %w", err)
		}
		if restoredVersion.Valid {
			value := restoredVersion.Int64
			version.RestoredFrom = &value
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate sheet versions: %w", err)
	}
	return versions, total, nil
}

func (r *SheetHistoryRepo) GetSheetVersion(sheetID, versionID int64) (*model.SheetVersion, error) {
	version := &model.SheetVersion{}
	var restoredVersion sql.NullInt64
	err := r.db.QueryRow(
		`SELECT v.id, v.sheet_id, v.version_number, v.created_by,
		        COALESCE(u.username, '已删除账号'), v.source, v.summary, v.snapshot,
		        v.checksum, v.change_count, v.restored_from_id, restored.version_number,
		        v.created_at, v.updated_at
		 FROM sheet_versions v
		 LEFT JOIN users u ON u.id = v.created_by
		 LEFT JOIN sheet_versions restored ON restored.id = v.restored_from_id
		 WHERE v.sheet_id = $1 AND v.id = $2`,
		sheetID, versionID,
	).Scan(
		&version.ID, &version.SheetID, &version.VersionNumber, &version.CreatedBy,
		&version.CreatedByName, &version.Source, &version.Summary, &version.Snapshot,
		&version.Checksum, &version.ChangeCount, &version.RestoredFromID, &restoredVersion,
		&version.CreatedAt, &version.UpdatedAt,
	)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("sheet version not found")
	}
	if err != nil {
		return nil, fmt.Errorf("get sheet version: %w", err)
	}
	if restoredVersion.Valid {
		value := restoredVersion.Int64
		version.RestoredFrom = &value
	}
	return version, nil
}

func (r *SheetHistoryRepo) RestoreSheetSnapshot(sheetID, userID int64, snapshot *model.SheetVersionSnapshot) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin sheet restore: %w", err)
	}
	defer tx.Rollback()

	var lockedID int64
	if err := tx.QueryRow(`SELECT id FROM sheets WHERE id = $1 FOR UPDATE`, sheetID).Scan(&lockedID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("sheet %d not found", sheetID)
		}
		return fmt.Errorf("lock sheet for restore: %w", err)
	}

	if _, err := tx.Exec(
		`UPDATE sheets
		 SET name = $1, sort_order = $2, columns = $3, frozen = $4, config = $5, updated_at = NOW()
		 WHERE id = $6`,
		snapshot.Sheet.Name, snapshot.Sheet.SortOrder, snapshot.Sheet.Columns,
		snapshot.Sheet.Frozen, snapshot.Sheet.Config, sheetID,
	); err != nil {
		return fmt.Errorf("restore sheet metadata: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM rows WHERE sheet_id = $1`, sheetID); err != nil {
		return fmt.Errorf("clear sheet rows for restore: %w", err)
	}

	stmt, err := tx.Prepare(
		`INSERT INTO rows
			(sheet_id, row_index, data, created_by, updated_by, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $4, NOW(), NOW())`,
	)
	if err != nil {
		return fmt.Errorf("prepare restored rows: %w", err)
	}
	defer stmt.Close()
	for _, row := range snapshot.Rows {
		if _, err := stmt.Exec(sheetID, row.RowIndex, row.Data, nullablePositiveInt64(userID)); err != nil {
			return fmt.Errorf("restore row %d: %w", row.RowIndex, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit sheet restore: %w", err)
	}
	return nil
}

func (r *SheetHistoryRepo) CreateOperationLog(log *model.OperationLog) error {
	if len(log.Metadata) == 0 {
		log.Metadata = json.RawMessage(`{}`)
	}
	_, err := r.db.Exec(
		`INSERT INTO operation_logs
			(user_id, sheet_id, row_index, column_key, action, old_value, new_value,
			 resource_type, resource_id, source, summary, metadata, request_id, ip_address, user_agent)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
		log.UserID, log.SheetID, log.RowIndex, log.ColumnKey, log.Action,
		nullableJSON(log.OldValue), nullableJSON(log.NewValue), log.ResourceType, log.ResourceID,
		log.Source, log.Summary, log.Metadata, nullableString(log.RequestID),
		nullableString(log.IPAddress), nullableString(log.UserAgent),
	)
	if err != nil {
		return fmt.Errorf("create operation log: %w", err)
	}
	return nil
}

func (r *SheetHistoryRepo) ListOperationLogs(filter model.OperationLogFilter) ([]model.OperationLog, int64, error) {
	where := []string{"1 = 1"}
	args := make([]any, 0)
	addArg := func(value any) string {
		args = append(args, value)
		return fmt.Sprintf("$%d", len(args))
	}
	if filter.SheetID != nil {
		where = append(where, "l.sheet_id = "+addArg(*filter.SheetID))
	}
	if filter.UserID != nil {
		where = append(where, "l.user_id = "+addArg(*filter.UserID))
	}
	if filter.Action != "" {
		where = append(where, "l.action = "+addArg(filter.Action))
	}
	if filter.Source != "" {
		where = append(where, "l.source = "+addArg(filter.Source))
	}
	if filter.Keyword != "" {
		placeholder := addArg("%" + filter.Keyword + "%")
		where = append(where, fmt.Sprintf(
			"(l.summary ILIKE %s OR l.action ILIKE %s OR COALESCE(u.username, '') ILIKE %s OR COALESCE(s.name, l.metadata->>'sheet_name', '') ILIKE %s OR COALESCE(w.name, l.metadata->>'workbook_name', '') ILIKE %s)",
			placeholder, placeholder, placeholder, placeholder, placeholder,
		))
	}
	if filter.From != nil {
		where = append(where, "l.created_at >= "+addArg(*filter.From))
	}
	if filter.To != nil {
		where = append(where, "l.created_at <= "+addArg(*filter.To))
	}
	whereSQL := strings.Join(where, " AND ")

	var total int64
	countQuery := `SELECT COUNT(*)
		FROM operation_logs l
		LEFT JOIN users u ON u.id = l.user_id
		LEFT JOIN sheets s ON s.id = l.sheet_id
		LEFT JOIN workbooks w ON w.id = COALESCE(
			s.workbook_id,
			CASE WHEN l.resource_type = 'workbook' THEN l.resource_id END,
			CASE WHEN COALESCE(l.metadata->>'workbook_id', '') ~ '^[0-9]+$' THEN (l.metadata->>'workbook_id')::BIGINT END
		)
		WHERE ` + whereSQL
	if err := r.db.QueryRow(countQuery, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("count operation logs: %w", err)
	}

	limitPlaceholder := addArg(filter.PageSize)
	offsetPlaceholder := addArg((filter.Page - 1) * filter.PageSize)
	query := `SELECT l.id, l.user_id, COALESCE(u.username, l.metadata->>'username', '已删除账号'),
		       l.sheet_id, COALESCE(s.name, l.metadata->>'sheet_name', ''),
		       w.id, COALESCE(w.name, l.metadata->>'workbook_name', ''),
		       l.resource_type, l.resource_id, l.row_index, l.column_key, l.action,
		       l.source, l.summary, l.old_value, l.new_value, l.metadata,
		       COALESCE(l.request_id, ''), COALESCE(l.ip_address, ''),
		       COALESCE(l.user_agent, ''), l.created_at
		FROM operation_logs l
		LEFT JOIN users u ON u.id = l.user_id
		LEFT JOIN sheets s ON s.id = l.sheet_id
		LEFT JOIN workbooks w ON w.id = COALESCE(
			s.workbook_id,
			CASE WHEN l.resource_type = 'workbook' THEN l.resource_id END,
			CASE WHEN COALESCE(l.metadata->>'workbook_id', '') ~ '^[0-9]+$' THEN (l.metadata->>'workbook_id')::BIGINT END
		)
		WHERE ` + whereSQL + `
		ORDER BY l.created_at DESC, l.id DESC
		LIMIT ` + limitPlaceholder + ` OFFSET ` + offsetPlaceholder
	rows, err := r.db.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("list operation logs: %w", err)
	}
	defer rows.Close()

	logs := make([]model.OperationLog, 0)
	for rows.Next() {
		var item model.OperationLog
		var oldValue sql.NullString
		var newValue sql.NullString
		if err := rows.Scan(
			&item.ID, &item.UserID, &item.Username, &item.SheetID, &item.SheetName,
			&item.WorkbookID, &item.WorkbookName, &item.ResourceType, &item.ResourceID,
			&item.RowIndex, &item.ColumnKey, &item.Action, &item.Source, &item.Summary,
			&oldValue, &newValue, &item.Metadata, &item.RequestID,
			&item.IPAddress, &item.UserAgent, &item.CreatedAt,
		); err != nil {
			return nil, 0, fmt.Errorf("scan operation log: %w", err)
		}
		if oldValue.Valid {
			item.OldValue = json.RawMessage(oldValue.String)
		}
		if newValue.Valid {
			item.NewValue = json.RawMessage(newValue.String)
		}
		logs = append(logs, item)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("iterate operation logs: %w", err)
	}
	return logs, total, nil
}

func nullablePositiveInt64(value int64) any {
	if value <= 0 {
		return nil
	}
	return value
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableJSON(value json.RawMessage) any {
	if len(value) == 0 || string(value) == "null" {
		return nil
	}
	return value
}
