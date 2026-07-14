package model

import "time"

type Channel struct {
	ID                  int64      `json:"id" db:"id"`
	Name                string     `json:"name" db:"name"`
	Description         *string    `json:"description,omitempty" db:"description"`
	OwnerID             int64      `json:"owner_id" db:"owner_id"`
	OwnerName           string     `json:"owner_name,omitempty" db:"owner_name"`
	AvatarAttachmentID  *int64     `json:"avatar_attachment_id,omitempty" db:"avatar_attachment_id"`
	AvatarURL           string     `json:"avatar_url,omitempty"`
	ChannelType         string     `json:"channel_type" db:"channel_type"`
	AIAssistantID       *int64     `json:"ai_assistant_id,omitempty" db:"ai_assistant_id"`
	AIAssistantName     string     `json:"ai_assistant_name,omitempty" db:"ai_assistant_name"`
	AIAssistantCount    int        `json:"ai_assistant_count" db:"ai_assistant_count"`
	MemberCount         int        `json:"member_count" db:"member_count"`
	IsPinned            bool       `json:"is_pinned" db:"is_pinned"`
	PinSortOrder        int        `json:"pin_sort_order" db:"pin_sort_order"`
	UnreadCount         int        `json:"unread_count" db:"unread_count"`
	LastMessageID       *int64     `json:"last_message_id,omitempty" db:"last_message_id"`
	LastMessageSenderID *int64     `json:"last_message_sender_id,omitempty" db:"last_message_sender_id"`
	LastMessageAt       *time.Time `json:"last_message_at,omitempty" db:"last_message_at"`
	CanManage           bool       `json:"can_manage" db:"-"`
	CreatedAt           time.Time  `json:"created_at" db:"created_at"`
	UpdatedAt           time.Time  `json:"updated_at" db:"updated_at"`
}

