package service

import (
	"fmt"
	"html"
	"math"
	"strconv"
	"strings"
	"time"

	"yaerp/internal/model"
)

const tradePIPDFContentType = "application/pdf"

type TradePIFile struct {
	Filename string
	PINumber string
	Currency string
	Total    float64
	Data     []byte
}

type tradePIDocument struct {
	Order         *model.TradeOrder
	Quote         *model.TradeCustomerQuoteRound
	Profile       model.TradePIProfile
	PINumber      string
	IssueDate     time.Time
	ValidUntil    time.Time
	PaymentMethod string
	DeliveryTerms string
	DeliveryTime  string
	Notes         string
}

func (s *TradeService) BuildTradePIFile(userID, orderID int64, request *model.TradePIRequest) (*TradePIFile, error) {
	order, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, err
	}
	if order.Access == nil || !order.Access.CanViewCustomer || !order.Access.CanViewCustomerContact || !order.Access.CanViewCustomerPricing {
		return nil, fmt.Errorf("没有生成客户 PI 的权限")
	}
	quote, err := selectTradePIQuote(order.CustomerQuotes, request)
	if err != nil {
		return nil, err
	}
	settings, err := s.repo.GetSettings()
	if err != nil {
		return nil, err
	}
	profile := normalizeTradePIProfile(settings.PIProfile)
	if profile.CompanyName == "" {
		return nil, fmt.Errorf("请先在外贸设置中配置 PI 公司资料")
	}

	issueDate, validUntil, err := tradePIDates(request)
	if err != nil {
		return nil, err
	}
	paymentMethod := strings.TrimSpace(request.PaymentMethod)
	if paymentMethod == "" {
		paymentMethod = firstNonEmptyTrade(order.PaymentMethod, order.PaymentTerms, "As agreed")
	}
	deliveryTerms := strings.TrimSpace(request.DeliveryTerms)
	if deliveryTerms == "" {
		destination := strings.TrimSpace(strings.Join([]string{order.DestinationCountry, order.DestinationPort}, " "))
		deliveryTerms = strings.TrimSpace(strings.Join([]string{order.Incoterm, destination}, " "))
	}
	if deliveryTerms == "" {
		deliveryTerms = "As agreed"
	}
	deliveryTime := strings.TrimSpace(request.DeliveryTime)
	if deliveryTime == "" {
		deliveryTime = "As agreed"
	}
	piNumber := fmt.Sprintf("PI-%s-R%d", order.OrderNo, quote.RoundNo)
	document := &tradePIDocument{
		Order: order, Quote: quote, Profile: profile, PINumber: piNumber,
		IssueDate: issueDate, ValidUntil: validUntil,
		PaymentMethod: paymentMethod, DeliveryTerms: deliveryTerms,
		DeliveryTime: deliveryTime, Notes: strings.TrimSpace(request.Notes),
	}
	pdfData, err := renderTradePIPDF(document)
	if err != nil {
		return nil, err
	}
	return &TradePIFile{
		Filename: sanitizeTradePIFilename(piNumber) + ".pdf",
		PINumber: piNumber,
		Currency: quote.Currency,
		Total:    quote.TotalAmount,
		Data:     pdfData,
	}, nil
}

func (s *TradeService) SendTradePIToCustomer(userID, orderID int64, request *model.TradePIRequest) (*model.ChannelMessage, error) {
	order, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, err
	}
	if order.ChannelID == nil || *order.ChannelID <= 0 {
		return nil, fmt.Errorf("该客户尚未关联频道，无法发送 PI")
	}
	file, err := s.BuildTradePIFile(userID, orderID, request)
	if err != nil {
		return nil, err
	}
	attachment, _, err := s.uploadSvc.UploadBytes(file.Filename, tradePIPDFContentType, file.Data, userID)
	if err != nil {
		return nil, err
	}
	message, err := s.channelSvc.CreateMessage(userID, *order.ChannelID, ChannelMessageInput{
		Content:           fmt.Sprintf("Proforma Invoice %s · %s %.2f", file.PINumber, file.Currency, file.Total),
		AttachmentID:      &attachment.ID,
		TrustedAttachment: true,
	})
	if err != nil {
		_ = s.uploadSvc.DeleteFile(attachment.ID)
		return nil, err
	}
	return message, nil
}

