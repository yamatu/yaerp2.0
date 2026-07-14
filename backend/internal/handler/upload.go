package handler

import (
	"errors"
	"mime"
	"net/http"
	"strconv"

	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type UploadHandler struct {
	uploadService *service.UploadService
}

func NewUploadHandler(uploadService *service.UploadService) *UploadHandler {
	return &UploadHandler{uploadService: uploadService}
}

func (h *UploadHandler) Upload(c *gin.Context) {
	userID := c.GetInt64("user_id")

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "file is required")
		return
	}
	defer file.Close()

	attachment, err := h.uploadService.Upload(file, header, userID)
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OK(c, attachment)
}

func (h *UploadHandler) GetFile(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid file id")
		return
	}

	url, err := h.uploadService.GetFileURL(id)
	if err != nil {
		response.NotFound(c, err.Error())
		return
	}

	response.OK(c, gin.H{"url": url})
}

func (h *UploadHandler) ServeFile(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid file id")
		return
	}

	attachment, reader, err := h.uploadService.OpenFile(id, c.Query("signature"))
	if err != nil {
		switch {
		case errors.Is(err, service.ErrInvalidFileSignature):
			response.Forbidden(c, "invalid file signature")
		default:
			response.NotFound(c, err.Error())
		}
		return
	}
	defer reader.Close()

	disposition := "inline"
	if c.Query("download") == "1" || c.Query("download") == "true" {
		disposition = "attachment"
	}
	c.Header("Content-Disposition", mime.FormatMediaType(disposition, map[string]string{"filename": attachment.Filename}))
	c.DataFromReader(http.StatusOK, attachment.Size, attachment.MimeType, reader, nil)
}

func (h *UploadHandler) ListImages(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	size, _ := strconv.Atoi(c.DefaultQuery("size", "20"))
	if page < 1 {
		page = 1
	}
	if size < 1 || size > 100 {
		size = 20
	}

	list, total, err := h.uploadService.ListImagesFiltered(c.GetInt64("user_id"), page, size, parseOptionalQueryInt64(c, "directory_id"), parseOptionalQueryInt64(c, "channel_id"))
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	response.OKPage(c, list, total, page, size)
}

func (h *UploadHandler) DeleteFile(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid file id")
		return
	}

	if err := h.uploadService.DeleteFile(id); err != nil {
		response.NotFound(c, err.Error())
		return
	}

	response.OKMsg(c, "deleted")
}
