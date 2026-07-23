package model

import "time"

type MailServerSettings struct {
	Enabled                 bool      `json:"enabled"`
	IMAPHost                string    `json:"imap_host"`
	IMAPPort                int       `json:"imap_port"`
	IMAPSecurity            string    `json:"imap_security"`
	SMTPHost                string    `json:"smtp_host"`
	SMTPPort                int       `json:"smtp_port"`
	SMTPSecurity            string    `json:"smtp_security"`
	DefaultDomain           string    `json:"default_domain"`
	AllowInsecureTLS        bool      `json:"allow_insecure_tls"`
	MaxAttachmentMB         int       `json:"max_attachment_mb"`
	ProxyType               string    `json:"proxy_type"`
	ProxyHost               string    `json:"proxy_host"`
	ProxyPort               int       `json:"proxy_port"`
	ProxyUsername           string    `json:"proxy_username"`
	ProxyPassword           string    `json:"proxy_password,omitempty"`
	ProxyPasswordEncrypted  string    `json:"-"`
	ProxyPasswordConfigured bool      `json:"proxy_password_configured"`
	Configured              bool      `json:"configured"`
	UpdatedAt               time.Time `json:"updated_at"`
}

type MailAccount struct {
	ID                 int64      `json:"id"`
	UserID             int64      `json:"user_id"`
	Username           string     `json:"username"`
	UserEmail          string     `json:"user_email"`
	EmailAddress       string     `json:"email_address"`
	DisplayName        string     `json:"display_name"`
	LoginUsername      string     `json:"login_username"`
	PasswordEncrypted  string     `json:"-"`
	PasswordConfigured bool       `json:"password_configured"`
	SignatureHTML      string     `json:"signature_html"`
	Enabled            bool       `json:"enabled"`
	AutoForwardEnabled bool       `json:"auto_forward_enabled"`
	AutoForwardTo      []string   `json:"auto_forward_to"`
	ForwardAttachments bool       `json:"forward_attachments"`
	ForwardUIDValidity uint32     `json:"-"`
	ForwardLastUID     uint32     `json:"-"`
	LastVerifiedAt     *time.Time `json:"last_verified_at,omitempty"`
	LastSyncAt         *time.Time `json:"last_sync_at,omitempty"`
	LastError          string     `json:"last_error,omitempty"`
	CreatedAt          time.Time  `json:"created_at"`
	UpdatedAt          time.Time  `json:"updated_at"`
}

type MailAccountInput struct {
	EmailAddress       string   `json:"email_address" binding:"required"`
	DisplayName        string   `json:"display_name"`
	LoginUsername      string   `json:"login_username"`
	Password           string   `json:"password"`
	SignatureHTML      string   `json:"signature_html"`
	Enabled            bool     `json:"enabled"`
	AutoForwardEnabled bool     `json:"auto_forward_enabled"`
	AutoForwardTo      []string `json:"auto_forward_to"`
	ForwardAttachments bool     `json:"forward_attachments"`
}

type MailConnectionTest struct {
	IMAPConnected bool   `json:"imap_connected"`
	SMTPConnected bool   `json:"smtp_connected"`
	Message       string `json:"message"`
}

type MailSummary struct {
	Configured bool   `json:"configured"`
	Enabled    bool   `json:"enabled"`
	Address    string `json:"address,omitempty"`
	Unread     uint32 `json:"unread"`
	Total      uint32 `json:"total"`
	LastError  string `json:"last_error,omitempty"`
}

type MailFolder struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Delimiter   string `json:"delimiter,omitempty"`
	Role        string `json:"role"`
	Total       uint32 `json:"total"`
	Unread      uint32 `json:"unread"`
	Selectable  bool   `json:"selectable"`
}

type MailAddress struct {
	Name    string `json:"name,omitempty"`
	Address string `json:"address"`
}

