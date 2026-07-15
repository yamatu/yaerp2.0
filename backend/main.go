package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"

	"github.com/gin-gonic/gin"
	_ "github.com/lib/pq"
	"github.com/redis/go-redis/v9"

	"yaerp/config"
	"yaerp/internal/handler"
	"yaerp/internal/middleware"
	"yaerp/internal/model"
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
	departmentRepo := repo.NewDepartmentRepo(db)
	attachRepo := repo.NewAttachmentRepo(db)
	folderRepo := repo.NewFolderRepo(db)
	channelRepo := repo.NewChannelRepo(db)
	whatsAppRepo := repo.NewWhatsAppRepo(db)
	scheduleRepo := repo.NewAIScheduleRepo(db)

	// Services
	authService := service.NewAuthService(userRepo, jwtUtil, rdb)
	permService := service.NewPermissionService(permRepo, userRepo, sheetRepo, folderRepo, departmentRepo)
	departmentService := service.NewDepartmentService(departmentRepo, userRepo)
	sheetService := service.NewSheetService(sheetRepo, permService)
	uploadService := service.NewUploadService(minioClient, attachRepo, channelRepo, cfg.JWT.Secret)
	go func() {
		updated, removed, err := uploadService.BackfillGalleryContentHashes()
		if err != nil {
			log.Printf("backfill gallery content hashes: %v", err)
		}
		if updated > 0 || removed > 0 {
			log.Printf("gallery hash maintenance completed: hashed=%d duplicate_links_removed=%d", updated, removed)
		}
	}()
	channelService := service.NewChannelService(channelRepo, uploadService, sheetService, permService, userRepo)
	whatsAppService := service.NewWhatsAppService(
		whatsAppRepo, channelRepo, uploadService, sheetService, permService,
		cfg.WhatsApp.ServiceURL, cfg.WhatsApp.InternalSecret, cfg.JWT.Secret,
	)
	importService := service.NewSheetImportService(sheetRepo, sheetService, uploadService)
	channelService.SetImportService(importService)
	folderService := service.NewFolderService(folderRepo, userRepo, sheetRepo, permService)
	backupService := service.NewBackupService(cfg, db, minioClient)
	scheduleService := service.NewAIScheduleService(scheduleRepo)
	aiService := service.NewAIService(cfg, db, sheetRepo, sheetService, permService, uploadService, scheduleService)
	channelService.SetAIService(aiService)
	scheduleService.SetReportGenerator(aiService.GenerateSheetReport)
	if err := scheduleService.Start(); err != nil {
		log.Fatalf("failed to start AI schedule service: %v", err)
	}

	// WebSocket
	hub := ws.NewHub()
	go hub.Run()
	broadcastChannelMessage := func(message *model.ChannelMessage) {
		if message == nil {
			return
		}
		payload, _ := json.Marshal(ws.Message{Type: "channel_message", ChannelID: message.ChannelID, MessageID: message.ID})
		hub.BroadcastAll(payload)
	}
	channelService.SetMessageCreatedHook(func(userID int64, message *model.ChannelMessage) {
		broadcastChannelMessage(message)
		if err := whatsAppService.ForwardChannelMessage(userID, message.ChannelID, message.ID); err != nil {
			log.Printf("forward channel message %d to WhatsApp: %v", message.ID, err)
		}
	})
	channelService.SetMessageChangedHook(broadcastChannelMessage)
	channelService.SetMessageEditedHook(func(userID int64, message *model.ChannelMessage) {
		if err := whatsAppService.EditForwardedChannelMessage(userID, message.ChannelID, message.ID, message.Content); err != nil {
			log.Printf("edit channel message %d on WhatsApp: %v", message.ID, err)
		}
	})
	whatsAppService.SetInboundHook(broadcastChannelMessage)
	channelService.SetChannelReadHook(func(userID, channelID int64) {
		if err := whatsAppService.MarkChannelSeen(userID, channelID); err != nil {
			log.Printf("mark WhatsApp channel %d seen: %v", channelID, err)
		}
	})
	wsHandler := ws.NewWSHandler(hub, jwtUtil, permService, sheetService)

	// Handlers
	authHandler := handler.NewAuthHandler(authService)
	sheetHandler := handler.NewSheetHandler(sheetService, hub)
	cellHandler := handler.NewCellHandler(sheetService, permService)
	uploadHandler := handler.NewUploadHandler(uploadService)
	channelHandler := handler.NewChannelHandler(channelService, uploadService, hub)
	whatsAppHandler := handler.NewWhatsAppHandler(whatsAppService)
	importHandler := handler.NewImportHandler(importService)
	userHandler := handler.NewUserHandler(userRepo, authService, uploadService)
	roleHandler := handler.NewRoleHandler(db)
	permHandler := handler.NewPermissionHandler(permService)
	departmentHandler := handler.NewDepartmentHandler(departmentService)
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
	r.GET("/api/whatsapp/avatar/:userId/:chatId", whatsAppHandler.ServeAvatar)
	r.POST("/api/internal/whatsapp/events", whatsAppHandler.Webhook)

	// Protected routes
	api := r.Group("/api")
	api.Use(middleware.AuthMiddleware(jwtUtil, rdb))
	{
		api.GET("/auth/me", authHandler.Me)
		api.POST("/auth/logout", authHandler.Logout)
		api.POST("/auth/change-password", authHandler.ChangePassword)
		api.PUT("/auth/avatar", userHandler.UpdateOwnAvatar)
		api.GET("/users/shareable", userHandler.ListShareableUsers)
		api.GET("/departments", departmentHandler.List)

		// Workbooks
		api.GET("/workbooks", sheetHandler.ListWorkbooks)
		api.POST("/workbooks", sheetHandler.CreateWorkbook)
		api.POST("/workbooks/import/xlsx", importHandler.ImportWorkbookXLSX)
		api.PUT("/workbooks/state/batch", sheetHandler.UpdateWorkbookStates)
		api.GET("/workbooks/:id/source/xlsx", importHandler.DownloadWorkbookSourceXLSX)
		api.GET("/workbooks/:id/export", sheetHandler.ExportWorkbook)
		api.GET("/workbooks/:id/export/pdf", sheetHandler.ExportWorkbookPDF)
		api.GET("/workbooks/:id", sheetHandler.GetWorkbook)
		api.PUT("/workbooks/:id", sheetHandler.UpdateWorkbook)
		api.PUT("/workbooks/:id/state", sheetHandler.UpdateWorkbookState)
		api.DELETE("/workbooks/:id", sheetHandler.DeleteWorkbook)

		// Sheets
		api.POST("/workbooks/:id/sheets", sheetHandler.CreateSheet)

		// Cells
		sheetView := api.Group("/sheets/:id")
		sheetView.Use(middleware.PermissionMiddleware(permService, "view"))
		{
			sheetView.GET("", sheetHandler.GetSheet)
			sheetView.GET("/data", sheetHandler.GetSheetData)
			sheetView.GET("/permissions", permHandler.GetPermissionMatrix)
			sheetView.GET("/protections", sheetHandler.GetProtections)
			sheetView.GET("/export", sheetHandler.ExportSheet)
			sheetView.GET("/export/pdf", sheetHandler.ExportSheetPDF)
		}

		sheetEdit := api.Group("/sheets/:id")
		sheetEdit.Use(middleware.PermissionMiddleware(permService, "edit"))
		{
			sheetEdit.PUT("", sheetHandler.UpdateSheet)
			sheetEdit.POST("/protections", sheetHandler.UpdateProtection)
			sheetEdit.POST("/protections/batch", sheetHandler.UpdateProtectionBatch)
			sheetEdit.PUT("/state", sheetHandler.UpdateSheetState)
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
		api.GET("/gallery/directories", channelHandler.ListGalleryDirectories)
		api.POST("/gallery/directories", channelHandler.CreateGalleryDirectory)
		api.GET("/gallery/directories/:id/access", channelHandler.GetGalleryDirectoryAccess)
		api.PUT("/gallery/directories/:id/access", channelHandler.UpdateGalleryDirectoryAccess)
		api.POST("/gallery/upload", channelHandler.UploadGalleryImage)
		api.PUT("/gallery/images/:id/name", channelHandler.RenameGalleryImage)
		api.GET("/sheets/template", importHandler.DownloadTemplate)
		api.POST("/workbooks/:id/import/xlsx", importHandler.ImportXLSX)

		// Channels
		api.GET("/channels", channelHandler.ListChannels)
		api.POST("/channels", channelHandler.CreateChannel)
		api.POST("/channels/ai/private", channelHandler.OpenAIPrivateChannel)
		api.GET("/channels/search/messages", channelHandler.SearchMessages)
		api.GET("/channel-backups", channelHandler.ListBackups)
		api.GET("/channel-backups/:backupId/restores", channelHandler.ListBackupRestores)
		api.DELETE("/channel-backups/:backupId", channelHandler.DeleteBackup)
		api.PUT("/channels/:id", channelHandler.UpdateChannel)
		api.DELETE("/channels/:id", channelHandler.DeleteChannel)
		api.GET("/channels/:id/members", channelHandler.ListMembers)
		api.POST("/channels/:id/members", channelHandler.AddMembers)
		api.DELETE("/channels/:id/members/:userId", channelHandler.RemoveMember)
		api.GET("/channels/:id/ai-members", channelHandler.ListAIMembers)
		api.PUT("/channels/:id/ai-members", channelHandler.SetAIMembers)
		api.POST("/channels/:id/ai/ask", channelHandler.AskAI)
		api.POST("/channels/:id/pin", channelHandler.SetPinned)
		api.PUT("/channels/pins/order", channelHandler.ReorderPinnedChannels)
		api.PUT("/channels/:id/avatar", channelHandler.UpdateChannelAvatar)
		api.POST("/channels/:id/read", channelHandler.MarkChannelRead)
		api.GET("/channels/:id/messages", channelHandler.ListMessages)
		api.POST("/channels/:id/messages", channelHandler.CreateMessage)
		api.POST("/channels/:id/messages/:messageId/forward", channelHandler.ForwardMessage)
		api.POST("/channels/:id/messages/:messageId/recall", channelHandler.RecallMessage)
		api.PUT("/channels/:id/messages/:messageId", channelHandler.EditMessage)
		api.POST("/channels/:id/messages/:messageId/translate", channelHandler.TranslateMessage)
		api.POST("/channels/:id/messages/:messageId/import-workbook", channelHandler.ImportMessageWorkbook)
		api.POST("/channels/:id/messages/:messageId/save-image", channelHandler.SaveMessageImage)
		api.POST("/channels/:id/backups", channelHandler.CreateBackup)
		api.POST("/channels/:id/backups/:backupId/restore", channelHandler.RestoreBackup)
		api.GET("/channels/:id/whatsapp-link", whatsAppHandler.GetChannelLink)
		api.PUT("/channels/:id/whatsapp-link", whatsAppHandler.UpdateChannelLink)
		api.DELETE("/channels/:id/whatsapp-link", whatsAppHandler.DeleteChannelLink)
		api.POST("/channels/:id/whatsapp/sync-history", whatsAppHandler.SyncChannelHistory)
		api.POST("/channels/:id/messages/:messageId/whatsapp", whatsAppHandler.SendChannelMessage)
		api.GET("/whatsapp/account", whatsAppHandler.GetOwnAccount)
		api.PUT("/whatsapp/account/preferences", whatsAppHandler.UpdateOwnPreferences)
		api.PUT("/whatsapp/account/about", whatsAppHandler.UpdateOwnAbout)
		api.POST("/whatsapp/account/start", whatsAppHandler.StartOwnAccount)
		api.POST("/whatsapp/account/restart", whatsAppHandler.RestartOwnAccount)
		api.POST("/whatsapp/account/logout", whatsAppHandler.LogoutOwnAccount)
		api.GET("/whatsapp/chats", whatsAppHandler.ListOwnChats)
		api.POST("/whatsapp/chats/:chatId/read", whatsAppHandler.MarkOwnChatRead)
		api.POST("/whatsapp/contacts/sync-channels", whatsAppHandler.SyncContactsToChannels)
		api.POST("/whatsapp/send", whatsAppHandler.SendResource)

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
		api.GET("/ai/assistants", aiHandler.ListAvailableAssistants)
		api.POST("/ai/chat", aiHandler.Chat)
		api.POST("/ai/spreadsheet/apply", aiHandler.ApplySpreadsheetPlan)
		api.GET("/ai/summaries", aiHandler.ListSummaryPages)
		api.POST("/ai/summaries/generate", aiHandler.GenerateSummaryPage)
		api.GET("/ai/summaries/:id", aiHandler.GetSummaryPage)
		api.PUT("/ai/summaries/:id", aiHandler.UpdateSummaryPage)
		api.DELETE("/ai/summaries/:id", aiHandler.DeleteSummaryPage)

		admin := api.Group("")
		admin.Use(middleware.RequireAdmin(userRepo))
		{
			// Users
			admin.GET("/users", userHandler.ListUsers)
			admin.POST("/users", userHandler.CreateUser)
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
			admin.POST("/permissions/principal-sheet", permHandler.SetPrincipalSheetPermission)
			admin.DELETE("/permissions/sheets/:id/principals/:principalType/:principalId/sheet", permHandler.DeletePrincipalSheetPermission)
			admin.POST("/permissions/principal-cell", permHandler.SetPrincipalCellPermission)
			admin.DELETE("/permissions/principal-cell/:id", permHandler.DeletePrincipalCellPermission)
			admin.GET("/permissions/sheets/:id/principals/:principalType/:principalId", permHandler.GetPrincipalPermissionConfig)
			admin.GET("/permissions/sheets/:id/roles/:roleId", permHandler.GetPermissionMatrixForRole)
			admin.GET("/permissions/sheets/:id/users", permHandler.ListUserSheetPermissions)
			admin.GET("/permissions/sheets/:id/users/:userId", permHandler.GetPermissionMatrixForUser)
			admin.GET("/permissions/sheets/:id/users/:userId/effective", permHandler.GetEffectivePermissionMatrixForUser)
			admin.POST("/workbooks/:id/assign", sheetHandler.AssignWorkbook)

			// Departments
			admin.POST("/departments", departmentHandler.Create)
			admin.PUT("/departments/:id", departmentHandler.Update)
			admin.DELETE("/departments/:id", departmentHandler.Delete)
			admin.PUT("/departments/:id/members", departmentHandler.SetMembers)

			// Attachments (admin)
			admin.DELETE("/attachments/:id", uploadHandler.DeleteFile)
			admin.DELETE("/gallery/directories/:id", channelHandler.DeleteGalleryDirectory)

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
			admin.GET("/admin/ai/assistants", aiHandler.ListAssistants)
			admin.POST("/admin/ai/assistants", aiHandler.CreateAssistant)
			admin.PUT("/admin/ai/assistants/:id", aiHandler.UpdateAssistant)
			admin.DELETE("/admin/ai/assistants/:id", aiHandler.DeleteAssistant)
			admin.POST("/admin/ai/assistants/:id/default", aiHandler.SetDefaultAssistant)
			admin.POST("/admin/ai/spreadsheet/preview", aiHandler.PreviewSpreadsheetPlan)
			admin.POST("/admin/ai/spreadsheet/apply", aiHandler.ApplySpreadsheetPlan)

			// WhatsApp Config (admin)
			admin.GET("/admin/whatsapp/settings", whatsAppHandler.GetSettings)
			admin.PUT("/admin/whatsapp/settings", whatsAppHandler.UpdateSettings)
			admin.GET("/admin/whatsapp/accounts", whatsAppHandler.ListAccounts)
			admin.GET("/admin/whatsapp/accounts/:userId", whatsAppHandler.GetManagedAccount)
			admin.PUT("/admin/whatsapp/accounts/:userId/preferences", whatsAppHandler.UpdateManagedPreferences)
			admin.POST("/admin/whatsapp/accounts/:userId/:action", whatsAppHandler.ManagedAccountAction)
			admin.GET("/admin/whatsapp/accounts/:userId/chats", whatsAppHandler.ListManagedChats)
		}
	}

	// WebSocket
	r.GET("/ws", wsHandler.HandleWS)

	go whatsAppService.AutoStart()

	log.Printf("Server starting on port %s", cfg.Server.Port)
	if err := r.Run(":" + cfg.Server.Port); err != nil {
		log.Fatalf("Failed to start server: %v", err)
	}
}
