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
	"yaerp/migrations"
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
	if err := migrations.Apply(db); err != nil {
		log.Fatalf("Failed to apply migrations: %v", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
	log.Println("Database connected and migrations applied")

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
	scheduleRepo := repo.NewAIScheduleRepo(db)

	// Services
	authService := service.NewAuthService(userRepo, jwtUtil, rdb)
	permService := service.NewPermissionService(permRepo, userRepo, sheetRepo, folderRepo)
	sheetService := service.NewSheetService(sheetRepo, permService)
	uploadService := service.NewUploadService(minioClient, attachRepo, cfg.JWT.Secret)
	folderService := service.NewFolderService(folderRepo, userRepo, sheetRepo, permService)
	backupService := service.NewBackupService(cfg, db)
	scheduleService := service.NewAIScheduleService(scheduleRepo)
	aiService := service.NewAIService(cfg, db, sheetRepo, sheetService, permService, uploadService, scheduleService)
	scheduleService.SetReportGenerator(aiService.GenerateSheetReport)
	if err := scheduleService.Start(); err != nil {
		log.Fatalf("failed to start AI schedule service: %v", err)
	}

	// WebSocket
	hub := ws.NewHub()
	go hub.Run()
	wsHandler := ws.NewWSHandler(hub, jwtUtil, permService, sheetService)

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
	aiHandler := handler.NewAIHandler(aiService, hub)

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
	r.GET("/api/files/:id/content", uploadHandler.ServeFile)

	// Protected routes
	api := r.Group("/api")
	api.Use(middleware.AuthMiddleware(jwtUtil, rdb))
	{
		api.GET("/auth/me", authHandler.Me)
		api.POST("/auth/logout", authHandler.Logout)
		api.POST("/auth/change-password", authHandler.ChangePassword)

		// Workbooks
		api.GET("/workbooks", sheetHandler.ListWorkbooks)
		api.POST("/workbooks", sheetHandler.CreateWorkbook)
		api.GET("/workbooks/:id", sheetHandler.GetWorkbook)
		api.PUT("/workbooks/:id", sheetHandler.UpdateWorkbook)
		api.DELETE("/workbooks/:id", sheetHandler.DeleteWorkbook)

		// Sheets
		api.POST("/workbooks/:id/sheets", sheetHandler.CreateSheet)

		// Cells
		sheetView := api.Group("/sheets/:id")
		sheetView.Use(middleware.PermissionMiddleware(permService, "view"))
		{
			sheetView.GET("/data", sheetHandler.GetSheetData)
			sheetView.GET("/permissions", permHandler.GetPermissionMatrix)
			sheetView.GET("/protections", sheetHandler.GetProtections)
		}

		sheetEdit := api.Group("/sheets/:id")
		sheetEdit.Use(middleware.PermissionMiddleware(permService, "edit"))
		{
			sheetEdit.PUT("", sheetHandler.UpdateSheet)
			sheetEdit.POST("/protections", sheetHandler.UpdateProtection)
			sheetEdit.POST("/cells", cellHandler.BatchUpdate)
			sheetEdit.POST("/rows", cellHandler.InsertRow)
			sheetEdit.DELETE("/rows/:index", cellHandler.DeleteRow)
		}

		sheetDelete := api.Group("/sheets/:id")
		sheetDelete.Use(middleware.PermissionMiddleware(permService, "delete"))
		{
			sheetDelete.DELETE("", sheetHandler.DeleteSheet)
		}

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
		api.GET("/folders/shared", folderHandler.ListSharedFolders)
		api.GET("/folders/:id/shares", folderHandler.GetShares)
		api.GET("/folders/:id/shareable-users", folderHandler.GetShareableUsers)
		api.PUT("/folders/:id/shares", folderHandler.SetShares)
		api.PUT("/workbooks/:id/move", folderHandler.MoveWorkbook)

		// AI Chat
		api.POST("/ai/chat", aiHandler.Chat)
		api.POST("/ai/spreadsheet/apply", aiHandler.ApplySpreadsheetPlan)

		admin := api.Group("")
		admin.Use(middleware.RequireAdmin(userRepo))
		{
			// Users
			admin.GET("/users", userHandler.ListUsers)
			admin.PUT("/users/:id", userHandler.UpdateUser)
			admin.DELETE("/users/:id", userHandler.DeleteUser)
			admin.POST("/users/:id/roles", userHandler.AssignRoles)
			admin.POST("/users/:id/password", userHandler.ResetPassword)

			// Roles
			admin.GET("/roles", roleHandler.ListRoles)
			admin.POST("/roles", roleHandler.CreateRole)
			admin.PUT("/roles/:id", roleHandler.UpdateRole)
			admin.DELETE("/roles/:id", roleHandler.DeleteRole)

			// Permissions
			admin.POST("/permissions/sheet", permHandler.SetSheetPermission)
			admin.POST("/permissions/user-sheet", permHandler.SetUserSheetPermission)
			admin.POST("/permissions/cell", permHandler.SetCellPermission)
			admin.GET("/permissions/sheets/:id/roles/:roleId", permHandler.GetPermissionMatrixForRole)
			admin.GET("/permissions/sheets/:id/users", permHandler.ListUserSheetPermissions)
			admin.GET("/permissions/sheets/:id/users/:userId", permHandler.GetPermissionMatrixForUser)
			admin.POST("/workbooks/:id/assign", sheetHandler.AssignWorkbook)

			// Attachments (admin)
			admin.DELETE("/attachments/:id", uploadHandler.DeleteFile)

			// Folder visibility (admin)
			admin.POST("/folders/:id/visibility", folderHandler.SetVisibility)

			// Backup (admin)
			admin.GET("/admin/backup/database", backupHandler.DownloadDatabase)
			admin.GET("/admin/backup/config", backupHandler.DownloadConfig)
			admin.GET("/admin/backup/combined", backupHandler.DownloadCombined)
			admin.POST("/admin/backup/restore", backupHandler.RestoreDatabase)

			// AI Config (admin)
			admin.GET("/admin/ai/config", aiHandler.GetConfig)
			admin.PUT("/admin/ai/config", aiHandler.UpdateConfig)
			admin.POST("/admin/ai/spreadsheet/preview", aiHandler.PreviewSpreadsheetPlan)
			admin.POST("/admin/ai/spreadsheet/apply", aiHandler.ApplySpreadsheetPlan)
		}
	}

	// WebSocket
	r.GET("/ws", wsHandler.HandleWS)

	log.Printf("Server starting on port %s", cfg.Server.Port)
	if err := r.Run(":" + cfg.Server.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
