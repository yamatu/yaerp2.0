package model

// TradeOrderSheetPreview is what a monthly order workbook (月度成交订单表)
// would import, before anything is saved.
type TradeOrderSheetPreview struct {
	FileName        string `json:"file_name"`
	Sheet           string `json:"sheet"`
	Sheets          []string `json:"sheets"`
	SettlementMonth string `json:"settlement_month"`
	// "filename" when read from a name like 外贸工作表2611, "dates" when
	// derived from the deal dates.
	SettlementMonthSource string                   `json:"settlement_month_source"`
	Currency              string                   `json:"currency"`
	ExchangeRate          float64                  `json:"exchange_rate"`
	Rows                  []TradeOrderSheetRow     `json:"rows"`
	Warnings              []string                 `json:"warnings"`
}

type TradeOrderSheetImage struct {
	Name string `json:"name"`
	Size int    `json:"size"`
}

type TradeOrderSheetRow struct {
	RowNumber int `json:"row_number"`
	// As written in the sheet, e.g. 美国 Bob Kirk; split into country and name.
	CustomerLabel    string                 `json:"customer_label"`
	CustomerName     string                 `json:"customer_name"`
	Country          string                 `json:"country"`
	DealDate         string                 `json:"deal_date"`
	GoodsAmount      float64                `json:"goods_amount"`
	PaymentFee       float64                `json:"payment_fee"`
	FreightAmount    float64                `json:"freight_amount"`
	ActualFreightCNY float64                `json:"actual_freight_cny"`
	// Text written where the freight cost goes, e.g. 计费27kg.
	ActualFreightNote   string                 `json:"actual_freight_note"`
	ShippingAddress     string                 `json:"shipping_address"`
	TrackingNumbers     []string               `json:"tracking_numbers"`
	Notes               string                 `json:"notes"`
	PINo                string                 `json:"pi_no"`
	Images              []TradeOrderSheetImage `json:"images"`
	MatchedCustomerID   int64                  `json:"matched_customer_id,omitempty"`
	MatchedCustomerName string                 `json:"matched_customer_name,omitempty"`
	ImportKey           string                 `json:"import_key"`
	ExistingOrderNo     string                 `json:"existing_order_no,omitempty"`
	Skip                bool                   `json:"skip"`
	SkipReason          string                 `json:"skip_reason,omitempty"`
	Problems            []string               `json:"problems"`
}

// TradeOrderSheetApplyRequest is sent with the same file; rows not listed
// or with Import false are left out.
type TradeOrderSheetApplyRequest struct {
	Sheet           string  `json:"sheet"`
	SettlementMonth string  `json:"settlement_month"`
	Currency        string  `json:"currency"`
	ExchangeRate    float64 `json:"exchange_rate"`
	// Salesperson owning customers created by the import; 0 is the importer.
	OwnerID int64 `json:"owner_id"`
	// Puts every row under one customer, e.g. a reseller shipping to end users.
	CustomerID int64                       `json:"customer_id"`
	Rows       []TradeOrderSheetApplyRow `json:"rows"`
}

type TradeOrderSheetApplyRow struct {
	RowNumber        int     `json:"row_number"`
	Import           bool    `json:"import"`
	CustomerID       int64   `json:"customer_id"`
	CustomerName     string  `json:"customer_name"`
	DealDate         string  `json:"deal_date"`
	GoodsAmount      float64 `json:"goods_amount"`
	PaymentFee       float64 `json:"payment_fee"`
	FreightAmount    float64 `json:"freight_amount"`
	ActualFreightCNY float64 `json:"actual_freight_cny"`
}

type TradeOrderSheetImportResult struct {
	Created int                              `json:"created"`
	Skipped int                              `json:"skipped"`
	Failed  int                              `json:"failed"`
	Rows    []TradeOrderSheetImportRowResult `json:"rows"`
}

type TradeOrderSheetImportRowResult struct {
	RowNumber int    `json:"row_number"`
	Status    string `json:"status"`
	OrderID   int64  `json:"order_id,omitempty"`
	OrderNo   string `json:"order_no,omitempty"`
	Message   string `json:"message,omitempty"`
}
