package middleware

import (
	"compress/gzip"
	"io"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
)

// RequestBodyLimit caps request bodies before multipart/JSON parsers allocate
// memory. A Content-Length check rejects obviously oversized requests early;
// MaxBytesReader also covers chunked requests without a declared length.
func RequestBodyLimit(maxBytes int64) gin.HandlerFunc {
	if maxBytes <= 0 {
		return func(c *gin.Context) { c.Next() }
	}

	return func(c *gin.Context) {
		if c.Request.ContentLength > maxBytes {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{
				"error": "request body too large",
			})
			return
		}
		if c.Request.Body != nil {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxBytes)
		}
		c.Next()
	}
}

// DecompressRequestBody accepts gzip-compressed request bodies (Content-Encoding:
// gzip), which the web editor uses for its large sheet saves. The decompressed
// size is capped as well, so a small compressed body cannot expand without limit.
func DecompressRequestBody(maxBytes int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		encoding := strings.ToLower(strings.TrimSpace(c.GetHeader("Content-Encoding")))
		if encoding != "gzip" || c.Request.Body == nil {
			c.Next()
			return
		}
		reader, err := gzip.NewReader(c.Request.Body)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"code": -1, "message": "invalid gzip request body"})
			return
		}
		var body io.ReadCloser = gzipBody{Reader: reader, compressed: c.Request.Body}
		if maxBytes > 0 {
			body = http.MaxBytesReader(c.Writer, body, maxBytes)
		}
		c.Request.Body = body
		c.Request.Header.Del("Content-Encoding")
		c.Request.Header.Del("Content-Length")
		c.Request.ContentLength = -1
		c.Next()
	}
}

type gzipBody struct {
	*gzip.Reader
	compressed io.Closer
}

func (b gzipBody) Close() error {
	_ = b.Reader.Close()
	return b.compressed.Close()
}
