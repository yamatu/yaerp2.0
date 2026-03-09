package middleware

import (
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"

	"yaerp/internal/repo"
	"yaerp/internal/service"
	"yaerp/pkg/response"
)

// PermissionMiddleware returns a Gin middleware that verifies the
// authenticated user holds at least the required permission for
// the sheet identified by the ":id" URL parameter.
//
// perm must be one of "view", "edit", or "delete".
func PermissionMiddleware(permSvc *service.PermissionService, perm string) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("user_id")
		if userID == 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "user not authenticated"})
			return
		}

		sheetIDStr := c.Param("id")
		if sheetIDStr == "" {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "missing sheet id"})
			return
		}

		sheetID, err := strconv.ParseInt(sheetIDStr, 10, 64)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusBadRequest, gin.H{"error": "invalid sheet id"})
			return
		}

		matrix, err := permSvc.GetPermissionMatrix(sheetID, userID)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"error": "failed to check permissions"})
			return
		}

		var allowed bool
		switch perm {
		case "view":
			allowed = matrix.Sheet.CanView
		case "edit":
			allowed = matrix.Sheet.CanEdit
		case "delete":
			allowed = matrix.Sheet.CanDelete
		default:
			allowed = false
		}

		if !allowed {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "insufficient permissions"})
			return
		}

		c.Next()
	}
}

func RequireAdmin(userRepo *repo.UserRepo) gin.HandlerFunc {
	return func(c *gin.Context) {
		userID := c.GetInt64("user_id")
		if userID == 0 {
			response.Unauthorized(c, "user not authenticated")
			c.Abort()
			return
		}

		roles, err := userRepo.GetUserRoles(userID)
		if err != nil {
			response.ServerError(c, "failed to load user roles")
			c.Abort()
			return
		}

		for _, role := range roles {
			if role.Code == "admin" {
				c.Next()
				return
			}
		}

		response.Forbidden(c, "admin role required")
		c.Abort()
	}
}
