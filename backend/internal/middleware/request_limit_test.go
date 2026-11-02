package middleware

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func gzipped(t *testing.T, text string) []byte {
	t.Helper()
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write([]byte(text)); err != nil {
		t.Fatal(err)
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func decompressRouter(limit int64) *gin.Engine {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(RequestBodyLimit(limit), DecompressRequestBody(limit))
	router.PUT("/echo", func(c *gin.Context) {
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.String(http.StatusRequestEntityTooLarge, "too large")
			return
		}
		c.String(http.StatusOK, string(body))
	})
	return router
}

func TestDecompressRequestBody(t *testing.T) {
	payload := `{"config":{"cellData":{"1":{"0":{"v":"测试"}}}}}`
	request := httptest.NewRequest(http.MethodPut, "/echo", bytes.NewReader(gzipped(t, payload)))
	request.Header.Set("Content-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	decompressRouter(1<<20).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK || recorder.Body.String() != payload {
		t.Fatalf("got %d %q", recorder.Code, recorder.Body.String())
	}

	plain := httptest.NewRequest(http.MethodPut, "/echo", strings.NewReader(payload))
	recorder = httptest.NewRecorder()
	decompressRouter(1<<20).ServeHTTP(recorder, plain)
	if recorder.Body.String() != payload {
		t.Fatalf("an uncompressed body must pass through, got %q", recorder.Body.String())
	}
}

func TestDecompressRequestBodyLimitsTheExpandedSize(t *testing.T) {
	// 1MB of zeros compresses to about 1KB, far below the limit on the wire.
	request := httptest.NewRequest(http.MethodPut, "/echo", bytes.NewReader(gzipped(t, strings.Repeat("0", 1<<20))))
	request.Header.Set("Content-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	decompressRouter(64<<10).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("an expanding body must be cut off, got %d", recorder.Code)
	}
}

func TestDecompressRequestBodyRejectsBrokenGzip(t *testing.T) {
	request := httptest.NewRequest(http.MethodPut, "/echo", strings.NewReader("not gzip"))
	request.Header.Set("Content-Encoding", "gzip")
	recorder := httptest.NewRecorder()
	decompressRouter(1<<20).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("got %d", recorder.Code)
	}
}
