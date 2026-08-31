package diagnostics

import (
	"database/sql"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRegisterRequiresToken(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	Register(router, true, "test-token", nil, nil, nil, nil)

	request := httptest.NewRequest("GET", "/debug/metrics", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("status without token = %d, want 403", response.Code)
	}

	request = httptest.NewRequest("GET", "/debug/metrics", nil)
	request.Header.Set("X-Pprof-Token", "test-token")
	response = httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 200 || !strings.Contains(response.Body.String(), `"memory"`) {
		t.Fatalf("authorized metrics response = %d %s", response.Code, response.Body.String())
	}
}

func TestRegisterPprofHeapRoute(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	Register(router, true, "test-token", func() sql.DBStats { return sql.DBStats{} }, func() int { return 3 }, nil, nil)
	request := httptest.NewRequest("GET", "/debug/pprof/heap", nil)
	request.Header.Set("X-Pprof-Token", "test-token")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != 200 || response.Body.Len() == 0 {
		t.Fatalf("heap response = %d, bytes=%d", response.Code, response.Body.Len())
	}
}
