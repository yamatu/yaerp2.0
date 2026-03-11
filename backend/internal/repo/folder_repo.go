package repo

import (
	"database/sql"
	"fmt"
	"time"

	"yaerp/internal/model"
)

type FolderRepo struct {
	db *sql.DB
}

func NewFolderRepo(db *sql.DB) *FolderRepo {
	return &FolderRepo{db: db}
}

func (r *FolderRepo) Create(f *model.Folder) error {
	now := time.Now()
	err := r.db.QueryRow(
		`INSERT INTO folders (name, parent_id, owner_id, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5)
		 RETURNING id`,
		f.Name, f.ParentID, f.OwnerID, now, now,
	).Scan(&f.ID)
	if err != nil {
		return fmt.Errorf("create folder: %w", err)
	}
	f.CreatedAt = now
	f.UpdatedAt = now
	return nil
}

func (r *FolderRepo) GetByID(id int64) (*model.Folder, error) {
	var f model.Folder
	err := r.db.QueryRow(
		`SELECT f.id, f.name, f.parent_id, f.owner_id, u.username, f.created_at, f.updated_at
		 FROM folders f
		 LEFT JOIN users u ON u.id = f.owner_id
		 WHERE f.id = $1`, id,
	).Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.OwnerName, &f.CreatedAt, &f.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, fmt.Errorf("folder %d not found", id)
	}
	if err != nil {
		return nil, fmt.Errorf("get folder: %w", err)
	}
	return &f, nil
}

