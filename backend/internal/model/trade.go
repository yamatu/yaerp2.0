package model

import "time"

const (
	TradeStageInquiry       = "inquiry"
	TradeStageSupplierQuote = "supplier_quote"
	TradeStageQuotation     = "quotation"
	TradeStagePurchase      = "purchase"
	TradeStageReceiving     = "receiving"
	TradeStageInspection    = "inspection"
	TradeStagePacking       = "packing"
	TradeStageShipment      = "shipment"
	TradeStageCompleted     = "completed"
	TradeStageCancelled     = "cancelled"

	TradePaymentRecordAccessNone = "none"
	TradePaymentRecordAccessOwn  = "own"
	TradePaymentRecordAccessAll  = "all"
)

type TradeSupplier struct {
	ID              int64     `json:"id"`
	SupplierCode    string    `json:"supplier_code"`
	OwnerID         int64     `json:"owner_id"`
	OwnerName       string    `json:"owner_name"`
	Name            string    `json:"name"`
	CompanyName     string    `json:"company_name"`
	ContactName     string    `json:"contact_name"`
	Phone           string    `json:"phone"`
	Email           string    `json:"email"`
	WhatsApp        string    `json:"whatsapp"`
	Country         string    `json:"country"`
	DefaultCurrency string    `json:"default_currency"`
	PaymentMethod   string    `json:"payment_method"`
	Status          string    `json:"status"`
	Notes           string    `json:"notes"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type TradeCustomer struct {
	ID                 int64     `json:"id"`
	CustomerCode       string    `json:"customer_code"`
	OwnerID            int64     `json:"owner_id"`
	OwnerName          string    `json:"owner_name"`
	Name               string    `json:"name"`
	CompanyName        string    `json:"company_name"`
	Country            string    `json:"country"`
	Region             string    `json:"region"`
	ContactName        string    `json:"contact_name"`
	Email              string    `json:"email"`
	Phone              string    `json:"phone"`
	Source             string    `json:"source"`
	Status             string    `json:"status"`
	CustomerLevel      string    `json:"customer_level"`
	WhatsAppAccountID  *int64    `json:"whatsapp_account_id,omitempty"`
	WhatsAppChatID     string    `json:"whatsapp_chat_id"`
	WhatsAppChatName   string    `json:"whatsapp_chat_name"`
	AvatarURL          string    `json:"avatar_url"`
	ChannelID          *int64    `json:"channel_id,omitempty"`
	WorkbookFolderID   *int64    `json:"workbook_folder_id,omitempty"`
	WorkbookFolderName string    `json:"workbook_folder_name"`
	Tags               []string  `json:"tags"`
	Notes              string    `json:"notes"`
	OrderCount         int64     `json:"order_count"`
	OpenOrderCount     int64     `json:"open_order_count"`
	IntegrationWarning string    `json:"integration_warning,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
	UpdatedAt          time.Time `json:"updated_at"`
}

