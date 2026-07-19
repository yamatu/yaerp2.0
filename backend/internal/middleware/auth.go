package middleware

import (
	"errors"
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
		claims, err := jwtUtil.ParseAccessToken(tokenString)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired token"})
			return
		}

		// Check whether the token has been blacklisted (e.g. after logout).
		exists, err := rdb.Exists(c.Request.Context(), jwtpkg.BlacklistKey(tokenString), "token:blacklist:"+tokenString).Result()
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to check token status"})
			return
		}
		if exists > 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "token has been revoked"})
			return
		}

		revokedBefore, err := rdb.Get(c.Request.Context(), jwtpkg.UserRevokedBeforeKey(claims.UserID)).Int64()
		if err != nil && !errors.Is(err, redis.Nil) {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to check account session status"})
			return
		}
		if err == nil && claims.IssuedAt != nil && claims.IssuedAt.Time.Unix() <= revokedBefore {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "account session has been revoked"})
			return
		}

		// Inject user information into the context.
		c.Set("user_id", claims.UserID)
		c.Set("username", claims.Username)
		c.Set("access_token", tokenString)

		c.Next()
	}
}
