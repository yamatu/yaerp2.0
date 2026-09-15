package handler

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"

	"yaerp/internal/model"
	"yaerp/internal/service"
)

type stubAttachmentStore struct{}

func (stubAttachmentStore) StoreOrReuseFile(string, string, []byte, int64) (*model.Attachment, string, error) {
	return &model.Attachment{ID: 1}, "/api/files/1/content?signature=stub", nil
}

func newAttachmentLinkRouter(mailService *service.MailService) *gin.Engine {
	handler := NewMailHandler(mailService)
	router := gin.New()
	router.GET("/mail/messages/:uid/attachments/:partId/link", func(c *gin.Context) {
		c.Set("user_id", int64(7))
		handler.AttachmentLink(c)
	})
	return router
}

func TestAttachmentLinkValidatesUID(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/mail/messages/0/attachments/1/link", nil)
	newAttachmentLinkRouter(service.NewMailService(nil, nil, "test-secret")).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for an invalid uid, got %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestAttachmentLinkFailsWithoutStore(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/mail/messages/5/attachments/1/link", nil)
	newAttachmentLinkRouter(service.NewMailService(nil, nil, "test-secret")).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected the store error to surface as 400, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "signature") {
		t.Fatalf("must not return a link without an attachment store: %s", recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), "附件存储") {
		t.Fatalf("unexpected body: %s", recorder.Body.String())
	}
}

func TestAttachmentLinkRejectsEmptyPart(t *testing.T) {
	gin.SetMode(gin.TestMode)
	mailService := service.NewMailService(nil, nil, "test-secret")
	mailService.SetAttachmentStore(stubAttachmentStore{})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/mail/messages/5/attachments/%20/link", nil)
	newAttachmentLinkRouter(mailService).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusBadRequest && recorder.Code != http.StatusInternalServerError {
		t.Fatalf("expected an error for an empty part id, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if strings.Contains(recorder.Body.String(), "signature") {
		t.Fatalf("empty part id must not return a link: %s", recorder.Body.String())
	}
}
