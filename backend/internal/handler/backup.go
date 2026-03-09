package handler

import (
	"fmt"
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