func selectTradePIQuote(quotes []model.TradeCustomerQuoteRound, request *model.TradePIRequest) (*model.TradeCustomerQuoteRound, error) {
	if request == nil {
		request = &model.TradePIRequest{}
	}
	if request.QuoteID > 0 {
		for index := range quotes {
			if quotes[index].ID == request.QuoteID {
				if quotes[index].Status == "draft" || quotes[index].Status == "rejected" {
					return nil, fmt.Errorf("草稿或已拒绝报价不能生成 PI")
				}
				return &quotes[index], nil
			}
		}
		return nil, fmt.Errorf("所选报价轮次不存在")
	}
	for _, preferredStatus := range []string{"accepted", "sent", "negotiating", "superseded"} {
		for index := range quotes {
			if quotes[index].Status == preferredStatus {
				return &quotes[index], nil
			}
		}
	}
	return nil, fmt.Errorf("请先创建并发送一轮对客报价")
}

func tradePIDates(request *model.TradePIRequest) (time.Time, time.Time, error) {
	if request == nil {
		request = &model.TradePIRequest{}
	}
	issueDate := time.Now()
	var err error
	if strings.TrimSpace(request.IssueDate) != "" {
		issueDate, err = time.ParseInLocation("2006-01-02", strings.TrimSpace(request.IssueDate), time.Local)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("PI 日期格式无效")
		}
	}
	validUntil := issueDate.AddDate(0, 0, 14)
	if strings.TrimSpace(request.ValidUntil) != "" {
		validUntil, err = time.ParseInLocation("2006-01-02", strings.TrimSpace(request.ValidUntil), time.Local)
		if err != nil {
			return time.Time{}, time.Time{}, fmt.Errorf("PI 有效期格式无效")
		}
	}
	if validUntil.Before(issueDate) {
		return time.Time{}, time.Time{}, fmt.Errorf("PI 有效期不能早于开具日期")
	}
	return issueDate, validUntil, nil
}

func renderTradePIPDF(document *tradePIDocument) ([]byte, error) {
	if document == nil || document.Order == nil || document.Quote == nil {
		return nil, fmt.Errorf("PI 数据不完整")
	}
	layout := sheetPDFLayout{CSSPageSize: "A4 portrait", PageWidthMM: 210, MarginMM: 0, Scale: 1}
	return renderSheetPDFWithChromium(renderTradePIHTML(document), layout)
}

