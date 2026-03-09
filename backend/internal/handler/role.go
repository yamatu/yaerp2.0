package handler

import (
	"database/sql"
	"strconv"

	"yaerp/internal/model"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type RoleHandler struct {
	db *sql.DB
}

func NewRoleHandler(db *sql.DB) *RoleHandler {
	return &RoleHandler{db: db}
}

func (h *RoleHandler) ListRoles(c *gin.Context) {
	rows, err := h.db.Query("SELECT id, name, code, description, created_at FROM roles ORDER BY id")
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	defer rows.Close()

	var roles []model.Role
	for rows.Next() {
		var r model.Role
		if err := rows.Scan(&r.ID, &r.Name, &r.Code, &r.Description, &r.CreatedAt); err != nil {
			response.ServerError(c, err.Error())
			return
		}
		roles = append(roles, r)
	}

	response.OK(c, roles)
}

func (h *RoleHandler) CreateRole(c *gin.Context) {
	var req model.CreateRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	var id int64
	err := h.db.QueryRow(
		"INSERT INTO roles (name, code, description) VALUES ($1, $2, $3) RETURNING id",
		req.Name, req.Code, req.Description,
	).Scan(&id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, gin.H{"id": id})
}

func (h *RoleHandler) UpdateRole(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid role id")
		return
	}

	var req model.UpdateRoleRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}

	result, err := h.db.Exec(
		"UPDATE roles SET name = COALESCE($1, name), description = COALESCE($2, description) WHERE id = $3",
		req.Name, req.Description, id,
	)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	affected, _ := result.RowsAffected()
	if affected == 0 {
		response.NotFound(c, "role not found")
		return
	}

	response.OKMsg(c, "role updated")
}

func (h *RoleHandler) DeleteRole(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid role id")
		return
	}

	result, err := h.db.Exec("DELETE FROM roles WHERE id = $1", id)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	affected, _ := result.RowsAffected()
	if affected == 0 {
		response.NotFound(c, "role not found")
		return
	}

	response.OKMsg(c, "role deleted")
}
