package handler

import (
	"strconv"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

type DepartmentHandler struct {
	service *service.DepartmentService
}

func NewDepartmentHandler(departmentService *service.DepartmentService) *DepartmentHandler {
	return &DepartmentHandler{service: departmentService}
}

func (h *DepartmentHandler) List(c *gin.Context) {
	departments, err := h.service.List()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}
	response.OK(c, departments)
}

func (h *DepartmentHandler) Create(c *gin.Context) {
	var req model.CreateDepartmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	department, err := h.service.Create(c.GetInt64("user_id"), &req)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, department)
}

func (h *DepartmentHandler) Update(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid department id")
		return
	}
	var req model.UpdateDepartmentRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.Update(id, &req); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "department updated")
}

func (h *DepartmentHandler) Delete(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid department id")
		return
	}
	if err := h.service.Delete(id); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "department deleted")
}

func (h *DepartmentHandler) SetMembers(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid department id")
		return
	}
	var req model.SetDepartmentMembersRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.SetMembers(id, req.UserIDs); err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OKMsg(c, "department members updated")
}