func renderTradePIHTML(document *tradePIDocument) string {
	order := document.Order
	quote := document.Quote
	profile := document.Profile
	goodsAmount := quote.GoodsAmount
	if goodsAmount <= 0 {
		for _, item := range quote.Items {
			goodsAmount += item.Amount
		}
	}
	totalAmount := quote.TotalAmount
	if totalAmount <= 0 {
		totalAmount = goodsAmount + quote.FreightAmount
	}
	customerName := firstNonEmptyTrade(order.CustomerCompany, order.CustomerName)
	customerContact := ""
	customerEmail := ""
	customerPhone := ""
	customerCountry := ""
	if order.Customer != nil {
		customerName = firstNonEmptyTrade(order.Customer.CompanyName, order.Customer.Name, customerName)
		customerContact = order.Customer.ContactName
		customerEmail = order.Customer.Email
		customerPhone = order.Customer.Phone
		customerCountry = strings.TrimSpace(strings.Join([]string{order.Customer.Country, order.Customer.Region}, " "))
	}

	var rows strings.Builder
	for index, item := range quote.Items {
		rows.WriteString("<tr><td class=\"center\">")
		rows.WriteString(strconv.Itoa(index + 1))
		rows.WriteString("</td><td>")
		rows.WriteString(html.EscapeString(item.SKU))
		rows.WriteString("</td><td><strong>")
		rows.WriteString(html.EscapeString(item.ProductName))
		rows.WriteString("</strong>")
		if matched := tradePIOrderItem(order.Items, item.OrderItemID); matched != nil && strings.TrimSpace(matched.Specification) != "" {
			rows.WriteString("<div class=\"muted\">")
			rows.WriteString(html.EscapeString(matched.Specification))
			rows.WriteString("</div>")
		}
		rows.WriteString("</td><td class=\"number\">")
		rows.WriteString(formatTradePINumber(item.Quantity))
		rows.WriteString("</td><td class=\"center\">")
		rows.WriteString(html.EscapeString(item.Unit))
		rows.WriteString("</td><td class=\"number\">")
		rows.WriteString(formatTradePIMoney(item.UnitPrice))
		rows.WriteString("</td><td class=\"number strong\">")
		rows.WriteString(formatTradePIMoney(item.Amount))
		rows.WriteString("</td></tr>")
	}

	freightRow := ""
	if quote.FreightMode == "quoted" && quote.FreightAmount > 0 {
		freightRow = `<tr class="summary-row"><td colspan="6">Freight</td><td class="number strong">` +
			formatTradePIMoney(quote.FreightAmount) + `</td></tr>`
	}
	notes := strings.TrimSpace(strings.Join([]string{document.Notes, profile.DefaultNotes}, "\n"))
	amountWords := tradePIAmountWords(quote.Currency, totalAmount)

	var builder strings.Builder
	builder.Grow(32 * 1024)
	builder.WriteString(`<!doctype html><html><head><meta charset="utf-8"><style>`)
	builder.WriteString(`@font-face{font-family:'` + sheetPDFBaseFontFamily + `';src:url(data:font/ttf;base64,` + sheetPDFFontBase64 + `) format('truetype');font-weight:100 900}`)
	builder.WriteString(`@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111827;font-family:'` + sheetPDFBaseFontFamily + `',Arial,sans-serif;font-size:10px;line-height:1.45}`)
	builder.WriteString(`.page{width:210mm;min-height:297mm;padding:14mm 15mm 13mm;position:relative}.top{display:flex;justify-content:space-between;gap:12mm;border-bottom:1.2mm solid #0f172a;padding-bottom:5mm}.seller{max-width:112mm}.brand{display:inline-flex;align-items:center;gap:3mm}.mark{display:flex;width:11mm;height:11mm;align-items:center;justify-content:center;background:#0f172a;color:#fff;font-size:15px;font-weight:800}.company{font-size:16px;font-weight:800;letter-spacing:.2px}.seller-lines{margin-top:2.5mm;color:#475569;white-space:pre-line}.title{text-align:right}.title h1{margin:0;font-size:24px;letter-spacing:1.5px}.pi-no{margin-top:2mm;font-size:11px;font-weight:700;color:#334155}.meta{display:grid;grid-template-columns:1fr 1fr;margin-top:6mm;border:1px solid #cbd5e1}.party{padding:4mm}.party+ .party{border-left:1px solid #cbd5e1}.eyebrow{font-size:8px;text-transform:uppercase;letter-spacing:1.2px;color:#64748b;font-weight:700}.party-name{margin-top:1.5mm;font-size:13px;font-weight:800}.detail{margin-top:1mm;color:#475569}.facts{display:grid;grid-template-columns:repeat(4,1fr);margin-top:4mm;border:1px solid #cbd5e1}.fact{padding:2.8mm;border-right:1px solid #e2e8f0}.fact:last-child{border-right:0}.fact-value{margin-top:.7mm;font-weight:700}.items{width:100%;border-collapse:collapse;margin-top:6mm}.items thead{display:table-header-group}.items th{background:#0f172a;color:#fff;padding:2.6mm 2mm;text-align:left;font-size:8.5px;letter-spacing:.4px}.items td{border:1px solid #cbd5e1;padding:2.4mm 2mm;vertical-align:top}.items tr{break-inside:avoid}.center{text-align:center}.number{text-align:right;font-variant-numeric:tabular-nums}.strong{font-weight:800}.muted{margin-top:.6mm;color:#64748b;font-size:8.5px}.summary-row td{background:#f8fafc}.total-row td{background:#e2e8f0;font-size:12px}.words{margin-top:2.5mm;padding:2.5mm 3mm;border-left:1mm solid #0f172a;background:#f8fafc;font-size:9px}.terms{display:grid;grid-template-columns:1.05fr .95fr;gap:5mm;margin-top:6mm;break-inside:avoid}.panel{border-top:1px solid #94a3b8;padding-top:3mm}.panel h2{margin:0 0 2mm;font-size:10px;text-transform:uppercase;letter-spacing:.7px}.info-grid{display:grid;grid-template-columns:30mm 1fr;gap:1mm 2mm}.info-label{color:#64748b}.notes{white-space:pre-line;color:#334155}.signature{margin-top:8mm;display:flex;justify-content:flex-end;break-inside:avoid}.signature-box{width:62mm;text-align:center}.signature-line{margin-top:12mm;border-top:1px solid #64748b;padding-top:1.5mm}.footer{position:absolute;left:15mm;right:15mm;bottom:7mm;display:flex;justify-content:space-between;border-top:1px solid #cbd5e1;padding-top:2mm;color:#64748b;font-size:8px}`)
	builder.WriteString(`</style></head><body><main class="page">`)
	builder.WriteString(`<section class="top"><div class="seller"><div class="brand"><div class="mark">PI</div><div class="company">` + html.EscapeString(profile.CompanyName) + `</div></div><div class="seller-lines">` + html.EscapeString(strings.Join(nonEmptyTradePIStrings(profile.Address, profile.Phone, profile.Email, profile.TaxID), "\n")) + `</div></div><div class="title"><h1>PROFORMA<br>INVOICE</h1><div class="pi-no">` + html.EscapeString(document.PINumber) + `</div></div></section>`)
	builder.WriteString(`<section class="meta"><div class="party"><div class="eyebrow">Seller</div><div class="party-name">` + html.EscapeString(profile.CompanyName) + `</div><div class="detail">` + html.EscapeString(firstNonEmptyTrade(profile.ContactName, profile.Email, profile.Phone)) + `</div></div><div class="party"><div class="eyebrow">Bill To</div><div class="party-name">` + html.EscapeString(customerName) + `</div><div class="detail">` + html.EscapeString(strings.Join(nonEmptyTradePIStrings(customerContact, customerEmail, customerPhone, customerCountry), " · ")) + `</div></div></section>`)
	builder.WriteString(`<section class="facts"><div class="fact"><div class="eyebrow">Issue Date</div><div class="fact-value">` + document.IssueDate.Format("02 Jan 2006") + `</div></div><div class="fact"><div class="eyebrow">Valid Until</div><div class="fact-value">` + document.ValidUntil.Format("02 Jan 2006") + `</div></div><div class="fact"><div class="eyebrow">Order Reference</div><div class="fact-value">` + html.EscapeString(order.OrderNo) + `</div></div><div class="fact"><div class="eyebrow">Currency</div><div class="fact-value">` + html.EscapeString(quote.Currency) + `</div></div></section>`)
	builder.WriteString(`<table class="items"><thead><tr><th style="width:8mm">No.</th><th style="width:28mm">SKU</th><th>Description</th><th style="width:18mm;text-align:right">Qty</th><th style="width:16mm;text-align:center">Unit</th><th style="width:24mm;text-align:right">Unit Price</th><th style="width:27mm;text-align:right">Amount</th></tr></thead><tbody>`)
	builder.WriteString(rows.String())
	builder.WriteString(`<tr class="summary-row"><td colspan="6">Goods Subtotal</td><td class="number strong">` + formatTradePIMoney(goodsAmount) + `</td></tr>`)
	builder.WriteString(freightRow)
	builder.WriteString(`<tr class="total-row"><td colspan="6" class="strong">TOTAL (` + html.EscapeString(quote.Currency) + `)</td><td class="number strong">` + formatTradePIMoney(totalAmount) + `</td></tr></tbody></table>`)
	builder.WriteString(`<div class="words"><strong>Amount in words:</strong> ` + html.EscapeString(amountWords) + `</div>`)
	builder.WriteString(`<section class="terms"><div class="panel"><h2>Commercial Terms</h2><div class="info-grid"><div class="info-label">Payment</div><div>` + html.EscapeString(document.PaymentMethod) + `</div><div class="info-label">Delivery Terms</div><div>` + html.EscapeString(document.DeliveryTerms) + `</div><div class="info-label">Delivery Time</div><div>` + html.EscapeString(document.DeliveryTime) + `</div></div>`)
	if notes != "" {
		builder.WriteString(`<h2 style="margin-top:4mm">Notes</h2><div class="notes">` + html.EscapeString(notes) + `</div>`)
	}
	builder.WriteString(`</div><div class="panel"><h2>Beneficiary Bank Details</h2><div class="info-grid"><div class="info-label">Beneficiary</div><div>` + html.EscapeString(firstNonEmptyTrade(profile.AccountName, profile.CompanyName)) + `</div><div class="info-label">Account No.</div><div>` + html.EscapeString(profile.AccountNumber) + `</div><div class="info-label">Bank</div><div>` + html.EscapeString(profile.BankName) + `</div><div class="info-label">Bank Address</div><div>` + html.EscapeString(profile.BankAddress) + `</div><div class="info-label">SWIFT</div><div>` + html.EscapeString(profile.SwiftCode) + `</div><div class="info-label">Beneficiary Address</div><div>` + html.EscapeString(profile.BeneficiaryAddress) + `</div></div></div></section>`)
	builder.WriteString(`<section class="signature"><div class="signature-box"><div class="signature-line">Authorized Signature</div><strong>` + html.EscapeString(profile.CompanyName) + `</strong></div></section>`)
	builder.WriteString(`<footer class="footer"><span>` + html.EscapeString(document.PINumber) + `</span><span>This document is computer generated.</span></footer></main></body></html>`)
	return builder.String()
}

