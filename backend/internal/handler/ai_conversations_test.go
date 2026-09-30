package handler

import (
	"github.com/gin-gonic/gin"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestConversationImportRejectsSwitchedLoginBeforeDatabase(t *testing.T) {
	gin.SetMode(gin.TestMode)
	response := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(response)
	context.Request = httptest.NewRequest(http.MethodPost, "/ai/conversations", strings.NewReader(`{"account_id":2,"messages":[{"role":"user","content":"private account-2 history"}]}`))
	context.Request.Header.Set("Content-Type", "application/json")
	context.Set("user_id", int64(1))
	(&AIHandler{}).CreateConversation(context) // deliberately no service: must reject before a write
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
}
