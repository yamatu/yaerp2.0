package diagnostics

import (
	"crypto/subtle"
	"database/sql"
	"net"
	"net/http"
	"net/http/pprof"
	"runtime"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// Register adds opt-in runtime diagnostics to the application router. The
// endpoint is intentionally disabled by default because pprof can expose
// implementation details and profile data.
func Register(r *gin.Engine, enabled bool, token string, dbStats func() sql.DBStats, clientCount func() int, droppedBroadcasts func() uint64, slowClients func() uint64) {
	if !enabled {
		return
	}

	debug := r.Group("/debug", authorize(token))
	debug.GET("/metrics", func(c *gin.Context) {
		writeMetrics(c, dbStats, clientCount, droppedBroadcasts, slowClients)
	})

	// Register the standard pprof handlers under /debug/pprof/ explicitly so
	// they work with Gin instead of relying on net/http.DefaultServeMux.
	debug.GET("/pprof", gin.WrapF(pprof.Index))
	debug.GET("/pprof/", gin.WrapF(pprof.Index))
	debug.GET("/pprof/cmdline", gin.WrapF(pprof.Cmdline))
	debug.GET("/pprof/profile", gin.WrapF(pprof.Profile))
	debug.GET("/pprof/symbol", gin.WrapF(pprof.Symbol))
	debug.POST("/pprof/symbol", gin.WrapF(pprof.Symbol))
	debug.GET("/pprof/trace", gin.WrapF(pprof.Trace))
	for _, name := range []string{"allocs", "block", "goroutine", "heap", "mutex", "threadcreate"} {
		debug.GET("/pprof/"+name, gin.WrapH(pprof.Handler(name)))
	}
}

func authorize(token string) gin.HandlerFunc {
	token = strings.TrimSpace(token)
	return func(c *gin.Context) {
		provided := c.GetHeader("X-Pprof-Token")

		if token != "" {
			if subtle.ConstantTimeCompare([]byte(provided), []byte(token)) != 1 {
				c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "pprof access denied"})
				return
			}
			c.Next()
			return
		}

		// Without a token, only a direct loopback request is accepted. This is
		// useful with `docker exec` while avoiding an accidentally public pprof
		// endpoint when the feature is enabled for a quick test.
		host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
		if err != nil {
			host = c.Request.RemoteAddr
		}
		if !isLoopback(host) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "set PPROF_TOKEN for non-loopback access"})
			return
		}
		c.Next()
	}
}

func isLoopback(host string) bool {
	ip := net.ParseIP(strings.TrimSpace(host))
	return ip != nil && ip.IsLoopback()
}

type memorySnapshot struct {
	Alloc         uint64 `json:"alloc_bytes"`
	TotalAlloc    uint64 `json:"total_alloc_bytes"`
	Sys           uint64 `json:"sys_bytes"`
	HeapAlloc     uint64 `json:"heap_alloc_bytes"`
	HeapInuse     uint64 `json:"heap_inuse_bytes"`
	HeapObjects   uint64 `json:"heap_objects"`
	NextGC        uint64 `json:"next_gc_bytes"`
	NumGC         uint32 `json:"gc_cycles"`
	NumGoroutine  int    `json:"goroutines"`
	NumCPU        int    `json:"cpus"`
	TimestampUnix int64  `json:"timestamp_unix"`
}

type metricsResponse struct {
	Timestamp           time.Time      `json:"timestamp"`
	Memory              memorySnapshot `json:"memory"`
	DB                  sql.DBStats    `json:"database"`
	WSClients           int            `json:"websocket_clients"`
	WSDroppedBroadcasts uint64         `json:"websocket_dropped_broadcasts"`
	WSSlowClients       uint64         `json:"websocket_slow_clients"`
}

func writeMetrics(c *gin.Context, dbStats func() sql.DBStats, clientCount func() int, droppedBroadcasts func() uint64, slowClients func() uint64) {
	var mem runtime.MemStats
	runtime.ReadMemStats(&mem)

	stats := sql.DBStats{}
	if dbStats != nil {
		stats = dbStats()
	}
	clients := 0
	if clientCount != nil {
		clients = clientCount()
	}
	dropped := uint64(0)
	if droppedBroadcasts != nil {
		dropped = droppedBroadcasts()
	}
	slow := uint64(0)
	if slowClients != nil {
		slow = slowClients()
	}

	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, metricsResponse{
		Timestamp: time.Now().UTC(),
		Memory: memorySnapshot{
			Alloc:         mem.Alloc,
			TotalAlloc:    mem.TotalAlloc,
			Sys:           mem.Sys,
			HeapAlloc:     mem.HeapAlloc,
			HeapInuse:     mem.HeapInuse,
			HeapObjects:   mem.HeapObjects,
			NextGC:        mem.NextGC,
			NumGC:         mem.NumGC,
			NumGoroutine:  runtime.NumGoroutine(),
			NumCPU:        runtime.NumCPU(),
			TimestampUnix: time.Now().Unix(),
		},
		DB:                  stats,
		WSClients:           clients,
		WSDroppedBroadcasts: dropped,
		WSSlowClients:       slow,
	})
}