func tradePIOrderItem(items []model.TradeOrderItem, itemID int64) *model.TradeOrderItem {
	for index := range items {
		if items[index].ID == itemID {
			return &items[index]
		}
	}
	return nil
}

func nonEmptyTradePIStrings(values ...string) []string {
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			result = append(result, value)
		}
	}
	return result
}

func formatTradePIMoney(value float64) string {
	return strconv.FormatFloat(value, 'f', 2, 64)
}

func formatTradePINumber(value float64) string {
	return strconv.FormatFloat(value, 'f', -1, 64)
}

func sanitizeTradePIFilename(value string) string {
	value = strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\r', '\n', '\t':
			return '-'
		default:
			return r
		}
	}, strings.TrimSpace(value))
	value = strings.Trim(value, ". ")
	if value == "" {
		return "proforma-invoice"
	}
	return value
}

func tradePIAmountWords(currency string, amount float64) string {
	minorUnits := int64(math.Round(math.Abs(amount) * 100))
	whole := minorUnits / 100
	cents := minorUnits % 100
	words := tradePIEnglishInteger(whole)
	if amount < 0 {
		words = "MINUS " + words
	}
	return fmt.Sprintf("%s %s AND %02d/100 ONLY", strings.ToUpper(strings.TrimSpace(currency)), words, cents)
}

func tradePIEnglishInteger(value int64) string {
	if value == 0 {
		return "ZERO"
	}
	units := []string{"", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN", "SEVENTEEN", "EIGHTEEN", "NINETEEN"}
	tens := []string{"", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY"}
	var underThousand func(int64) string
	underThousand = func(number int64) string {
		parts := make([]string, 0, 3)
		if number >= 100 {
			parts = append(parts, units[number/100], "HUNDRED")
			number %= 100
		}
		if number >= 20 {
			parts = append(parts, tens[number/10])
			number %= 10
		}
		if number > 0 {
			parts = append(parts, units[number])
		}
		return strings.Join(parts, " ")
	}
	groups := []struct {
		value int64
		name  string
	}{
		{1_000_000_000, "BILLION"},
		{1_000_000, "MILLION"},
		{1_000, "THOUSAND"},
		{1, ""},
	}
	parts := make([]string, 0, 8)
	for _, group := range groups {
		if value < group.value {
			continue
		}
		chunk := value / group.value
		value %= group.value
		parts = append(parts, underThousand(chunk))
		if group.name != "" {
			parts = append(parts, group.name)
		}
	}
	return strings.Join(parts, " ")
}
