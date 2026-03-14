package handler

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"

	"yaerp/internal/service"
	"yaerp/pkg/response"

	"github.com/gin-gonic/gin"
)

type ImportHandler struct {
	importService *service.SheetImportService
}

func NewImportHandler(importService *service.SheetImportService) *ImportHandler {
	return &ImportHandler{importService: importService}
}

func (h *ImportHandler) ImportXLSX(c *gin.Context) {
	userID := c.GetInt64("user_id")
	workbookID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	file, header, err := c.Request.FormFile("file")
	if err != nil {
		response.BadRequest(c, "file is required")
		return
	}
	defer file.Close()

	if header.Size <= 0 {
		response.BadRequest(c, "file is empty")
		return
	}
	if header.Size > 20<<20 {
		response.BadRequest(c, "file size must be <= 20MB")
		return
	}
	if !strings.EqualFold(filepath.Ext(header.Filename), ".xlsx") {
		response.BadRequest(c, "only .xlsx files are supported")
		return
	}

	result, err := h.importService.ImportXLSX(userID, workbookID, file, header.Filename, c.PostForm("sheet_name"))
	if err != nil {
		var importErr *service.SheetImportError
		if errors.As(err, &importErr) {
			c.JSON(http.StatusBadRequest, gin.H{
				"code":    -1,
				"message": importErr.Error(),
				"data": gin.H{
					"row": importErr.Row,
				},
			})
			return
		}
		response.Error(c, http.StatusBadRequest, err.Error())
		return
	}

	response.OK(c, gin.H{
		"sheet":          result.Sheet,
		"sheet_id":       result.Sheet.ID,
		"imported_rows":  result.ImportedRows,
		"attachment_id":  result.AttachmentID,
		"attachment_url": result.AttachmentURL,
	})
}

func (h *ImportHandler) DownloadTemplate(c *gin.Context) {
	file, err := h.importService.BuildTemplateFile()
	if err != nil {
		response.ServerError(c, err.Error())
		return
	}

	escapedFilename := strings.ReplaceAll(url.QueryEscape(file.Filename), "+", "%20")
	asciiFallback := buildASCIIFilename(file.Filename)
	c.Header("Content-Type", file.ContentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", asciiFallback, escapedFilename))
	c.Header("Content-Length", strconv.Itoa(len(file.Data)))
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, file.ContentType, file.Data)
}
