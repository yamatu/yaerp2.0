package middleware

import (
	"context"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	jwtpkg "yaerp/pkg/jwt"
)

// AuthMiddleware returns a Gin middleware that validates JWT tokens.
// It extracts the token from the Authorization header (Bearer <token>),
// verifies it with jwtUtil, checks the Redis blacklist, and injects
// "user_id" and "username" into the Gin context for downstream handlers.
func AuthMiddleware(jwtUtil *jwtpkg.JWTUtil, rdb *redis.Client) gin.HandlerFunc {
	return func(c *gin.Context) {
		authHeader := c.GetHeader("Authorization")
		if authHeader == "" {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "missing Authorization header"})
			return
		}

		parts := strings.SplitN(authHeader, " ", 2)
		if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid Authorization header format"})
			return
		}
		tokenString := parts[1]

		// Parse and validate the token.
		claims, err := jwtUtil.ParseToken(tokenString)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}

		// Check whether the token has been blacklisted (e.g. after logout).
		blacklistKey := "token:blacklist:" + tokenString
		exists, err := rdb.Exists(context.Background(), blacklistKey).Result()
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to check token status"})
			return
		}
		if exists > 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token has been revoked"})
			return
		}

		// Inject user information into the context.
		c.Set("user_id", claims.UserID)
		c.Set("username", claims.Username)

		c.Next()
	}
}
