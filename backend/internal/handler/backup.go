package handler

import (
	"fmt"
	"io"
	"net/http"
	"time"

	"yaerp/internal/service"

	"github.com/gin-gonic/gin"
)

type BackupHandler struct {
	backupService *service.BackupService
}

func NewBackupHandler(backupService *service.BackupService) *BackupHandler {
	return &BackupHandler{backupService: backupService}
}

func (h *BackupHandler) DownloadDatabase(c *gin.Context) {
	data, err := h.backupService.DumpDatabase()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": -1, "message": err.Error()})
		return
	}

	filename := fmt.Sprintf("yaerp_database_%s.sql", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	c.Data(http.StatusOK, "application/sql", data)
}

func (h *BackupHandler) DownloadConfig(c *gin.Context) {
	data, err := h.backupService.ExportConfig()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": -1, "message": err.Error()})
		return
	}

	filename := fmt.Sprintf("yaerp_config_%s.json", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	c.Data(http.StatusOK, "application/json", data)
}

func (h *BackupHandler) DownloadCombined(c *gin.Context) {
	data, err := h.backupService.CombinedBackup()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": -1, "message": err.Error()})
		return
	}

	filename := fmt.Sprintf("yaerp_backup_%s.tar.gz", time.Now().Format("20060102_150405"))
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%s", filename))
	c.Data(http.StatusOK, "application/gzip", data)
}

func (h *BackupHandler) RestoreDatabase(c *gin.Context) {
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": -1, "message": "restore file is required"})
		return
	}
	defer file.Close()

	payload, err := io.ReadAll(file)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": -1, "message": "failed to read restore file"})
		return
	}

	if err := h.backupService.RestoreDatabase(header.Filename, payload); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"code": -1, "message": err.Error()})
		return
	}

	c.JSON(http.StatusOK, gin.H{"code": 0, "message": "database restored successfully"})
}
