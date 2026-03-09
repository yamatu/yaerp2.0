package main

import (
	"database/sql"
	"fmt"
	"log"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"

	"yaerp/config"
	"yaerp/internal/handler"
	"yaerp/internal/middleware"
	"yaerp/internal/repo"
	"yaerp/internal/service"
	"yaerp/internal/ws"
	jwtpkg "yaerp/pkg/jwt"
	miniopkg "yaerp/pkg/minio"
)

func main() {
	cfg := config.Load()

	// Database
	dsn := fmt.Sprintf("host=%s port=%d user=%s password=%s dbname=%s sslmode=disable",
		cfg.Postgres.Host, cfg.Postgres.Port, cfg.Postgres.User, cfg.Postgres.Password, cfg.Postgres.DB)
	db, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatalf("Failed to connect to database: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("Failed to ping database: %v", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	log.Println("Database connected")

	// Redis
	rdb := redis.NewClient(&redis.Options{
		Addr:     fmt.Sprintf("%s:%d", cfg.Redis.Host, cfg.Redis.Port),
		Password: cfg.Redis.Password,
	})
	log.Println("Redis connected")

	// MinIO
	minioClient, err := miniopkg.New(
		cfg.MinIO.Endpoint, cfg.MinIO.AccessKey, cfg.MinIO.SecretKey,
		cfg.MinIO.Bucket, cfg.MinIO.UseSSL, cfg.MinIO.PublicEndpoint,
	)
	if err != nil {
		log.Fatalf("Failed to connect to MinIO: %v", err)
	}
	log.Println("MinIO connected")

	// JWT
	jwtUtil := jwtpkg.New(cfg.JWT.Secret, cfg.JWT.ExpireHours, cfg.JWT.RefreshHours)

	// Repos
	userRepo := repo.NewUserRepo(db)
	sheetRepo := repo.NewSheetRepo(db)
	permRepo := repo.NewPermissionRepo(db)
	attachRepo := repo.NewAttachmentRepo(db)
	folderRepo := repo.NewFolderRepo(db)

	// Services
	authService := service.NewAuthService(userRepo, jwtUtil, rdb)
	sheetService := service.NewSheetService(sheetRepo)
	permService := service.NewPermissionService(permRepo, userRepo)
	uploadService := service.NewUploadService(minioClient, attachRepo)
	folderService := service.NewFolderService(folderRepo, userRepo)
	backupService := service.NewBackupService(cfg)
	aiService := service.NewAIService(cfg, db)

	// Handlers
	authHandler := handler.NewAuthHandler(authService)
	sheetHandler := handler.NewSheetHandler(sheetService)
	cellHandler := handler.NewCellHandler(sheetService, permService)
	uploadHandler := handler.NewUploadHandler(uploadService)
	userHandler := handler.NewUserHandler(userRepo, authService)
	roleHandler := handler.NewRoleHandler(db)
	permHandler := handler.NewPermissionHandler(permService)
	folderHandler := handler.NewFolderHandler(folderService)
	backupHandler := handler.NewBackupHandler(backupService)
	aiHandler := handler.NewAIHandler(aiService)

	// WebSocket
	hub := ws.NewHub()
	go hub.Run()
	wsHandler := ws.NewWSHandler(hub, jwtUtil)

	// Router
	gin.SetMode(cfg.Server.Mode)
	r := gin.Default()

	// Middleware
	r.Use(middleware.CORSMiddleware([]string{"*"}))
	r.Use(middleware.RateLimitMiddleware(100))

	// Public routes
	auth := r.Group("/api/auth")
	{
		auth.POST("/login", authHandler.Login)
		auth.POST("/register", authHandler.Register)
		auth.POST("/refresh", authHandler.RefreshToken)
	}

	// Protected routes
	api := r.Group("/api")
	api.Use(middleware.AuthMiddleware(jwtUtil, rdb))
	{
		api.GET("/auth/me", authHandler.Me)
		api.POST("/auth/logout", authHandler.Logout)

		// Workbooks
		api.GET("/workbooks", sheetHandler.ListWorkbooks)
		api.POST("/workbooks", sheetHandler.CreateWorkbook)
		api.GET("/workbooks/:id", sheetHandler.GetWorkbook)
		api.PUT("/workbooks/:id", sheetHandler.UpdateWorkbook)
		api.DELETE("/workbooks/:id", sheetHandler.DeleteWorkbook)

		// Sheets
		api.POST("/workbooks/:id/sheets", sheetHandler.CreateSheet)
		api.PUT("/sheets/:id", sheetHandler.UpdateSheet)
		api.DELETE("/sheets/:id", sheetHandler.DeleteSheet)
		api.GET("/sheets/:id/data", sheetHandler.GetSheetData)
		api.GET("/sheets/:id/permissions", permHandler.GetPermissionMatrix)

		// Cells
		api.POST("/sheets/:id/cells", cellHandler.BatchUpdate)
		api.POST("/sheets/:id/rows", cellHandler.InsertRow)
		api.DELETE("/sheets/:id/rows/:index", cellHandler.DeleteRow)

		// Upload
		api.POST("/upload", uploadHandler.Upload)
		api.GET("/files/:id", uploadHandler.GetFile)
		api.GET("/attachments/images", uploadHandler.ListImages)

		// Folders
		api.POST("/folders", folderHandler.CreateFolder)
		api.GET("/folders", folderHandler.ListContents)
		api.PUT("/folders/:id", folderHandler.UpdateFolder)
		api.DELETE("/folders/:id", folderHandler.DeleteFolder)
		api.GET("/folders/:id/breadcrumb", folderHandler.GetBreadcrumb)
		api.PUT("/workbooks/:id/move", folderHandler.MoveWorkbook)

		// AI Chat
		api.POST("/ai/chat", aiHandler.Chat)

		admin := api.Group("")
		admin.Use(middleware.RequireAdmin(userRepo))
		{
			// Users
			admin.GET("/users", userHandler.ListUsers)
			admin.PUT("/users/:id", userHandler.UpdateUser)
			admin.DELETE("/users/:id", userHandler.DeleteUser)
			admin.POST("/users/:id/roles", userHandler.AssignRoles)

			// Roles
			admin.GET("/roles", roleHandler.ListRoles)
			admin.POST("/roles", roleHandler.CreateRole)
			admin.PUT("/roles/:id", roleHandler.UpdateRole)
			admin.DELETE("/roles/:id", roleHandler.DeleteRole)

			// Permissions
			admin.POST("/permissions/sheet", permHandler.SetSheetPermission)
			admin.POST("/permissions/cell", permHandler.SetCellPermission)

			// Attachments (admin)
			admin.DELETE("/attachments/:id", uploadHandler.DeleteFile)

			// Folder visibility (admin)
			admin.POST("/folders/:id/visibility", folderHandler.SetVisibility)

			// Backup (admin)
			admin.GET("/admin/backup/database", backupHandler.DownloadDatabase)
			admin.GET("/admin/backup/config", backupHandler.DownloadConfig)
			admin.GET("/admin/backup/combined", backupHandler.DownloadCombined)

			// AI Config (admin)
			admin.GET("/admin/ai/config", aiHandler.GetConfig)
			admin.PUT("/admin/ai/config", aiHandler.UpdateConfig)
		}
	}

	// WebSocket
	r.GET("/ws", wsHandler.HandleWS)

	log.Printf("Server starting on port %s", cfg.Server.Port)
	if err := r.Run(":" + cfg.Server.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
