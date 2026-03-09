package middleware

import (
	"time"

	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

// CORSMiddleware returns a Gin middleware that handles Cross-Origin
// Resource Sharing. In development mode it permits all origins; in
// production the caller supplies an explicit allow-list.
func CORSMiddleware(allowedOrigins []string) gin.HandlerFunc {
	config := cors.Config{
		AllowMethods: []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowHeaders: []string{
			"Origin",
			"Content-Type",
			"Content-Length",
			"Accept",
			"Accept-Encoding",
			"Authorization",
			"X-Requested-With",
		},
		ExposeHeaders:    []string{"Content-Length", "Content-Type"},
		AllowCredentials: true,
		MaxAge:           12 * time.Hour,
	}

	if len(allowedOrigins) == 0 || (len(allowedOrigins) == 1 && allowedOrigins[0] == "*") {
		// Development mode: allow every origin.
		config.AllowAllOrigins = true
		config.AllowCredentials = false
	} else {
		config.AllowOrigins = allowedOrigins
		config.AllowCredentials = true
	}

	return cors.New(config)
}
