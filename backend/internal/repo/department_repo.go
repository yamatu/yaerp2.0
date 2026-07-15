package repo

import (
	"database/sql"
	"fmt"
	"sort"
	"strings"

	"yaerp/internal/model"
)

type DepartmentRepo struct {
	db *sql.DB
}

func NewDepartmentRepo(db *sql.DB) *DepartmentRepo {
	return &DepartmentRepo{db: db}
}

func (r *DepartmentRepo) List() ([]model.Department, error) {
	rows, err := r.db.Query(`
		SELECT d.id, d.name, d.description, d.created_by, d.created_at, d.updated_at,
		       COALESCE(array_agg(dm.user_id ORDER BY dm.user_id) FILTER (WHERE dm.user_id IS NOT NULL), '{}')
		FROM departments d
		LEFT JOIN department_members dm ON dm.department_id = d.id
		GROUP BY d.id
		ORDER BY d.name, d.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	departments := make([]model.Department, 0)
	for rows.Next() {
		var department model.Department
		var memberIDsText string
		if err := rows.Scan(
			&department.ID,
			&department.Name,
			&department.Description,
			&department.CreatedBy,
			&department.CreatedAt,
			&department.UpdatedAt,
			&memberIDsText,
		); err != nil {
			return nil, err
		}
		department.MemberIDs = parsePostgresIntArray(memberIDsText)
		department.MemberCount = len(department.MemberIDs)
		departments = append(departments, department)
	}
	return departments, rows.Err()
}

func (r *DepartmentRepo) GetByID(id int64) (*model.Department, error) {
	departments, err := r.List()
	if err != nil {
		return nil, err
	}
	for index := range departments {
		if departments[index].ID == id {
			return &departments[index], nil
		}
	}
	return nil, nil
}

func (r *DepartmentRepo) Create(department *model.Department, memberIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if err := tx.QueryRow(
		`INSERT INTO departments (name, description, created_by)
		 VALUES ($1, $2, $3)
		 RETURNING id, created_at, updated_at`,
		department.Name, department.Description, department.CreatedBy,
	).Scan(&department.ID, &department.CreatedAt, &department.UpdatedAt); err != nil {
		return err
	}

	if err := replaceDepartmentMembers(tx, department.ID, memberIDs); err != nil {
		return err
	}
	department.MemberIDs = normalizeIDs(memberIDs)
	department.MemberCount = len(department.MemberIDs)
	return tx.Commit()
}

func (r *DepartmentRepo) Update(id int64, name, description string) error {
	result, err := r.db.Exec(
		`UPDATE departments SET name = $1, description = $2, updated_at = NOW() WHERE id = $3`,
		name, description, id,
	)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("department %d not found", id)
	}
	return nil
}

func (r *DepartmentRepo) Delete(id int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM principal_cell_permissions WHERE principal_type = 'department' AND principal_id = $1`, id); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM principal_sheet_permissions WHERE principal_type = 'department' AND principal_id = $1`, id); err != nil {
		return err
	}
	result, err := tx.Exec(`DELETE FROM departments WHERE id = $1`, id)
	if err != nil {
		return err
	}
	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("department %d not found", id)
	}
	return tx.Commit()
}

func (r *DepartmentRepo) SetMembers(departmentID int64, userIDs []int64) error {
	tx, err := r.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var exists bool
	if err := tx.QueryRow(`SELECT EXISTS(SELECT 1 FROM departments WHERE id = $1)`, departmentID).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return fmt.Errorf("department %d not found", departmentID)
	}
	if err := replaceDepartmentMembers(tx, departmentID, userIDs); err != nil {
		return err
	}
	if _, err := tx.Exec(`UPDATE departments SET updated_at = NOW() WHERE id = $1`, departmentID); err != nil {
		return err
	}
	return tx.Commit()
}

func (r *DepartmentRepo) GetUserDepartmentIDs(userID int64) ([]int64, error) {
	rows, err := r.db.Query(`SELECT department_id FROM department_members WHERE user_id = $1 ORDER BY department_id`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	ids := make([]int64, 0)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func replaceDepartmentMembers(tx *sql.Tx, departmentID int64, userIDs []int64) error {
	if _, err := tx.Exec(`DELETE FROM department_members WHERE department_id = $1`, departmentID); err != nil {
		return err
	}
	for _, userID := range normalizeIDs(userIDs) {
		if _, err := tx.Exec(
			`INSERT INTO department_members (department_id, user_id) VALUES ($1, $2)`,
			departmentID, userID,
		); err != nil {
			return err
		}
	}
	return nil
}

func normalizeIDs(ids []int64) []int64 {
	seen := make(map[int64]struct{}, len(ids))
	result := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		result = append(result, id)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func parsePostgresIntArray(value string) []int64 {
	value = strings.TrimSpace(strings.Trim(value, "{}"))
	if value == "" {
		return []int64{}
	}
	parts := strings.Split(value, ",")
	result := make([]int64, 0, len(parts))
	for _, part := range parts {
		var id int64
		if _, err := fmt.Sscan(strings.TrimSpace(part), &id); err == nil && id > 0 {
			result = append(result, id)
		}
	}
	return result
}
