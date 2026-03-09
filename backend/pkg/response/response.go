package response

import (
	"net/http"

	"github.com/gin-gonic/gin"
)

type Response struct {
	Code    int         `json:"code"`
	Message string      `json:"message"`
	Data    interface{} `json:"data,omitempty"`
}

func OK(c *gin.Context, data interface{}) {
	c.JSON(http.StatusOK, Response{
		Code:    0,
		Message: "success",
		Data:    data,
	})
}

func OKMsg(c *gin.Context, msg string) {
	c.JSON(http.StatusOK, Response{
		Code:    0,
		Message: msg,
	})
}

func Error(c *gin.Context, httpCode int, msg string) {
	c.JSON(httpCode, Response{
		Code:    -1,
		Message: msg,
	})
}

func BadRequest(c *gin.Context, msg string) {
	Error(c, http.StatusBadRequest, msg)
}

func Unauthorized(c *gin.Context, msg string) {
	Error(c, http.StatusUnauthorized, msg)
}

func Forbidden(c *gin.Context, msg string) {
	Error(c, http.StatusForbidden, msg)
}

func NotFound(c *gin.Context, msg string) {
	Error(c, http.StatusNotFound, msg)
}

func ServerError(c *gin.Context, msg string) {
	Error(c, http.StatusInternalServerError, msg)
}

type PageData struct {
	List  interface{} `json:"list"`
	Total int64       `json:"total"`
	Page  int         `json:"page"`
	Size  int         `json:"size"`
}

func OKPage(c *gin.Context, list interface{}, total int64, page, size int) {
	OK(c, PageData{
		List:  list,
		Total: total,
		Page:  page,
		Size:  size,
	})
}
