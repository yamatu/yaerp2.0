package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const maxRateLimitEntries = 10000

// ipCounter tracks request counts for a single IP address within a
// one-minute window.
type ipCounter struct {
	count     int
	expiresAt time.Time
}

// RateLimitMiddleware returns a Gin middleware that enforces a simple
// token-bucket-style rate limit per client IP address. Each IP is
// allowed requestsPerMinute requests in a rolling one-minute window.
// A background goroutine periodically purges expired entries from the
// in-memory map to prevent unbounded growth.
func RateLimitMiddleware(requestsPerMinute int) gin.HandlerFunc {
	if requestsPerMinute <= 0 {
		requestsPerMinute = 100
	}

	var mu sync.Mutex
	counters := make(map[string]*ipCounter)

	// Background cleanup: remove expired entries every 2 minutes.
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		defer ticker.Stop()
		for range ticker.C {
			now := time.Now()
			mu.Lock()
			for ip, c := range counters {
				if now.After(c.expiresAt) {
					delete(counters, ip)
				}
			}
			mu.Unlock()
		}
	}()

	return func(c *gin.Context) {
		if c.Request.URL.Path == "/ws" {
			c.Next()
			return
		}

		ip := c.ClientIP()
		limit := requestsPerMinute
		key := ip

		authHeader := c.GetHeader("Authorization")
		if token, ok := strings.CutPrefix(authHeader, "Bearer "); ok && strings.TrimSpace(token) != "" {
			digest := sha256.Sum256([]byte(strings.TrimSpace(token)))
			key = "token:" + hex.EncodeToString(digest[:])
			limit = requestsPerMinute * 10
		}

		now := time.Now()

		mu.Lock()
		entry, exists := counters[key]
		if !exists || now.After(entry.expiresAt) {
			if !exists && len(counters) >= maxRateLimitEntries {
				for oldKey, counter := range counters {
					if now.After(counter.expiresAt) {
						delete(counters, oldKey)
					}
				}
				if len(counters) >= maxRateLimitEntries {
					mu.Unlock()
					c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{"error": "rate limiter is busy, please try again later"})
					return
				}
			}
			// First request or window expired – start a new window.
			counters[key] = &ipCounter{
				count:     1,
				expiresAt: now.Add(1 * time.Minute),
			}
			mu.Unlock()
			c.Next()
			return
		}

		if entry.count >= limit {
			mu.Unlock()
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"error": "rate limit exceeded, please try again later",
			})
			return
		}

		entry.count++
		mu.Unlock()

		c.Next()
	}
}
