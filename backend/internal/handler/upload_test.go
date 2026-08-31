package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

type deniedPaymentAttachmentAuthorizer struct{}

func (deniedPaymentAttachmentAuthorizer) AuthorizePaymentAttachment(_, _ int64) (bool, bool, error) {
	return true, false, nil
}

func TestGetFileRejectsProtectedPaymentAttachment(t *testing.T) {
	gin.SetMode(gin.TestMode)
	handler := NewUploadHandler(nil, deniedPaymentAttachmentAuthorizer{})
	router := gin.New()
	router.GET("/api/files/:id", func(c *gin.Context) {
		c.Set("user_id", int64(7))
		handler.GetFile(c)
	})

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/files/42", nil)
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected protected payment attachment to return 403, got %d: %s", recorder.Code, recorder.Body.String())
	}
}
