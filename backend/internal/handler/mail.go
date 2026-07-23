package handler

import (
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

const maxMailSendRequestBytes = 60 << 20

type MailHandler struct{ service *service.MailService }

func NewMailHandler(mailService *service.MailService) *MailHandler {
	return &MailHandler{service: mailService}
}

func (h *MailHandler) GetSettings(c *gin.Context) {
	settings, err := h.service.GetSettings(c.GetInt64("user_id"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, settings)
}

func (h *MailHandler) UpdateSettings(c *gin.Context) {
	var input model.MailServerSettings
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	settings, err := h.service.UpdateSettings(c.GetInt64("user_id"), &input)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, settings)
}

func (h *MailHandler) ListAccounts(c *gin.Context) {
	accounts, err := h.service.ListAccounts(c.GetInt64("user_id"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, accounts)
}

func (h *MailHandler) GetOwnAccount(c *gin.Context) {
	account, err := h.service.GetOwnAccount(c.GetInt64("user_id"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, account)
}

func (h *MailHandler) SaveOwnAccount(c *gin.Context) {
	var input model.MailAccountInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	account, err := h.service.SaveOwnAccount(c.GetInt64("user_id"), &input)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, account)
}

func (h *MailHandler) TestOwnAccount(c *gin.Context) {
	var input model.MailAccountInput
	if err := c.ShouldBindJSON(&input); err != nil && !errors.Is(err, io.EOF) {
		response.BadRequest(c, "invalid request body")
		return
	}
	result, err := h.service.TestOwnAccount(c.GetInt64("user_id"), &input)
	if err != nil {
		response.BadRequest(c, err.Error())
		return
	}
	response.OK(c, result)
}

func (h *MailHandler) DeleteOwnAccount(c *gin.Context) {
	if err := h.service.DeleteOwnAccount(c.GetInt64("user_id")); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "mail account removed")
}

func (h *MailHandler) Summary(c *gin.Context) {
	summary, err := h.service.Summary(c.GetInt64("user_id"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, summary)
}

func (h *MailHandler) ListFolders(c *gin.Context) {
	folders, err := h.service.ListFolders(c.GetInt64("user_id"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, folders)
}

func (h *MailHandler) CreateFolder(c *gin.Context) {
	var input model.MailFolderInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.CreateFolder(c.GetInt64("user_id"), input.Name); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "folder created")
}

func (h *MailHandler) RenameFolder(c *gin.Context) {
	var input model.MailFolderRenameInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.RenameFolder(c.GetInt64("user_id"), input.From, input.To); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "folder renamed")
}

func (h *MailHandler) DeleteFolder(c *gin.Context) {
	if err := h.service.DeleteFolder(c.GetInt64("user_id"), c.Query("name")); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "folder deleted")
}

func (h *MailHandler) ListMessages(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "30"))
	unread, _ := strconv.ParseBool(c.DefaultQuery("unread", "false"))
	startDate, err := parseMailDateQuery(c.Query("start_date"))
	if err != nil {
		response.BadRequest(c, "开始日期格式无效")
		return
	}
	endDate, err := parseMailDateQuery(c.Query("end_date"))
	if err != nil {
		response.BadRequest(c, "结束日期格式无效")
		return
	}
	if !startDate.IsZero() && !endDate.IsZero() && endDate.Before(startDate) {
		response.BadRequest(c, "结束日期不能早于开始日期")
		return
	}
	result, err := h.service.ListMessages(
		c.GetInt64("user_id"), c.DefaultQuery("folder", "INBOX"), page, pageSize,
		service.MailMessageListOptions{
			Query: c.Query("query"), UnreadOnly: unread, Participant: c.Query("participant"),
			Filter: c.DefaultQuery("filter", "all"), StartDate: startDate, EndDate: endDate,
			SortBy: c.DefaultQuery("sort_by", "date"), SortOrder: c.DefaultQuery("sort_order", "desc"),
		},
	)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *MailHandler) ListCorrespondence(c *gin.Context) {
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("page_size", "30"))
	result, err := h.service.ListCorrespondence(c.GetInt64("user_id"), c.Query("email"), page, pageSize)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *MailHandler) GetMessage(c *gin.Context) {
	uid, ok := mailUID(c)
	if !ok {
		return
	}
	message, err := h.service.GetMessage(c.GetInt64("user_id"), c.DefaultQuery("folder", "INBOX"), uid)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, message)
}

func (h *MailHandler) DownloadAttachment(c *gin.Context) {
	uid, ok := mailUID(c)
	if !ok {
		return
	}
	filename, contentType, data, err := h.service.DownloadAttachment(
		c.GetInt64("user_id"), c.DefaultQuery("folder", "INBOX"), uid, c.Param("partId"),
	)
	if err != nil {
		handleMailError(c, err)
		return
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	disposition := mime.FormatMediaType("attachment", map[string]string{"filename": filename})
	c.Header("Content-Type", contentType)
	c.Header("Content-Disposition", disposition)
	c.Header("Cache-Control", "private, no-store")
	c.Data(http.StatusOK, contentType, data)
}

func (h *MailHandler) UpdateFlags(c *gin.Context) {
	uid, ok := mailUID(c)
	if !ok {
		return
	}
	var input model.MailFlagInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.UpdateFlags(c.GetInt64("user_id"), uid, &input); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "mail flags updated")
}