type MailAttachment struct {
	PartID      string `json:"part_id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	Inline      bool   `json:"inline"`
	ContentID   string `json:"content_id,omitempty"`
}

type MailMessageSummary struct {
	UID           uint32        `json:"uid"`
	Folder        string        `json:"folder"`
	MessageID     string        `json:"message_id,omitempty"`
	Subject       string        `json:"subject"`
	From          []MailAddress `json:"from"`
	To            []MailAddress `json:"to"`
	Date          time.Time     `json:"date"`
	Size          uint32        `json:"size"`
	Read          bool          `json:"read"`
	Starred       bool          `json:"starred"`
	HasAttachment bool          `json:"has_attachment"`
}

type MailMessagePage struct {
	Folder   string               `json:"folder"`
	Messages []MailMessageSummary `json:"messages"`
	Page     int                  `json:"page"`
	PageSize int                  `json:"page_size"`
	Total    int                  `json:"total"`
	HasMore  bool                 `json:"has_more"`
}

type MailMessageDetail struct {
	MailMessageSummary
	CC           []MailAddress    `json:"cc"`
	BCC          []MailAddress    `json:"bcc,omitempty"`
	ReplyTo      []MailAddress    `json:"reply_to"`
	SenderAvatar string           `json:"sender_avatar,omitempty"`
	TextBody     string           `json:"text_body"`
	HTMLBody     string           `json:"html_body"`
	InReplyTo    string           `json:"in_reply_to,omitempty"`
	References   []string         `json:"references,omitempty"`
	Attachments  []MailAttachment `json:"attachments"`
}

type MailFlagInput struct {
	Folder  string `json:"folder" binding:"required"`
	Read    *bool  `json:"read"`
	Starred *bool  `json:"starred"`
}

type MailMoveInput struct {
	Folder      string `json:"folder" binding:"required"`
	Destination string `json:"destination" binding:"required"`
}

type MailBatchInput struct {
	Folder      string   `json:"folder" binding:"required"`
	Action      string   `json:"action" binding:"required"`
	UIDs        []uint32 `json:"uids" binding:"required,min=1,max=500"`
	Destination string   `json:"destination"`
}

type MailFolderInput struct {
	Name string `json:"name" binding:"required"`
}

type MailFolderRenameInput struct {
	From string `json:"from" binding:"required"`
	To   string `json:"to" binding:"required"`
}

type MailSendInput struct {
	To                 []string `json:"to"`
	CC                 []string `json:"cc"`
	BCC                []string `json:"bcc"`
	Subject            string   `json:"subject"`
	TextBody           string   `json:"text_body"`
	HTMLBody           string   `json:"html_body"`
	InReplyTo          string   `json:"in_reply_to"`
	References         []string `json:"references"`
	SaveToSent         bool     `json:"save_to_sent"`
	Priority           string   `json:"priority"`
	RequestReadReceipt bool     `json:"request_read_receipt"`
	AutoForwardedBy    string   `json:"-"`
	SignatureHTML      *string  `json:"signature_html"`
}

type MailSendResult struct {
	MessageID string    `json:"message_id"`
	SentAt    time.Time `json:"sent_at"`
}

type MailContact struct {
	ID              int64     `json:"id"`
	UserID          int64     `json:"user_id"`
	TradeCustomerID *int64    `json:"trade_customer_id,omitempty"`
	Name            string    `json:"name"`
	Company         string    `json:"company"`
	Email           string    `json:"email"`
	Phone           string    `json:"phone,omitempty"`
	Notes           string    `json:"notes,omitempty"`
	Source          string    `json:"source"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type MailContactInput struct {
	TradeCustomerID *int64 `json:"trade_customer_id"`
	Name            string `json:"name"`
	Company         string `json:"company"`
	Email           string `json:"email" binding:"required"`
	Phone           string `json:"phone"`
	Notes           string `json:"notes"`
}

type MailSignature struct {
	ID           int64     `json:"id"`
	UserID       int64     `json:"user_id"`
	Title        string    `json:"title"`
	HTMLContent  string    `json:"html_content"`
	ApplyToNew   bool      `json:"apply_to_new"`
	ApplyToReply bool      `json:"apply_to_reply"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

type MailSignatureInput struct {
	Title        string `json:"title" binding:"required"`
	HTMLContent  string `json:"html_content"`
	ApplyToNew   bool   `json:"apply_to_new"`
	ApplyToReply bool   `json:"apply_to_reply"`
}

type MailTranslateInput struct {
	SourceText     string `json:"source_text" binding:"required"`
	TargetLanguage string `json:"target_language"`
	AssistantID    int64  `json:"assistant_id"`
	Aligned        bool   `json:"aligned"`
}