func (r *FolderRepo) Update(f *model.Folder) error {
	f.UpdatedAt = time.Now()
	result, err := r.db.Exec(
		`UPDATE folders SET name = $1, updated_at = $2 WHERE id = $3`,
		f.Name, f.UpdatedAt, f.ID,
	)
	if err != nil {
		return fmt.Errorf("update folder: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("folder %d not found", f.ID)
	}
	return nil
}

func (r *FolderRepo) Delete(id int64) error {
	result, err := r.db.Exec(`DELETE FROM folders WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete folder: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("folder %d not found", id)
	}
	return nil
}

func (r *FolderRepo) ListSubFolders(parentID *int64) ([]model.Folder, error) {
	var queryRows *sql.Rows
	var err error

	if parentID == nil {
		queryRows, err = r.db.Query(
			`SELECT f.id, f.name, f.parent_id, f.owner_id, u.username, f.created_at, f.updated_at
			 FROM folders f
			 LEFT JOIN users u ON u.id = f.owner_id
			 WHERE f.parent_id IS NULL
			 ORDER BY f.name`,
		)
	} else {
		queryRows, err = r.db.Query(
			`SELECT f.id, f.name, f.parent_id, f.owner_id, u.username, f.created_at, f.updated_at
			 FROM folders f
			 LEFT JOIN users u ON u.id = f.owner_id
			 WHERE f.parent_id = $1
			 ORDER BY f.name`, *parentID,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("list sub-folders: %w", err)
	}
	defer queryRows.Close()

	folders := make([]model.Folder, 0)
	for queryRows.Next() {
		var f model.Folder
		if err := queryRows.Scan(&f.ID, &f.Name, &f.ParentID, &f.OwnerID, &f.OwnerName, &f.CreatedAt, &f.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan folder: %w", err)
		}
		folders = append(folders, f)
	}
	return folders, queryRows.Err()
}

func (r *FolderRepo) SetShares(folderID int64, shares []model.FolderShareEntry) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM folder_shares WHERE folder_id = $1`, folderID); err != nil {
		return fmt.Errorf("clear shares: %w", err)
	}

	for _, share := range shares {
		if _, err := tx.Exec(
			`INSERT INTO folder_shares (folder_id, user_id, access_level)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (folder_id, user_id)
			 DO UPDATE SET access_level = EXCLUDED.access_level`,
			folderID, share.UserID, share.AccessLevel,
		); err != nil {
			return fmt.Errorf("insert share: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit tx: %w", err)
	}

	return nil
}

func (r *FolderRepo) ListShares(folderID int64) ([]model.FolderShareUser, error) {
	rows, err := r.db.Query(
		`SELECT u.id, u.username, u.email, fs.access_level
		 FROM folder_shares fs
		 INNER JOIN users u ON u.id = fs.user_id
		 WHERE fs.folder_id = $1
		 ORDER BY u.username, u.id`,
		folderID,
	)
	if err != nil {
		return nil, fmt.Errorf("list shares: %w", err)
	}
	defer rows.Close()

	shares := make([]model.FolderShareUser, 0)
	for rows.Next() {
		var user model.FolderShareUser
		if err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.AccessLevel); err != nil {
			return nil, fmt.Errorf("scan shared user: %w", err)
		}
		shares = append(shares, user)
	}

	return shares, rows.Err()
}

func (r *FolderRepo) GetShareAccessLevel(folderID, userID int64) (string, error) {
	var accessLevel string
	err := r.db.QueryRow(
		`SELECT access_level FROM folder_shares WHERE folder_id = $1 AND user_id = $2`,
		folderID, userID,
	).Scan(&accessLevel)
	if err == sql.ErrNoRows {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("check folder share: %w", err)
	}
	return accessLevel, nil
}

func (r *FolderRepo) ListDirectlySharedFolders(userID int64) ([]model.Folder, error) {
	rows, err := r.db.Query(
		`SELECT f.id, f.name, f.parent_id, f.owner_id, u.username, fs.access_level, f.created_at, f.updated_at
		 FROM folder_shares fs
		 INNER JOIN folders f ON f.id = fs.folder_id
		 LEFT JOIN users u ON u.id = f.owner_id
		 WHERE fs.user_id = $1 AND f.owner_id <> $1
		 ORDER BY f.updated_at DESC, f.id DESC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list shared folders: %w", err)
	}
	defer rows.Close()

	folders := make([]model.Folder, 0)
	for rows.Next() {
		var folder model.Folder
		if err := rows.Scan(&folder.ID, &folder.Name, &folder.ParentID, &folder.OwnerID, &folder.OwnerName, &folder.AccessLevel, &folder.CreatedAt, &folder.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan shared folder: %w", err)
		}
		folders = append(folders, folder)
	}

	return folders, rows.Err()
}

func (r *FolderRepo) ListWorkbooksInFolder(folderID *int64) ([]model.Workbook, error) {
	var queryRows *sql.Rows
	var err error

	if folderID == nil {
		queryRows, err = r.db.Query(
			`SELECT w.id, w.name, w.description, w.owner_id, u.username, w.folder_id, w.metadata, w.is_template, w.status, w.created_at, w.updated_at
			 FROM workbooks w
			 LEFT JOIN users u ON u.id = w.owner_id
			 WHERE w.folder_id IS NULL
			 ORDER BY name`,
		)
	} else {
		queryRows, err = r.db.Query(
			`SELECT w.id, w.name, w.description, w.owner_id, u.username, w.folder_id, w.metadata, w.is_template, w.status, w.created_at, w.updated_at
			 FROM workbooks w
			 LEFT JOIN users u ON u.id = w.owner_id
			 WHERE w.folder_id = $1
			 ORDER BY name`, *folderID,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("list workbooks in folder: %w", err)
	}
	defer queryRows.Close()

	wbs := make([]model.Workbook, 0)
	for queryRows.Next() {
		var wb model.Workbook
		if err := queryRows.Scan(&wb.ID, &wb.Name, &wb.Description, &wb.OwnerID, &wb.OwnerName, &wb.FolderID, &wb.Metadata, &wb.IsTemplate, &wb.Status, &wb.CreatedAt, &wb.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan workbook: %w", err)
		}
		wbs = append(wbs, wb)
	}
	return wbs, queryRows.Err()
}

func (r *FolderRepo) MoveWorkbook(workbookID int64, folderID *int64) error {
	result, err := r.db.Exec(
		`UPDATE workbooks SET folder_id = $1, updated_at = NOW() WHERE id = $2`,
		folderID, workbookID,
	)
	if err != nil {
		return fmt.Errorf("move workbook: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("workbook %d not found", workbookID)
	}
	return nil
}

func (r *FolderRepo) SetVisibility(folderID int64, entries []model.FolderVisibility) error {
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	_, err = tx.Exec(`DELETE FROM folder_visibility WHERE folder_id = $1`, folderID)
	if err != nil {
		return fmt.Errorf("clear visibility: %w", err)
	}

	for _, entry := range entries {
		_, err = tx.Exec(
			`INSERT INTO folder_visibility (folder_id, role_id, visible) VALUES ($1, $2, $3)`,
			folderID, entry.RoleID, entry.Visible,
		)
		if err != nil {
			return fmt.Errorf("insert visibility: %w", err)
		}
	}

	return tx.Commit()
}

func (r *FolderRepo) GetVisibleFolderIDs(roleIDs []int64) (map[int64]bool, error) {
	if len(roleIDs) == 0 {
		return map[int64]bool{}, nil
	}

	// Build a query with placeholders for role IDs
	query := `SELECT DISTINCT folder_id FROM folder_visibility WHERE visible = true AND role_id = ANY($1)`
	queryRows, err := r.db.Query(query, roleIDsToArray(roleIDs))
	if err != nil {
		return nil, fmt.Errorf("get visible folders: %w", err)
	}
	defer queryRows.Close()

	result := make(map[int64]bool)
	for queryRows.Next() {
		var folderID int64
		if err := queryRows.Scan(&folderID); err != nil {
			return nil, fmt.Errorf("scan folder id: %w", err)
		}
		result[folderID] = true
	}
	return result, queryRows.Err()
}

func (r *FolderRepo) HasVisibilityRules(folderID int64) (bool, error) {
	var count int
	err := r.db.QueryRow(
		`SELECT COUNT(*) FROM folder_visibility WHERE folder_id = $1`, folderID,
	).Scan(&count)
	if err != nil {
		return false, err
	}
	return count > 0, nil
}

// GetAncestorPath returns folder ancestors from root to given folder.
func (r *FolderRepo) GetAncestorPath(folderID int64) ([]model.Folder, error) {
	var path []model.Folder
	currentID := &folderID

	for currentID != nil {
		f, err := r.GetByID(*currentID)
		if err != nil {
			return nil, err
		}
		path = append([]model.Folder{*f}, path...)
		currentID = f.ParentID
	}

	return path, nil
}

func roleIDsToArray(ids []int64) interface{} {
	// pq.Array equivalent: format as PostgreSQL array literal
	return fmt.Sprintf("{%s}", int64SliceToCSV(ids))
}

func int64SliceToCSV(ids []int64) string {
	result := ""
	for i, id := range ids {
		if i > 0 {
			result += ","
		}
		result += fmt.Sprintf("%d", id)
	}
	return result
}
