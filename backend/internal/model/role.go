package model

import "time"

type Role struct {
	ID          int64     `json:"id" db:"id"`
	Name        string    `json:"name" db:"name"`
	Code        string    `json:"code" db:"code"`
	Description *string   `json:"description" db:"description"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
}

type CreateRoleRequest struct {
	Name        string `json:"name" binding:"required"`
	Code        string `json:"code" binding:"required"`
	Description string `json:"description"`
}

type UpdateRoleRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type AssignRoleRequest struct {
	Roles []int64 `json:"roles" binding:"required"`
}
