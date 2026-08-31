package model

import "time"

type Department struct {
	ID          int64     `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedBy   *int64    `json:"created_by,omitempty"`
	MemberIDs   []int64   `json:"member_ids"`
	MemberCount int       `json:"member_count"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

type CreateDepartmentRequest struct {
	Name        string  `json:"name" binding:"required"`
	Description string  `json:"description"`
	MemberIDs   []int64 `json:"member_ids"`
}

type UpdateDepartmentRequest struct {
	Name        string `json:"name" binding:"required"`
	Description string `json:"description"`
}

type SetDepartmentMembersRequest struct {
	UserIDs []int64 `json:"user_ids"`
}