type ChannelMember struct {
	ChannelID int64     `json:"channel_id" db:"channel_id"`
	UserID    int64     `json:"user_id" db:"user_id"`
	Username  string    `json:"username" db:"username"`
	Email     string    `json:"email" db:"email"`
	Avatar    *string   `json:"avatar,omitempty" db:"avatar"`
	Role      string    `json:"role" db:"role"`
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

type ChannelAIMember struct {
	ChannelID      int64     `json:"channel_id" db:"channel_id"`
	AssistantID    int64     `json:"assistant_id" db:"assistant_id"`
	Name           string    `json:"name" db:"name"`
	Description    string    `json:"description" db:"description"`
	Model          string    `json:"model" db:"model"`
	IsDefault      bool      `json:"is_default" db:"is_default"`
	Enabled        bool      `json:"enabled" db:"enabled"`
	SupportsVision bool      `json:"supports_vision" db:"supports_vision"`
	SupportsFiles  bool      `json:"supports_files" db:"supports_files"`
	CreatedAt      time.Time `json:"created_at" db:"created_at"`
}

type ChannelMessage struct {
	ID                     int64      `json:"id" db:"id"`
	ChannelID              int64      `json:"channel_id" db:"channel_id"`
	SenderID               int64      `json:"sender_id" db:"sender_id"`
	SenderName             string     `json:"sender_name,omitempty" db:"sender_name"`
	SenderAvatar           *string    `json:"sender_avatar,omitempty" db:"sender_avatar"`
	SenderType             string     `json:"sender_type" db:"sender_type"`
	ExternalSource         *string    `json:"external_source,omitempty" db:"external_source"`
	ExternalMessageID      *string    `json:"external_message_id,omitempty" db:"external_message_id"`
	ExternalSenderName     *string    `json:"external_sender_name,omitempty" db:"external_sender_name"`
	ExternalSenderAddress  *string    `json:"external_sender_address,omitempty" db:"external_sender_address"`
	AssistantID            *int64     `json:"assistant_id,omitempty" db:"assistant_id"`
	AssistantName          string     `json:"assistant_name,omitempty" db:"assistant_name"`
	Content                string     `json:"content" db:"content"`
	AttachmentID           *int64     `json:"attachment_id,omitempty" db:"attachment_id"`
	AttachmentURL          string     `json:"attachment_url,omitempty"`
	AttachmentFilename     *string    `json:"attachment_filename,omitempty" db:"attachment_filename"`
	AttachmentMimeType     *string    `json:"attachment_mime_type,omitempty" db:"attachment_mime_type"`
	AttachmentSize         *int64     `json:"attachment_size,omitempty" db:"attachment_size"`
	LinkedWorkbookID       *int64     `json:"linked_workbook_id,omitempty" db:"linked_workbook_id"`
	LinkedWorkbookName     *string    `json:"linked_workbook_name,omitempty" db:"linked_workbook_name"`
	LinkedSheetID          *int64     `json:"linked_sheet_id,omitempty" db:"linked_sheet_id"`
	LinkedSheetName        *string    `json:"linked_sheet_name,omitempty" db:"linked_sheet_name"`
	LinkedSummaryID        *int64     `json:"linked_summary_id,omitempty" db:"linked_summary_id"`
	LinkedSummaryTitle     *string    `json:"linked_summary_title,omitempty" db:"linked_summary_title"`
	ForwardedFromMessageID *int64     `json:"forwarded_from_message_id,omitempty" db:"forwarded_from_message_id"`
	ReplyToMessageID       *int64     `json:"reply_to_message_id,omitempty" db:"reply_to_message_id"`
	ReplySenderID          *int64     `json:"reply_sender_id,omitempty" db:"reply_sender_id"`
	ReplySenderName        *string    `json:"reply_sender_name,omitempty" db:"reply_sender_name"`
	ReplyContent           *string    `json:"reply_content,omitempty" db:"reply_content"`
	ReplyAttachmentName    *string    `json:"reply_attachment_filename,omitempty" db:"reply_attachment_filename"`
	ReplyRecalledAt        *time.Time `json:"reply_recalled_at,omitempty" db:"reply_recalled_at"`
	RecalledAt             *time.Time `json:"recalled_at,omitempty" db:"recalled_at"`
	RecalledBy             *int64     `json:"recalled_by,omitempty" db:"recalled_by"`
	CreatedAt              time.Time  `json:"created_at" db:"created_at"`
}

type ChannelMessageSearchResult struct {
	ChannelMessage
	ChannelName string `json:"channel_name" db:"channel_name"`
}

type ChannelMessageSearchFilter struct {
	ChannelID   *int64
	Keyword     string
	MatchMode   string
	SenderID    *int64
	MessageType string
	From        *time.Time
	To          *time.Time
	Page        int
	Size        int
}

type GalleryDirectory struct {
	ID         int64     `json:"id" db:"id"`
	Name       string    `json:"name" db:"name"`
	OwnerID    int64     `json:"owner_id" db:"owner_id"`
	OwnerName  string    `json:"owner_name,omitempty" db:"owner_name"`
	ChannelID  *int64    `json:"channel_id,omitempty" db:"channel_id"`
	Visibility string    `json:"visibility" db:"visibility"`
	CanManage  bool      `json:"can_manage" db:"-"`
	CanEdit    bool      `json:"can_edit" db:"-"`
	CreatedAt  time.Time `json:"created_at" db:"created_at"`
	UpdatedAt  time.Time `json:"updated_at" db:"updated_at"`
}

type ChannelCreateRequest struct {
	Name        string  `json:"name" binding:"required"`
	Description *string `json:"description"`
}

type ChannelUpdateRequest struct {
	Name        *string `json:"name"`
	Description *string `json:"description"`
}

type ChannelMembersRequest struct {
	UserIDs []int64 `json:"user_ids" binding:"required"`
}

type ChannelAIMembersRequest struct {
	AssistantIDs []int64 `json:"assistant_ids" binding:"required"`
}

type ChannelAIPrivateRequest struct {
	AssistantID int64 `json:"assistant_id" binding:"required"`
}

type ChannelAIAskRequest struct {
	AssistantID      int64   `json:"assistant_id"`
	Content          string  `json:"content" binding:"required"`
	ReplyToMessageID *int64  `json:"reply_to_message_id"`
	AttachmentID     *int64  `json:"attachment_id"`
	WorkbookID       *int64  `json:"workbook_id"`
	SheetIDs         []int64 `json:"sheet_ids"`
}

type ChannelPinRequest struct {
	Pinned bool `json:"pinned"`
}

type ChannelPinOrderRequest struct {
	ChannelIDs []int64 `json:"channel_ids" binding:"required"`
}

type AttachmentAvatarRequest struct {
	AttachmentID int64 `json:"attachment_id" binding:"required"`
}

type ChannelForwardRequest struct {
	TargetChannelID int64  `json:"target_channel_id" binding:"required"`
	Content         string `json:"content"`
}

type ChannelImageSaveRequest struct {
	GalleryDirectoryID *int64 `json:"gallery_directory_id"`
}

type GalleryDirectoryRequest struct {
	Name       string  `json:"name" binding:"required"`
	ChannelID  *int64  `json:"channel_id"`
	Visibility *string `json:"visibility"`
}

type GalleryDirectoryAccess struct {
	DirectoryID int64   `json:"directory_id"`
	Visibility  string  `json:"visibility"`
	ViewUserIDs []int64 `json:"view_user_ids"`
	EditUserIDs []int64 `json:"edit_user_ids"`
}

type GalleryDirectoryAccessRequest struct {
	Visibility  string  `json:"visibility" binding:"required"`
	ViewUserIDs []int64 `json:"view_user_ids"`
	EditUserIDs []int64 `json:"edit_user_ids"`
}

type GalleryImageRenameRequest struct {
	Filename string `json:"filename" binding:"required"`
}

type WhatsAppSettings struct {
	Enabled                 bool   `json:"enabled"`
	AutoStart               bool   `json:"auto_start"`
	ProxyType               string `json:"proxy_type"`
	ProxyHost               string `json:"proxy_host"`
	ProxyPort               int    `json:"proxy_port"`
	ProxyUsername           string `json:"proxy_username"`
	ProxyPassword           string `json:"proxy_password,omitempty"`
	ProxyPasswordConfigured bool   `json:"proxy_password_configured"`
}

type WhatsAppStatus struct {
	Status         string                 `json:"status"`
	QRDataURL      string                 `json:"qrDataUrl,omitempty"`
	LoadingPercent int                    `json:"loadingPercent"`
	LoadingMessage string                 `json:"loadingMessage,omitempty"`
	Account        map[string]interface{} `json:"account,omitempty"`
	LastError      string                 `json:"lastError,omitempty"`
	UpdatedAt      string                 `json:"updatedAt,omitempty"`
}

type WhatsAppChat struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	IsGroup     bool   `json:"isGroup"`
	UnreadCount int    `json:"unreadCount"`
	Timestamp   int64  `json:"timestamp"`
	Pinned      bool   `json:"pinned"`
	Archived    bool   `json:"archived"`
	IsMuted     bool   `json:"isMuted"`
}

type WhatsAppChannelLink struct {
	ChannelID        int64     `json:"channel_id"`
	WhatsAppChatID   string    `json:"whatsapp_chat_id"`
	WhatsAppChatName string    `json:"whatsapp_chat_name"`
	SyncInbound      bool      `json:"sync_inbound"`
	SyncOutbound     bool      `json:"sync_outbound"`
	CreatedBy        int64     `json:"created_by"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

type WhatsAppChannelLinkRequest struct {
	WhatsAppChatID   string `json:"whatsapp_chat_id" binding:"required"`
	WhatsAppChatName string `json:"whatsapp_chat_name"`
	SyncInbound      *bool  `json:"sync_inbound"`
	SyncOutbound     *bool  `json:"sync_outbound"`
}

type WhatsAppSendRequest struct {
	ChannelID    int64  `json:"channel_id"`
	MessageID    int64  `json:"message_id"`
	ChatID       string `json:"chat_id"`
	Content      string `json:"content"`
	AttachmentID *int64 `json:"attachment_id"`
	WorkbookID   *int64 `json:"workbook_id"`
	SheetID      *int64 `json:"sheet_id"`
}