func (h *MailHandler) MoveMessage(c *gin.Context) {
	uid, ok := mailUID(c)
	if !ok {
		return
	}
	var input model.MailMoveInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid request body")
		return
	}
	if err := h.service.MoveMessage(c.GetInt64("user_id"), uid, &input); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "message moved")
}

func (h *MailHandler) DeleteMessage(c *gin.Context) {
	uid, ok := mailUID(c)
	if !ok {
		return
	}
	if err := h.service.DeleteMessage(c.GetInt64("user_id"), uid, c.DefaultQuery("folder", "INBOX")); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "message deleted")
}

func (h *MailHandler) BatchMessages(c *gin.Context) {
	var input model.MailBatchInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid batch mail request")
		return
	}
	if err := h.service.BatchMessages(c.GetInt64("user_id"), &input); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "batch mail operation completed")
}

func (h *MailHandler) ListContacts(c *gin.Context) {
	contacts, err := h.service.ListContacts(c.GetInt64("user_id"), c.Query("query"))
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, contacts)
}

func (h *MailHandler) SaveContact(c *gin.Context) {
	var input model.MailContactInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid mail contact")
		return
	}
	contact, err := h.service.SaveContact(c.GetInt64("user_id"), &input)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, contact)
}

func (h *MailHandler) UpdateContact(c *gin.Context) {
	contactID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || contactID <= 0 {
		response.BadRequest(c, "invalid mail contact")
		return
	}
	var input model.MailContactInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid mail contact")
		return
	}
	contact, err := h.service.UpdateContact(c.GetInt64("user_id"), contactID, &input)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, contact)
}

func (h *MailHandler) DeleteContact(c *gin.Context) {
	contactID, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || contactID <= 0 {
		response.BadRequest(c, "invalid mail contact")
		return
	}
	if err := h.service.DeleteContact(c.GetInt64("user_id"), contactID); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "mail contact deleted")
}

func (h *MailHandler) Translate(c *gin.Context) {
	var input model.MailTranslateInput
	if err := c.ShouldBindJSON(&input); err != nil {
		response.BadRequest(c, "invalid mail translation request")
		return
	}
	result, err := h.service.TranslateText(c.GetInt64("user_id"), &input)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, result)
}

func (h *MailHandler) RunForwarding(c *gin.Context) {
	if err := h.service.RunForwardingNow(c.GetInt64("user_id")); err != nil {
		handleMailError(c, err)
		return
	}
	response.OKMsg(c, "mail forwarding check completed")
}

func (h *MailHandler) SendMessage(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxMailSendRequestBytes)
	if err := c.Request.ParseMultipartForm(8 << 20); err != nil {
		response.BadRequest(c, "邮件或附件过大")
		return
	}
	var input model.MailSendInput
	if err := json.Unmarshal([]byte(c.PostForm("payload")), &input); err != nil {
		response.BadRequest(c, "invalid mail payload")
		return
	}
	attachments := make([]service.MailOutgoingAttachment, 0)
	if c.Request.MultipartForm != nil {
		for _, header := range c.Request.MultipartForm.File["attachments"] {
			file, err := header.Open()
			if err != nil {
				response.BadRequest(c, "附件读取失败")
				return
			}
			data, readErr := io.ReadAll(io.LimitReader(file, maxMailSendRequestBytes+1))
			_ = file.Close()
			if readErr != nil || len(data) > maxMailSendRequestBytes {
				response.BadRequest(c, "附件读取失败或文件过大")
				return
			}
			contentType := header.Header.Get("Content-Type")
			if contentType == "" {
				contentType = http.DetectContentType(data)
			}
			attachments = append(attachments, service.MailOutgoingAttachment{Filename: header.Filename, ContentType: contentType, Data: data})
		}
	}
	result, err := h.service.SendMessage(c.GetInt64("user_id"), &input, attachments)
	if err != nil {
		handleMailError(c, err)
		return
	}
	response.OK(c, result)
}

func mailUID(c *gin.Context) (uint32, bool) {
	value, err := strconv.ParseUint(c.Param("uid"), 10, 32)
	if err != nil || value == 0 {
		response.BadRequest(c, "invalid mail uid")
		return 0, false
	}
	return uint32(value), true
}

func parseMailDateQuery(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, nil
	}
	return time.ParseInLocation("2006-01-02", value, time.Local)
}

func handleMailError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, service.ErrMailAccessDenied):
		response.Forbidden(c, err.Error())
	case errors.Is(err, service.ErrMailMessageNotFound):
		response.NotFound(c, err.Error())
	case errors.Is(err, service.ErrMailNotConfigured), errors.Is(err, service.ErrMailDisabled), errors.Is(err, service.ErrMailAccountNotConfigured):
		response.BadRequest(c, err.Error())
	default:
		message := strings.TrimSpace(err.Error())
		if message == "" {
			message = "mail operation failed"
		}
		response.BadRequest(c, message)
	}
}
