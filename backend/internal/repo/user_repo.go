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

func (r *UserRepo) Delete(id int64) error {
	result, err := r.db.Exec(`DELETE FROM users WHERE id = $1`, id)
	if err != nil {
		return fmt.Errorf("delete user: %w", err)
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("user %d not found", id)
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

	var roles []model.Role
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