type TradeCustomerDeleteRequest struct {
	ID              int64      `json:"id"`
	CustomerID      int64      `json:"customer_id"`
	CustomerCode    string     `json:"customer_code"`
	CustomerName    string     `json:"customer_name"`
	CustomerCompany string     `json:"customer_company"`
	RequestedBy     *int64     `json:"requested_by,omitempty"`
	RequesterName   string     `json:"requester_name"`
	Reason          string     `json:"reason"`
	Status          string     `json:"status"`
	DecidedBy       *int64     `json:"decided_by,omitempty"`
	DeciderName     string     `json:"decider_name"`
	DecisionComment string     `json:"decision_comment"`
	RequestedAt     time.Time  `json:"requested_at"`
	DecidedAt       *time.Time `json:"decided_at,omitempty"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type TradeOrderItem struct {
	ID               int64          `json:"id"`
	OrderID          int64          `json:"order_id"`
	LineNo           int            `json:"line_no"`
	SKU              string         `json:"sku"`
	ProductName      string         `json:"product_name"`
	Description      string         `json:"description"`
	Specification    string         `json:"specification"`
	Quantity         float64        `json:"quantity"`
	Unit             string         `json:"unit"`
	TargetPrice      float64        `json:"target_price"`
	QuotedPrice      float64        `json:"quoted_price"`
	SupplierName     string         `json:"supplier_name"`
	PurchaseCurrency string         `json:"purchase_currency"`
	PurchasePrice    float64        `json:"purchase_price"`
	ReceivedQuantity float64        `json:"received_quantity"`
	AcceptedQuantity float64        `json:"accepted_quantity"`
	PackedQuantity   float64        `json:"packed_quantity"`
	CartonCount      int            `json:"carton_count"`
	HSCode           string         `json:"hs_code"`
	GrossWeight      float64        `json:"gross_weight"`
	NetWeight        float64        `json:"net_weight"`
	Status           string         `json:"status"`
	WorkflowData     map[string]any `json:"workflow_data,omitempty"`
	CreatedAt        time.Time      `json:"created_at"`
	UpdatedAt        time.Time      `json:"updated_at"`
}

type TradeOrderStageEvent struct {
	ID        int64          `json:"id"`
	OrderID   int64          `json:"order_id"`
	FromStage string         `json:"from_stage"`
	ToStage   string         `json:"to_stage"`
	ActorID   *int64         `json:"actor_id,omitempty"`
	ActorName string         `json:"actor_name"`
	Note      string         `json:"note"`
	Snapshot  map[string]any `json:"snapshot"`
	CreatedAt time.Time      `json:"created_at"`
}

type TradeSupplierQuote struct {
	ID            int64      `json:"id"`
	OrderID       int64      `json:"order_id"`
	OrderItemID   int64      `json:"order_item_id"`
	LineNo        int        `json:"line_no"`
	SheetRowIndex int        `json:"sheet_row_index"`
	SupplierID    *int64     `json:"supplier_id,omitempty"`
	SupplierCode  string     `json:"supplier_code"`
	SupplierName  string     `json:"supplier_name"`
	SKU           string     `json:"sku"`
	ProductName   string     `json:"product_name"`
	Currency      string     `json:"currency"`
	UnitPrice     float64    `json:"unit_price"`
	MOQ           float64    `json:"moq"`
	LeadTimeDays  int        `json:"lead_time_days"`
	ValidUntil    *time.Time `json:"valid_until,omitempty"`
	IsSelected    bool       `json:"is_selected"`
	Notes         string     `json:"notes"`
	CreatedBy     int64      `json:"created_by"`
	CreatedByName string     `json:"created_by_name"`
	CreatedAt     time.Time  `json:"created_at"`
	UpdatedAt     time.Time  `json:"updated_at"`
}

type TradeCustomerQuoteItem struct {
	OrderItemID int64   `json:"order_item_id"`
	LineNo      int     `json:"line_no"`
	SKU         string  `json:"sku"`
	ProductName string  `json:"product_name"`
	Quantity    float64 `json:"quantity"`
	Unit        string  `json:"unit"`
	UnitPrice   float64 `json:"unit_price"`
	Amount      float64 `json:"amount"`
}

type TradeCustomerQuoteRound struct {
	ID               int64                    `json:"id"`
	OrderID          int64                    `json:"order_id"`
	RoundNo          int                      `json:"round_no"`
	Currency         string                   `json:"currency"`
	Status           string                   `json:"status"`
	GoodsAmount      float64                  `json:"goods_amount"`
	ExchangeRateCNY  float64                  `json:"exchange_rate_cny"`
	FreightMode      string                   `json:"freight_mode"`
	FreightAmount    float64                  `json:"freight_amount"`
	TotalAmount      float64                  `json:"total_amount"`
	TotalAmountCNY   float64                  `json:"total_amount_cny"`
	Items            []TradeCustomerQuoteItem `json:"items"`
	CustomerFeedback string                   `json:"customer_feedback"`
	Notes            string                   `json:"notes"`
	PaymentStatus    string                   `json:"payment_status"`
	PaymentCurrency  string                   `json:"payment_currency"`
	PaidAmount       float64                  `json:"paid_amount"`
	PaymentProofs    []TradePaymentProof      `json:"payment_proofs,omitempty"`
	CreatedBy        int64                    `json:"created_by"`
	CreatedByName    string                   `json:"created_by_name"`
	SentAt           *time.Time               `json:"sent_at,omitempty"`
	CreatedAt        time.Time                `json:"created_at"`
	UpdatedAt        time.Time                `json:"updated_at"`
}

type TradeShipment struct {
	OrderID                int64      `json:"order_id"`
	BookingNo              string     `json:"booking_no"`
	Carrier                string     `json:"carrier"`
	VesselFlight           string     `json:"vessel_flight"`
	ETD                    *time.Time `json:"etd,omitempty"`
	ETA                    *time.Time `json:"eta,omitempty"`
	BLNo                   string     `json:"bl_no"`
	ShippingStatus         string     `json:"shipping_status"`
	ActualFreightCurrency  string     `json:"actual_freight_currency"`
	ActualFreightAmount    float64    `json:"actual_freight_amount"`
	ActualFreightToCNYRate float64    `json:"actual_freight_to_cny_rate"`
	ActualFreightNotes     string     `json:"actual_freight_notes"`
	Notes                  string     `json:"notes"`
	UpdatedAt              time.Time  `json:"updated_at"`
}

type TradeInspectionPhoto struct {
	ID                 int64     `json:"id"`
	OrderID            int64     `json:"order_id"`
	OrderItemID        *int64    `json:"order_item_id,omitempty"`
	OrderItemLineNo    *int      `json:"order_item_line_no,omitempty"`
	SKU                string    `json:"sku"`
	AttachmentID       int64     `json:"attachment_id"`
	AttachmentURL      string    `json:"attachment_url"`
	ThumbnailURL       string    `json:"thumbnail_url"`
	Filename           string    `json:"filename"`
	Note               string    `json:"note"`
	UploadedBy         int64     `json:"uploaded_by"`
	UploadedByName     string    `json:"uploaded_by_name"`
	GalleryDirectoryID *int64    `json:"gallery_directory_id,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

type TradePaymentProof struct {
	ID                 int64     `json:"id"`
	OrderID            int64     `json:"order_id"`
	QuoteID            int64     `json:"quote_id"`
	AttachmentID       int64     `json:"attachment_id"`
	AttachmentURL      string    `json:"attachment_url"`
	ThumbnailURL       string    `json:"thumbnail_url"`
	Filename           string    `json:"filename"`
	MimeType           string    `json:"mime_type"`
	Size               int64     `json:"size"`
	Note               string    `json:"note"`
	UploadedBy         int64     `json:"uploaded_by"`
	UploadedByName     string    `json:"uploaded_by_name"`
	GalleryDirectoryID *int64    `json:"gallery_directory_id,omitempty"`
	CreatedAt          time.Time `json:"created_at"`
}

type TradePackingGroupItem struct {
	OrderItemID int64   `json:"order_item_id"`
	LineNo      int     `json:"line_no"`
	SKU         string  `json:"sku"`
	ProductName string  `json:"product_name"`
	Quantity    float64 `json:"quantity"`
}

type TradePackingGroup struct {
	ID                 int64                   `json:"id"`
	OrderID            int64                   `json:"order_id"`
	GroupNo            int                     `json:"group_no"`
	LengthCM           float64                 `json:"length_cm"`
	WidthCM            float64                 `json:"width_cm"`
	HeightCM           float64                 `json:"height_cm"`
	WeightKG           float64                 `json:"weight_kg"`
	VolumetricWeightKG float64                 `json:"volumetric_weight_kg"`
	Copies             int                     `json:"copies"`
	Items              []TradePackingGroupItem `json:"items"`
	Notes              string                  `json:"notes"`
	CreatedAt          time.Time               `json:"created_at"`
	UpdatedAt          time.Time               `json:"updated_at"`
}

type TradePositionMember struct {
	UserID   int64  `json:"user_id"`
	Username string `json:"username"`
	Avatar   string `json:"avatar"`
}

type TradePosition struct {
	ID          int64                 `json:"id"`
	Code        string                `json:"code"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Stage       string                `json:"stage"`
	SortOrder   int                   `json:"sort_order"`
	Enabled     bool                  `json:"enabled"`
	Members     []TradePositionMember `json:"members"`
}

type TradeSettings struct {
	PaymentMethods           []string                       `json:"payment_methods"`
	PaymentRecordPermissions []TradePaymentRecordPermission `json:"payment_record_permissions"`
	PIProfile                TradePIProfile                 `json:"pi_profile"`
}

type TradePaymentRecordPermission struct {
	UserID int64  `json:"user_id"`
	Access string `json:"access"`
}

type TradePIProfile struct {
	CompanyName        string `json:"company_name"`
	Address            string `json:"address"`
	ContactName        string `json:"contact_name"`
	Phone              string `json:"phone"`
	Email              string `json:"email"`
	TaxID              string `json:"tax_id"`
	BankName           string `json:"bank_name"`
	BankAddress        string `json:"bank_address"`
	AccountName        string `json:"account_name"`
	AccountNumber      string `json:"account_number"`
	SwiftCode          string `json:"swift_code"`
	BeneficiaryAddress string `json:"beneficiary_address"`
	DefaultNotes       string `json:"default_notes"`
}

type TradeAccessProfile struct {
	UserID               int64    `json:"user_id"`
	IsAdmin              bool     `json:"is_admin"`
	IsManager            bool     `json:"is_manager"`
	PositionCodes        []string `json:"position_codes"`
	PositionNames        []string `json:"position_names"`
	AllowedStages        []string `json:"allowed_stages"`
	CanViewAllOrders     bool     `json:"can_view_all_orders"`
	CanViewOrderProgress bool     `json:"can_view_order_progress"`
	CanViewCustomers     bool     `json:"can_view_customers"`
	CanCreateCustomers   bool     `json:"can_create_customers"`
	CanCreateOrders      bool     `json:"can_create_orders"`
	CanViewSuppliers     bool     `json:"can_view_suppliers"`
	CanManageSuppliers   bool     `json:"can_manage_suppliers"`
	PaymentRecordAccess  string   `json:"payment_record_access"`
	ScopeLabel           string   `json:"scope_label"`
}

type TradeOrderAccess struct {
	ScopeLabel               string   `json:"scope_label"`
	CanViewCustomer          bool     `json:"can_view_customer"`
	CanViewCustomerContact   bool     `json:"can_view_customer_contact"`
	CanViewCustomerPricing   bool     `json:"can_view_customer_pricing"`
	CanViewSupplier          bool     `json:"can_view_supplier"`
	CanViewSupplierPricing   bool     `json:"can_view_supplier_pricing"`
	CanViewReceiving         bool     `json:"can_view_receiving"`
	CanViewInspection        bool     `json:"can_view_inspection"`
	CanViewPacking           bool     `json:"can_view_packing"`
	CanViewShipment          bool     `json:"can_view_shipment"`
	CanViewProfit            bool     `json:"can_view_profit"`
	CanViewTimeline          bool     `json:"can_view_timeline"`
	CanSyncWorkbook          bool     `json:"can_sync_workbook"`
	CanAddItems              bool     `json:"can_add_items"`
	CanViewPaymentRecords    bool     `json:"can_view_payment_records"`
	CanViewAllPaymentRecords bool     `json:"can_view_all_payment_records"`
	CanUploadPaymentProofs   bool     `json:"can_upload_payment_proofs"`
	CanManagePaymentStatus   bool     `json:"can_manage_payment_status"`
	VisibleSheetNames        []string `json:"visible_sheet_names"`
	EditableSheetNames       []string `json:"editable_sheet_names"`
}

type TradeOrder struct {
	ID                           int64                     `json:"id"`
	OrderNo                      string                    `json:"order_no"`
	CustomerID                   int64                     `json:"customer_id"`
	CustomerName                 string                    `json:"customer_name"`
	CustomerCompany              string                    `json:"customer_company"`
	CustomerAvatarURL            string                    `json:"customer_avatar_url"`
	OwnerID                      int64                     `json:"owner_id"`
	OwnerName                    string                    `json:"owner_name"`
	Title                        string                    `json:"title"`
	Stage                        string                    `json:"stage"`
	Priority                     string                    `json:"priority"`
	InquiryDate                  time.Time                 `json:"inquiry_date"`
	QuoteDeadline                *time.Time                `json:"quote_deadline,omitempty"`
	ExpectedShipDate             *time.Time                `json:"expected_ship_date,omitempty"`
	Currency                     string                    `json:"currency"`
	Incoterm                     string                    `json:"incoterm"`
	DestinationCountry           string                    `json:"destination_country"`
	DestinationPort              string                    `json:"destination_port"`
	PaymentTerms                 string                    `json:"payment_terms"`
	PaymentMethod                string                    `json:"payment_method"`
	TotalAmount                  float64                   `json:"total_amount"`
	QuotedGoodsAmount            float64                   `json:"quoted_goods_amount"`
	QuoteExchangeRateCNY         float64                   `json:"quote_exchange_rate_cny"`
	FreightMode                  string                    `json:"freight_mode"`
	QuotedFreightAmount          float64                   `json:"quoted_freight_amount"`
	ActualFreightCurrency        string                    `json:"actual_freight_currency"`
	ActualFreightAmount          float64                   `json:"actual_freight_amount"`
	ActualFreightToCNYRate       float64                   `json:"actual_freight_to_cny_rate"`
	ActualFreightNotes           string                    `json:"actual_freight_notes"`
	AdditionalCostAmount         float64                   `json:"additional_cost_amount"`
	AdditionalCostNotes          string                    `json:"additional_cost_notes"`
	WorkbookID                   *int64                    `json:"workbook_id,omitempty"`
	WorkbookSheetID              *int64                    `json:"workbook_sheet_id,omitempty"`
	WorkspaceFolderID            *int64                    `json:"workspace_folder_id,omitempty"`
	WorkspaceFolderName          string                    `json:"workspace_folder_name"`
	ChannelID                    *int64                    `json:"channel_id,omitempty"`
	Notes                        string                    `json:"notes"`
	LabelWidthMM                 float64                   `json:"label_width_mm"`
	LabelHeightMM                float64                   `json:"label_height_mm"`
	LabelPaperSize               string                    `json:"label_paper_size"`
	LabelPaperWidthMM            float64                   `json:"label_paper_width_mm"`
	LabelPaperHeightMM           float64                   `json:"label_paper_height_mm"`
	LabelOrientation             string                    `json:"label_orientation"`
	LabelMarginTopMM             float64                   `json:"label_margin_top_mm"`
	LabelMarginRightMM           float64                   `json:"label_margin_right_mm"`
	LabelMarginBottomMM          float64                   `json:"label_margin_bottom_mm"`
	LabelMarginLeftMM            float64                   `json:"label_margin_left_mm"`
	LabelGapXMM                  float64                   `json:"label_gap_x_mm"`
	LabelGapYMM                  float64                   `json:"label_gap_y_mm"`
	LabelContentScale            float64                   `json:"label_content_scale"`
	LabelStartSlot               int                       `json:"label_start_slot"`
	LabelOffsetXMM               float64                   `json:"label_offset_x_mm"`
	LabelOffsetYMM               float64                   `json:"label_offset_y_mm"`
	InspectionGalleryDirectoryID *int64                    `json:"inspection_gallery_directory_id,omitempty"`
	PaymentGalleryDirectoryID    *int64                    `json:"payment_gallery_directory_id,omitempty"`
	ReworkRequired               bool                      `json:"rework_required"`
	ReworkReason                 string                    `json:"rework_reason"`
	ReworkCount                  int                       `json:"rework_count"`
	ItemCount                    int64                     `json:"item_count"`
	RequiredPositionCode         string                    `json:"required_position_code"`
	RequiredPositionName         string                    `json:"required_position_name"`
	CanOperateStage              bool                      `json:"can_operate_stage"`
	CanAdvance                   bool                      `json:"can_advance"`
	CanReturn                    bool                      `json:"can_return"`
	AdvanceBlockers              []string                  `json:"advance_blockers"`
	Access                       *TradeOrderAccess         `json:"access,omitempty"`
	StageUpdatedAt               time.Time                 `json:"stage_updated_at"`
	CreatedAt                    time.Time                 `json:"created_at"`
	UpdatedAt                    time.Time                 `json:"updated_at"`
	Customer                     *TradeCustomer            `json:"customer,omitempty"`
	Items                        []TradeOrderItem          `json:"items,omitempty"`
	Events                       []TradeOrderStageEvent    `json:"events,omitempty"`
	SupplierQuotes               []TradeSupplierQuote      `json:"supplier_quotes,omitempty"`
	CustomerQuotes               []TradeCustomerQuoteRound `json:"customer_quotes,omitempty"`
	InspectionPhotos             []TradeInspectionPhoto    `json:"inspection_photos,omitempty"`
	PackingGroups                []TradePackingGroup       `json:"packing_groups,omitempty"`
	Shipment                     *TradeShipment            `json:"shipment,omitempty"`
	ProfitSummary                *TradeProfitSummary       `json:"profit_summary,omitempty"`
}

type TradeProfitLine struct {
	OrderItemID       int64   `json:"order_item_id"`
	LineNo            int     `json:"line_no"`
	SKU               string  `json:"sku"`
	ProductName       string  `json:"product_name"`
	Quantity          float64 `json:"quantity"`
	SalesUnitPrice    float64 `json:"sales_unit_price"`
	Revenue           float64 `json:"revenue"`
	PurchaseCurrency  string  `json:"purchase_currency"`
	PurchaseUnitPrice float64 `json:"purchase_unit_price"`
	CostExchangeRate  float64 `json:"cost_exchange_rate"`
	PurchaseCost      float64 `json:"purchase_cost"`
	ProfitAmount      float64 `json:"profit_amount"`
	ProfitMargin      float64 `json:"profit_margin"`
	CostComplete      bool    `json:"cost_complete"`
}

type TradeProfitSummary struct {
	Currency            string            `json:"currency"`
	Revenue             float64           `json:"revenue"`
	GoodsRevenue        float64           `json:"goods_revenue"`
	FreightRevenue      float64           `json:"freight_revenue"`
	ProductCost         float64           `json:"product_cost"`
	ActualFreightCost   float64           `json:"actual_freight_cost"`
	AdditionalCost      float64           `json:"additional_cost"`
	TotalCost           float64           `json:"total_cost"`
	GoodsProfit         float64           `json:"goods_profit"`
	FreightProfit       float64           `json:"freight_profit"`
	ProfitAmount        float64           `json:"profit_amount"`
	ProfitMargin        float64           `json:"profit_margin"`
	ExchangeRateCNY     float64           `json:"exchange_rate_cny"`
	RevenueCNY          float64           `json:"revenue_cny"`
	TotalCostCNY        float64           `json:"total_cost_cny"`
	ProfitAmountCNY     float64           `json:"profit_amount_cny"`
	FreightRevenueCNY   float64           `json:"freight_revenue_cny"`
	FreightCostCNY      float64           `json:"freight_cost_cny"`
	FreightProfitCNY    float64           `json:"freight_profit_cny"`
	CostComplete        bool              `json:"cost_complete"`
	CNYComplete         bool              `json:"cny_complete"`
	Finalized           bool              `json:"finalized"`
	Warnings            []string          `json:"warnings"`
	AdditionalCostNotes string            `json:"additional_cost_notes"`
	Lines               []TradeProfitLine `json:"lines,omitempty"`
}

type TradeBossCurrencySummary struct {
	Currency          string  `json:"currency"`
	OrderCount        int64   `json:"order_count"`
	Revenue           float64 `json:"revenue"`
	GoodsRevenue      float64 `json:"goods_revenue"`
	FreightRevenue    float64 `json:"freight_revenue"`
	ProductCost       float64 `json:"product_cost"`
	ActualFreightCost float64 `json:"actual_freight_cost"`
	AdditionalCost    float64 `json:"additional_cost"`
	TotalCost         float64 `json:"total_cost"`
	FreightProfit     float64 `json:"freight_profit"`
	ProfitAmount      float64 `json:"profit_amount"`
	ProfitMargin      float64 `json:"profit_margin"`
}

type TradeBossOrderSummary struct {
	ID                int64     `json:"id"`
	OrderNo           string    `json:"order_no"`
	Title             string    `json:"title"`
	CustomerName      string    `json:"customer_name"`
	OwnerName         string    `json:"owner_name"`
	Stage             string    `json:"stage"`
	Currency          string    `json:"currency"`
	Revenue           float64   `json:"revenue"`
	GoodsRevenue      float64   `json:"goods_revenue"`
	FreightRevenue    float64   `json:"freight_revenue"`
	TotalCost         float64   `json:"total_cost"`
	ActualFreightCost float64   `json:"actual_freight_cost"`
	FreightProfit     float64   `json:"freight_profit"`
	ProfitAmount      float64   `json:"profit_amount"`
	ProfitMargin      float64   `json:"profit_margin"`
	RevenueCNY        float64   `json:"revenue_cny"`
	TotalCostCNY      float64   `json:"total_cost_cny"`
	ProfitAmountCNY   float64   `json:"profit_amount_cny"`
	FreightProfitCNY  float64   `json:"freight_profit_cny"`
	CostComplete      bool      `json:"cost_complete"`
	CNYComplete       bool      `json:"cny_complete"`
	Warnings          []string  `json:"warnings"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type TradeBossMonthlySummary struct {
	Month            string  `json:"month"`
	CompletedOrders  int64   `json:"completed_orders"`
	FinalizedOrders  int64   `json:"finalized_orders"`
	IncompleteOrders int64   `json:"incomplete_orders"`
	RevenueCNY       float64 `json:"revenue_cny"`
	TotalCostCNY     float64 `json:"total_cost_cny"`
	ProfitAmountCNY  float64 `json:"profit_amount_cny"`
	FreightProfitCNY float64 `json:"freight_profit_cny"`
	ProfitMargin     float64 `json:"profit_margin"`
}

type TradeBossDashboard struct {
	TotalOrders          int64                      `json:"total_orders"`
	ActiveOrders         int64                      `json:"active_orders"`
	CompletedOrders      int64                      `json:"completed_orders"`
	ProfitableOrders     int64                      `json:"profitable_orders"`
	LossOrders           int64                      `json:"loss_orders"`
	IncompleteCostOrders int64                      `json:"incomplete_cost_orders"`
	CNYCompleteOrders    int64                      `json:"cny_complete_orders"`
	RevenueCNY           float64                    `json:"revenue_cny"`
	TotalCostCNY         float64                    `json:"total_cost_cny"`
	ProfitAmountCNY      float64                    `json:"profit_amount_cny"`
	FreightRevenueCNY    float64                    `json:"freight_revenue_cny"`
	FreightCostCNY       float64                    `json:"freight_cost_cny"`
	FreightProfitCNY     float64                    `json:"freight_profit_cny"`
	Currencies           []TradeBossCurrencySummary `json:"currencies"`
	Monthly              []TradeBossMonthlySummary  `json:"monthly"`
	RecentOrders         []TradeBossOrderSummary    `json:"recent_orders"`
	TopProfitOrders      []TradeBossOrderSummary    `json:"top_profit_orders"`
	LossOrderList        []TradeBossOrderSummary    `json:"loss_orders_list"`
}

type TradeDashboard struct {
	CustomerCount      int64            `json:"customer_count"`
	ActiveOrderCount   int64            `json:"active_order_count"`
	PendingQuoteCount  int64            `json:"pending_quote_count"`
	PurchaseCount      int64            `json:"purchase_count"`
	WarehouseCount     int64            `json:"warehouse_count"`
	ShippingCount      int64            `json:"shipping_count"`
	OverdueQuoteCount  int64            `json:"overdue_quote_count"`
	CompletedThisMonth int64            `json:"completed_this_month"`
	StageCounts        map[string]int64 `json:"stage_counts"`
}

type CreateTradeCustomerRequest struct {
	Name              string   `json:"name" binding:"required"`
	CompanyName       string   `json:"company_name"`
	Country           string   `json:"country"`
	Region            string   `json:"region"`
	ContactName       string   `json:"contact_name"`
	Email             string   `json:"email"`
	Phone             string   `json:"phone"`
	Source            string   `json:"source"`
	CustomerLevel     string   `json:"customer_level"`
	WhatsAppAccountID *int64   `json:"whatsapp_account_id"`
	WhatsAppChatID    string   `json:"whatsapp_chat_id"`
	WhatsAppChatName  string   `json:"whatsapp_chat_name"`
	AvatarURL         string   `json:"avatar_url"`
	Tags              []string `json:"tags"`
	Notes             string   `json:"notes"`
	WorkbookFolderID  *int64   `json:"workbook_folder_id"`
	CreateChannel     *bool    `json:"create_channel"`
}

type UpdateTradeCustomerRequest struct {
	Name              string   `json:"name" binding:"required"`
	CompanyName       string   `json:"company_name"`
	Country           string   `json:"country"`
	Region            string   `json:"region"`
	ContactName       string   `json:"contact_name"`
	Email             string   `json:"email"`
	Phone             string   `json:"phone"`
	Source            string   `json:"source"`
	Status            string   `json:"status"`
	CustomerLevel     string   `json:"customer_level"`
	WhatsAppAccountID *int64   `json:"whatsapp_account_id"`
	WhatsAppChatID    string   `json:"whatsapp_chat_id"`
	WhatsAppChatName  string   `json:"whatsapp_chat_name"`
	AvatarURL         string   `json:"avatar_url"`
	Tags              []string `json:"tags"`
	Notes             string   `json:"notes"`
	WorkbookFolderID  *int64   `json:"workbook_folder_id"`
}

type TradeCustomerDeleteRequestInput struct {
	Reason string `json:"reason"`
}

type TradeCustomerDeleteDecisionInput struct {
	Decision string `json:"decision" binding:"required"`
	Comment  string `json:"comment"`
}

type CreateTradeOrderItemRequest struct {
	SKU           string  `json:"sku"`
	ProductName   string  `json:"product_name" binding:"required"`
	Description   string  `json:"description"`
	Specification string  `json:"specification"`
	Quantity      float64 `json:"quantity" binding:"gt=0"`
	Unit          string  `json:"unit"`
	TargetPrice   float64 `json:"target_price"`
}

type AddTradeOrderItemsRequest struct {
	Items []CreateTradeOrderItemRequest `json:"items" binding:"required,min=1,dive"`
}

type UpdateTradeStageItemRequest struct {
	OrderItemID      int64          `json:"order_item_id" binding:"required"`
	SKU              string         `json:"sku"`
	ProductName      string         `json:"product_name"`
	Description      string         `json:"description"`
	Specification    string         `json:"specification"`
	Quantity         float64        `json:"quantity"`
	Unit             string         `json:"unit"`
	TargetPrice      float64        `json:"target_price"`
	SupplierName     string         `json:"supplier_name"`
	PurchaseCurrency string         `json:"purchase_currency"`
	PurchasePrice    float64        `json:"purchase_price"`
	ReceivedQuantity float64        `json:"received_quantity"`
	AcceptedQuantity float64        `json:"accepted_quantity"`
	PackedQuantity   float64        `json:"packed_quantity"`
	CartonCount      int            `json:"carton_count"`
	HSCode           string         `json:"hs_code"`
	GrossWeight      float64        `json:"gross_weight"`
	NetWeight        float64        `json:"net_weight"`
	Status           string         `json:"status"`
	WorkflowData     map[string]any `json:"workflow_data"`
}

type UpdateTradeStageShipmentRequest struct {
	BookingNo              string  `json:"booking_no"`
	Carrier                string  `json:"carrier"`
	VesselFlight           string  `json:"vessel_flight"`
	ETD                    string  `json:"etd"`
	ETA                    string  `json:"eta"`
	BLNo                   string  `json:"bl_no"`
	ShippingStatus         string  `json:"shipping_status"`
	ActualFreightCurrency  string  `json:"actual_freight_currency"`
	ActualFreightAmount    float64 `json:"actual_freight_amount"`
	ActualFreightToCNYRate float64 `json:"actual_freight_to_cny_rate"`
	ActualFreightNotes     string  `json:"actual_freight_notes"`
	Notes                  string  `json:"notes"`
}

type UpdateTradeStageDataRequest struct {
	Items    []UpdateTradeStageItemRequest    `json:"items"`
	Shipment *UpdateTradeStageShipmentRequest `json:"shipment,omitempty"`
}

type TradeItemCostRateInput struct {
	OrderItemID int64   `json:"order_item_id" binding:"required"`
	Rate        float64 `json:"rate" binding:"gte=0"`
}

type UpdateTradeProfitSettingsRequest struct {
	AdditionalCostAmount float64                  `json:"additional_cost_amount" binding:"gte=0"`
	AdditionalCostNotes  string                   `json:"additional_cost_notes"`
	ItemRates            []TradeItemCostRateInput `json:"item_rates"`
}

type CreateTradeOrderRequest struct {
	CustomerID         int64                         `json:"customer_id" binding:"required"`
	Title              string                        `json:"title" binding:"required"`
	Priority           string                        `json:"priority"`
	QuoteDeadline      string                        `json:"quote_deadline"`
	ExpectedShipDate   string                        `json:"expected_ship_date"`
	Currency           string                        `json:"currency"`
	Incoterm           string                        `json:"incoterm"`
	DestinationCountry string                        `json:"destination_country"`
	DestinationPort    string                        `json:"destination_port"`
	PaymentTerms       string                        `json:"payment_terms"`
	PaymentMethod      string                        `json:"payment_method"`
	Notes              string                        `json:"notes"`
	Items              []CreateTradeOrderItemRequest `json:"items" binding:"required,min=1,dive"`
	CreateWorkspace    *bool                         `json:"create_workspace"`
	SharedWorkspace    *bool                         `json:"shared_workspace"`
	WorkbookFolderID   *int64                        `json:"workbook_folder_id"`
}

type AdvanceTradeOrderRequest struct {
	ToStage string `json:"to_stage" binding:"required"`
	Note    string `json:"note"`
}

type CreateTradeSupplierRequest struct {
	Name            string `json:"name" binding:"required"`
	CompanyName     string `json:"company_name"`
	ContactName     string `json:"contact_name"`
	Phone           string `json:"phone"`
	Email           string `json:"email"`
	WhatsApp        string `json:"whatsapp"`
	Country         string `json:"country"`
	DefaultCurrency string `json:"default_currency"`
	PaymentMethod   string `json:"payment_method"`
	Notes           string `json:"notes"`
}

type UpsertTradeSupplierQuoteRequest struct {
	OrderItemID  int64   `json:"order_item_id" binding:"required"`
	SupplierID   int64   `json:"supplier_id" binding:"required"`
	Currency     string  `json:"currency"`
	UnitPrice    float64 `json:"unit_price" binding:"gte=0"`
	MOQ          float64 `json:"moq" binding:"gte=0"`
	LeadTimeDays int     `json:"lead_time_days" binding:"gte=0"`
	ValidUntil   string  `json:"valid_until"`
	Notes        string  `json:"notes"`
}

type BatchTradeSupplierQuoteRequest struct {
	Quotes []UpsertTradeSupplierQuoteRequest `json:"quotes" binding:"required,min=1,dive"`
}

type TradeCustomerQuoteItemInput struct {
	OrderItemID int64   `json:"order_item_id" binding:"required"`
	UnitPrice   float64 `json:"unit_price" binding:"gt=0"`
}

type CreateTradeCustomerQuoteRequest struct {
	Currency         string                        `json:"currency"`
	ExchangeRateCNY  float64                       `json:"exchange_rate_cny"`
	FreightMode      string                        `json:"freight_mode"`
	FreightAmount    float64                       `json:"freight_amount"`
	Status           string                        `json:"status"`
	CustomerFeedback string                        `json:"customer_feedback"`
	Notes            string                        `json:"notes"`
	Items            []TradeCustomerQuoteItemInput `json:"items" binding:"required,min=1,dive"`
}

type UpdateTradeCustomerQuoteStatusRequest struct {
	Status           string `json:"status" binding:"required"`
	CustomerFeedback string `json:"customer_feedback"`
	Notes            string `json:"notes"`
}

type UpdateTradeCustomerPaymentRequest struct {
	PaymentStatus   string  `json:"payment_status" binding:"required"`
	PaymentCurrency string  `json:"payment_currency"`
	PaidAmount      float64 `json:"paid_amount" binding:"gte=0"`
}

type LinkTradeInspectionPhotosRequest struct {
	OrderItemID   *int64  `json:"order_item_id"`
	AttachmentIDs []int64 `json:"attachment_ids" binding:"required,min=1"`
	Note          string  `json:"note"`
}

type TradePackingGroupItemInput struct {
	OrderItemID int64   `json:"order_item_id" binding:"required"`
	Quantity    float64 `json:"quantity" binding:"gt=0"`
}

type TradePackingGroupInput struct {
	LengthCM float64                      `json:"length_cm" binding:"gte=0"`
	WidthCM  float64                      `json:"width_cm" binding:"gte=0"`
	HeightCM float64                      `json:"height_cm" binding:"gte=0"`
	WeightKG float64                      `json:"weight_kg" binding:"gte=0"`
	Copies   int                          `json:"copies" binding:"gte=1"`
	Items    []TradePackingGroupItemInput `json:"items" binding:"required,min=1,dive"`
	Notes    string                       `json:"notes"`
}

type UpdateTradePackingGroupsRequest struct {
	Groups []TradePackingGroupInput `json:"groups" binding:"required,min=1,dive"`
}

type ReturnTradeOrderToPurchaseRequest struct {
	Reason string `json:"reason" binding:"required"`
}

type TradePositionAssignmentsRequest struct {
	Assignments map[string][]int64 `json:"assignments" binding:"required"`
}

type UpdateTradeSettingsRequest struct {
	PaymentMethods           []string                       `json:"payment_methods" binding:"required"`
	PaymentRecordPermissions []TradePaymentRecordPermission `json:"payment_record_permissions"`
	PIProfile                *TradePIProfile                `json:"pi_profile"`
}

type TradePIRequest struct {
	QuoteID       int64  `json:"quote_id"`
	IssueDate     string `json:"issue_date"`
	ValidUntil    string `json:"valid_until"`
	PaymentMethod string `json:"payment_method"`
	DeliveryTerms string `json:"delivery_terms"`
	DeliveryTime  string `json:"delivery_time"`
	Notes         string `json:"notes"`
}

type UpdateTradeLabelSettingsRequest struct {
	WidthMM        float64  `json:"width_mm" binding:"gte=20,lte=300"`
	HeightMM       float64  `json:"height_mm" binding:"gte=15,lte=300"`
	PaperSize      string   `json:"paper_size"`
	PaperWidthMM   float64  `json:"paper_width_mm" binding:"gte=50,lte=500"`
	PaperHeightMM  float64  `json:"paper_height_mm" binding:"gte=50,lte=500"`
	Orientation    string   `json:"orientation"`
	MarginTopMM    float64  `json:"margin_top_mm" binding:"gte=0,lte=100"`
	MarginRightMM  float64  `json:"margin_right_mm" binding:"gte=0,lte=100"`
	MarginBottomMM float64  `json:"margin_bottom_mm" binding:"gte=0,lte=100"`
	MarginLeftMM   float64  `json:"margin_left_mm" binding:"gte=0,lte=100"`
	GapXMM         float64  `json:"gap_x_mm" binding:"gte=0,lte=50"`
	GapYMM         float64  `json:"gap_y_mm" binding:"gte=0,lte=50"`
	ContentScale   float64  `json:"content_scale" binding:"gte=0.5,lte=1.8"`
	StartSlot      int      `json:"start_slot" binding:"gte=0,lte=500"`
	OffsetXMM      *float64 `json:"offset_x_mm" binding:"omitempty,gte=0,lte=500"`
	OffsetYMM      *float64 `json:"offset_y_mm" binding:"omitempty,gte=0,lte=500"`
}

type TradeOrderFilter struct {
	Search     string
	Stage      string
	CustomerID int64
}
