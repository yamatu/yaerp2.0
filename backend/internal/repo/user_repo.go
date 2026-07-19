package repo

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"yaerp/internal/model"
)

type UserRepo struct {
	db *sql.DB
}

func NewUserRepo(db *sql.DB) *UserRepo {
	return &UserRepo{db: db}
}

func (r *UserRepo) GetByID(id int64) (*model.User, error) {
	var u model.User
	err := r.db.QueryRow(
		`SELECT id, username, email, password, avatar, status, created_at, updated_at
		 FROM users WHERE id = $1`, id,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Password, &u.Avatar, &u.Status, &u.CreatedAt, &u.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by id: %w", err)
	}
	return &u, nil
}

func (r *UserRepo) GetByUsername(username string) (*model.User, error) {
	var u model.User
	err := r.db.QueryRow(
		`SELECT id, username, email, password, avatar, status, created_at, updated_at
		 FROM users WHERE username = $1`, username,
	).Scan(&u.ID, &u.Username, &u.Email, &u.Password, &u.Avatar, &u.Status, &u.CreatedAt, &u.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get user by username: %w", err)
	}
	return &u, nil
}

func (r *UserRepo) Create(user *model.User) error {
	now := time.Now()
	err := r.db.QueryRow(
		`INSERT INTO users (username, email, password, avatar, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
		user.Username, user.Email, user.Password, user.Avatar, 1, now, now,
	).Scan(&user.ID)
	if err != nil {
		return fmt.Errorf("create user: %w", err)
	}
	user.CreatedAt = now
	user.UpdatedAt = now
	user.Status = 1
	return nil
}

func (r *UserRepo) Update(id int64, req *model.UpdateUserRequest) error {
	setClauses := make([]string, 0)
	args := make([]interface{}, 0)
	idx := 1

	if req.Email != nil {
		setClauses = append(setClauses, fmt.Sprintf("email = $%d", idx))
		args = append(args, *req.Email)
		idx++
	}
	if req.Avatar != nil {
		setClauses = append(setClauses, fmt.Sprintf("avatar = $%d", idx))
		args = append(args, *req.Avatar)
		idx++
	}
	if req.Status != nil {
		setClauses = append(setClauses, fmt.Sprintf("status = $%d", idx))
		args = append(args, *req.Status)
		idx++
	}

	if len(setClauses) == 0 {
		return nil
	}

	setClauses = append(setClauses, fmt.Sprintf("updated_at = $%d", idx))
	args = append(args, time.Now())
	idx++

	args = append(args, id)
	query := fmt.Sprintf("UPDATE users SET %s WHERE id = $%d", strings.Join(setClauses, ", "), idx)

	result, err := r.db.Exec(query, args...)
	if err != nil {
		return fmt.Errorf("update user: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("user %d not found", id)
	}
	return nil
}

func (r *UserRepo) UpdatePassword(id int64, hashedPassword string) error {
	result, err := r.db.Exec(
		`UPDATE users SET password = $1, updated_at = $2 WHERE id = $3`,
		hashedPassword, time.Now(), id,
	)
	if err != nil {
		return fmt.Errorf("update user password: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("user %d not found", id)
	}
	return nil
}

func (r *UserRepo) DeleteAndTransfer(id, replacementID int64) error {
	if id <= 0 || replacementID <= 0 || id == replacementID {
		return fmt.Errorf("invalid user deletion request")
	}
	tx, err := r.db.Begin()
	if err != nil {
		return fmt.Errorf("begin user deletion: %w", err)
	}
	defer tx.Rollback()

	var username string
	if err := tx.QueryRow(`SELECT username FROM users WHERE id=$1 FOR UPDATE`, id).Scan(&username); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("user %d not found", id)
		}
		return fmt.Errorf("lock deleted user: %w", err)
	}
	var replacementUsername string
	if err := tx.QueryRow(`SELECT username FROM users WHERE id=$1 FOR SHARE`, replacementID).Scan(&replacementUsername); err != nil {
		return fmt.Errorf("load replacement user: %w", err)
	}

	transferStatements := []struct {
		name  string
		query string
	}{
		{"workbooks", `UPDATE workbooks SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"folders", `UPDATE folders SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"channels", `UPDATE channels SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"gallery directories", `UPDATE gallery_directories SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"AI summary pages", `UPDATE ai_summary_pages SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"automation rules", `UPDATE automation_rules SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"cell approvals", `UPDATE cell_approval_states SET submitted_by=$2,updated_at=NOW() WHERE submitted_by=$1`},
		{"trade customers", `UPDATE trade_customers SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"trade suppliers", `UPDATE trade_suppliers SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"trade orders", `UPDATE trade_orders SET owner_id=$2,updated_at=NOW() WHERE owner_id=$1`},
		{"supplier quotes", `UPDATE trade_supplier_quotes SET created_by=$2,updated_at=NOW() WHERE created_by=$1`},
		{"customer quotes", `UPDATE trade_customer_quote_rounds SET created_by=$2,updated_at=NOW() WHERE created_by=$1`},
		{"inspection photos", `UPDATE trade_inspection_photos SET uploaded_by=$2 WHERE uploaded_by=$1`},
	}
	for _, statement := range transferStatements {
		if _, err := tx.Exec(statement.query, id, replacementID); err != nil {
			return fmt.Errorf("transfer %s from %s to %s: %w", statement.name, username, replacementUsername, err)
		}
	}

	if _, err := tx.Exec(`UPDATE attachments SET uploader_id=NULL WHERE uploader_id=$1`, id); err != nil {
		return fmt.Errorf("detach user uploads: %w", err)
	}
	if _, err := tx.Exec(`UPDATE rows SET created_by=NULL WHERE created_by=$1`, id); err != nil {
		return fmt.Errorf("detach created rows: %w", err)
	}
	if _, err := tx.Exec(`UPDATE rows SET updated_by=NULL WHERE updated_by=$1`, id); err != nil {
		return fmt.Errorf("detach updated rows: %w", err)
	}

	result, err := tx.Exec(`DELETE FROM users WHERE id=$1`, id)
	if err != nil {
		return fmt.Errorf("delete user %s: %w", username, err)
	}
	if rows, _ := result.RowsAffected(); rows == 0 {
		return fmt.Errorf("user %d not found", id)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit user deletion: %w", err)
	}
	return nil
}

func (r *UserRepo) IsDefaultAdminUser(id int64) (bool, error) {
	var username string
	err := r.db.QueryRow(`SELECT username FROM users WHERE id = $1`, id).Scan(&username)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check default admin: %w", err)
	}
	return username == "admin", nil
}

func (r *UserRepo) List(page, size int) ([]model.User, int64, error) {
	var total int64
	if err := r.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&total); err != nil {
		return nil, 0, err
	}

	offset := (page - 1) * size
	rows, err := r.db.Query(
		`SELECT id, username, email, avatar, status, created_at, updated_at
		 FROM users ORDER BY id DESC LIMIT $1 OFFSET $2`, size, offset,
	)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var users []model.User
	for rows.Next() {
		var u model.User
		if err := rows.Scan(&u.ID, &u.Username, &u.Email, &u.Avatar, &u.Status, &u.CreatedAt, &u.UpdatedAt); err != nil {
			return nil, 0, err
		}
		roles, err := r.GetUserRoles(u.ID)
		if err != nil {
			return nil, 0, fmt.Errorf("get roles for user %d: %w", u.ID, err)
		}
		u.Roles = roles
		users = append(users, u)
	}
	return users, total, rows.Err()
}

func (r *UserRepo) GetUserRoles(userID int64) ([]model.Role, error) {
	rows, err := r.db.Query(
		`SELECT r.id, r.name, r.code, r.description, r.created_at
		 FROM roles r
		 INNER JOIN user_roles ur ON ur.role_id = r.id
		 WHERE ur.user_id = $1 ORDER BY r.id`, userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	roles := make([]model.Role, 0)
	for rows.Next() {
		var role model.Role
		if err := rows.Scan(&role.ID, &role.Name, &role.Code, &role.Description, &role.CreatedAt); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

func (r *UserRepo) AssignRoles(userID int64, roleIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`DELETE FROM user_roles WHERE user_id = $1`, userID); err != nil {
		return err
	}

	for _, roleID := range roleIDs {
		if _, err := tx.Exec(`INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)`, userID, roleID); err != nil {
			return err
		}
	}

	return tx.Commit()
}
