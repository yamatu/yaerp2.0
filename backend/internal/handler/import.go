package handler

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
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

func (h *ImportHandler) ImportWorkbookXLSX(c *gin.Context) {
	userID := c.GetInt64("user_id")

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
	if !service.IsNativeExcelImportFilename(header.Filename) {
		response.BadRequest(c, "only .xlsx, .xlsm, .xltx and .xltm files are supported")
		return
	}
	source, err := readLegacyExcelImportSource(c)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	var folderID *int64
	if rawFolderID := strings.TrimSpace(c.PostForm("folder_id")); rawFolderID != "" {
		parsedFolderID, err := strconv.ParseInt(rawFolderID, 10, 64)
		if err != nil {
			response.BadRequest(c, "invalid folder id")
			return
		}
		folderID = &parsedFolderID
	}

	result, err := h.importService.ImportWorkbookXLSX(userID, file, header.Filename, c.PostForm("workbook_name"), folderID, source)
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

	response.OK(c, result)
}

func (h *ImportHandler) DownloadWorkbookSourceXLSX(c *gin.Context) {
	userID := c.GetInt64("user_id")
	workbookID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil {
		response.BadRequest(c, "invalid workbook id")
		return
	}

	file, err := h.importService.BuildWorkbookSourceXLSXFile(userID, workbookID)
	if err != nil {
		switch {
		case errors.Is(err, service.ErrSheetExportDenied), errors.Is(err, service.ErrWorkbookAccessDenied):
			response.Forbidden(c, err.Error())
		default:
			response.Error(c, http.StatusBadRequest, err.Error())
		}
		return
	}
	defer file.Reader.Close()

	escapedFilename := strings.ReplaceAll(url.QueryEscape(file.Filename), "+", "%20")
	asciiFallback := buildASCIIFilename(file.Filename)
	c.Header("Content-Type", file.ContentType)
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q; filename*=UTF-8''%s", asciiFallback, escapedFilename))
	c.Header("Content-Length", strconv.FormatInt(file.Size, 10))
	c.Header("X-Content-Type-Options", "nosniff")
	c.DataFromReader(http.StatusOK, file.Size, file.ContentType, file.Reader, nil)
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
	if !service.IsNativeExcelImportFilename(header.Filename) {
		response.BadRequest(c, "only .xlsx, .xlsm, .xltx and .xltm files are supported")
		return
	}
	source, err := readLegacyExcelImportSource(c)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}

	result, err := h.importService.ImportXLSX(userID, workbookID, file, header.Filename, c.PostForm("sheet_name"), source)
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

func readLegacyExcelImportSource(c *gin.Context) (*service.SpreadsheetImportSource, error) {
	file, header, err := c.Request.FormFile("source_file")
	if errors.Is(err, http.ErrMissingFile) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("invalid source file")
	}
	defer file.Close()

	if !service.IsLegacyExcelImportFilename(header.Filename) {
		return nil, fmt.Errorf("source file must use the .xls format")
	}
	if header.Size <= 0 {
		return nil, fmt.Errorf("source file is empty")
	}
	if header.Size > 20<<20 {
		return nil, fmt.Errorf("source file size must be <= 20MB")
	}

	data, err := io.ReadAll(io.LimitReader(file, (20<<20)+1))
	if err != nil {
		return nil, fmt.Errorf("failed to read source file")
	}
	if len(data) > 20<<20 {
		return nil, fmt.Errorf("source file size must be <= 20MB")
	}
	return &service.SpreadsheetImportSource{Filename: header.Filename, Data: data}, nil
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
