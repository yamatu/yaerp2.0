package service

import (
	"encoding/base64"
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
	Order                   *model.TradeOrder
	Quote                   *model.TradeCustomerQuoteRound
	Profile                 model.TradePIProfile
	PINumber                string
	IssueDate               time.Time
	ValidUntil              time.Time
	PaymentMethod           string
	DeliveryTerms           string
	DeliveryTime            string
	Notes                   string
	BankDetailsImageDataURI string
}

func (s *TradeService) BuildTradePIFile(userID, orderID int64, request *model.TradePIRequest) (*TradePIFile, error) {
	order, err := s.GetOrder(userID, orderID)
	if err != nil {
		return nil, err
	}
	if order.Access == nil || !order.Access.CanGeneratePI || !order.Access.CanViewCustomer || !order.Access.CanViewCustomerContact || !order.Access.CanViewCustomerPricing {
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
	profile = applyTradePISellerProfile(profile, quote.PISellerProfile)
	if profile.CompanyName == "" {
		return nil, fmt.Errorf("请先在外贸设置中配置 PI 公司资料")
	}
	bankDetailsImageDataURI := ""
	bankImageAttachmentID := tradePIBankImageAttachmentID(&profile, quote)
	if bankImageAttachmentID != nil {
		attachment, data, imageErr := s.uploadSvc.ReadAttachmentBytes(*bankImageAttachmentID)
		if imageErr != nil {
			return nil, fmt.Errorf("读取 PI 银行信息图片失败: %w", imageErr)
		}
		mimeType := strings.ToLower(strings.TrimSpace(attachment.MimeType))
		if !strings.HasPrefix(mimeType, "image/") {
			return nil, fmt.Errorf("PI 银行信息附件不是图片")
		}
		bankDetailsImageDataURI = "data:" + mimeType + ";base64," + base64.StdEncoding.EncodeToString(data)
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
		destination := mergeTradeDestination(order.DestinationCountry, order.DestinationPort)
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
		BankDetailsImageDataURI: bankDetailsImageDataURI,
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

func applyTradePISellerProfile(profile model.TradePIProfile, seller *model.TradePISellerProfile) model.TradePIProfile {
	if seller == nil {
		return profile
	}
	profile.CompanyName = strings.TrimSpace(seller.CompanyName)
	profile.Address = strings.TrimSpace(seller.Address)
	profile.ContactName = strings.TrimSpace(seller.ContactName)
	profile.Phone = strings.TrimSpace(seller.Phone)
	profile.Email = strings.TrimSpace(seller.Email)
	profile.TaxID = strings.TrimSpace(seller.TaxID)
	return profile
}

func tradePIBankImageAttachmentID(profile *model.TradePIProfile, quote *model.TradeCustomerQuoteRound) *int64 {
	if quote != nil && quote.PIBankDetailsImageAttachmentID != nil && *quote.PIBankDetailsImageAttachmentID > 0 {
		return quote.PIBankDetailsImageAttachmentID
	}
	if profile != nil && profile.BankDetailsImageAttachmentID != nil && *profile.BankDetailsImageAttachmentID > 0 {
		return profile.BankDetailsImageAttachmentID
	}
	return nil
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
	customerName := firstNonEmptyTrade(order.CustomerCompany, order.CustomerName, "-")
	customerContact := ""
	customerEmail := ""
	customerPhone := ""
	customerAddress := ""
	if order.Customer != nil {
		customerName = firstNonEmptyTrade(order.Customer.CompanyName, order.Customer.Name, customerName)
		customerContact = order.Customer.ContactName
		customerEmail = order.Customer.Email
		customerPhone = order.Customer.Phone
		customerAddress = mergeTradeDestination(order.Customer.Country, order.Customer.Region)
	}

	var rows strings.Builder
	for index, item := range quote.Items {
		matched := tradePIOrderItem(order.Items, item.OrderItemID)
		rows.WriteString("<tr><td class=\"center\">")
		rows.WriteString(strconv.Itoa(index + 1))
		rows.WriteString("</td><td>")
		rows.WriteString(html.EscapeString(item.ProductName))
		rows.WriteString("</td><td><strong>")
		rows.WriteString(html.EscapeString(item.SKU))
		rows.WriteString("</strong>")
		if matched != nil && strings.TrimSpace(matched.Specification) != "" {
			rows.WriteString("<div class=\"subtle\">")
			rows.WriteString(html.EscapeString(matched.Specification))
			rows.WriteString("</div>")
		}
		rows.WriteString("</td><td class=\"center\">")
		rows.WriteString(formatTradePINumber(item.Quantity))
		if strings.TrimSpace(item.Unit) != "" {
			rows.WriteString(" ")
			rows.WriteString(html.EscapeString(item.Unit))
		}
		rows.WriteString("</td><td class=\"number\">")
		rows.WriteString(html.EscapeString(quote.Currency))
		rows.WriteString(" ")
		rows.WriteString(formatTradePIMoney(item.UnitPrice))
		rows.WriteString("</td><td class=\"number strong\">")
		rows.WriteString(html.EscapeString(quote.Currency))
		rows.WriteString(" ")
		rows.WriteString(formatTradePIMoney(item.Amount))
		rows.WriteString("</td><td>")
		if matched != nil {
			rows.WriteString(html.EscapeString(strings.TrimSpace(matched.Description)))
		}
		rows.WriteString("</td></tr>")
	}
	for index := len(quote.Items); index < 4; index++ {
		rows.WriteString(`<tr class="blank-row"><td class="center">` + strconv.Itoa(index+1) + `</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`)
	}
	if quote.FreightMode == "quoted" && quote.FreightAmount > 0 {
		rows.WriteString(`<tr><td></td><td>Freight<br>运费</td><td></td><td></td><td></td><td class="number strong">` + html.EscapeString(quote.Currency) + ` ` + formatTradePIMoney(quote.FreightAmount) + `</td><td></td></tr>`)
	}
	notes := strings.TrimSpace(strings.Join([]string{document.Notes, profile.DefaultNotes}, "\n"))
	shipTo := mergeTradeDestination(order.DestinationCountry, order.DestinationPort)
	if shipTo == "" {
		shipTo = customerAddress
	}
	otherTerms := strings.TrimSpace(strings.Join(nonEmptyTradePIStrings(
		"Validity / 有效期: "+document.ValidUntil.Format("2006-01-02"),
		"Delivery terms / 交付条款: "+document.DeliveryTerms,
		notes,
	), "\n"))

	bankContent := ""
	if document.BankDetailsImageDataURI != "" {
		bankContent = `<div class="bank-image"><img src="` + document.BankDetailsImageDataURI + `" alt="Bank account details"></div>`
	} else {
		bankContent = `<div class="bank-grid"><span>Account Name</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.AccountName, profile.CompanyName, "-")) + `</strong><span>Bank Name</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.BankName, "-")) + `</strong><span>Account No.</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.AccountNumber, "-")) + `</strong><span>SWIFT / BIC</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.SwiftCode, "-")) + `</strong><span>Bank Address</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.BankAddress, "-")) + `</strong><span>Beneficiary Address</span><strong>` + html.EscapeString(firstNonEmptyTrade(profile.BeneficiaryAddress, "-")) + `</strong></div>`
	}

	var builder strings.Builder
	builder.Grow(28 * 1024)
	builder.WriteString(`<!doctype html><html><head><meta charset="utf-8"><style>`)
	builder.WriteString(`@font-face{font-family:'` + sheetPDFBaseFontFamily + `';src:url(data:font/ttf;base64,` + sheetPDFFontBase64 + `) format('truetype');font-weight:100 900}`)
	builder.WriteString(`@page{size:A4 portrait;margin:0}*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff;color:#111;font-family:'` + sheetPDFBaseFontFamily + `',Arial,sans-serif;font-size:8.5px;line-height:1.25}.page{width:210mm;min-height:297mm;padding:7mm 7mm 6mm}.title{height:15mm;display:flex;align-items:center;justify-content:center;border-bottom:.3mm solid #159447;font-size:21px;font-weight:800}.pi{width:100%;border-collapse:collapse;table-layout:fixed}.pi th,.pi td{border:.25mm solid #222;padding:1.25mm 1.5mm;vertical-align:middle;overflow-wrap:anywhere}.pi .section{background:#fffed2;text-align:center;font-weight:800}.pi .label{width:26mm;text-align:center;font-weight:700;background:#fffed2}.pi .field-label{display:inline-block;min-width:20mm;font-weight:700}.pi .party td{height:7.5mm}.pi .party-value{font-weight:700}.items{width:100%;border-collapse:collapse;table-layout:fixed}.items th,.items td{border:.25mm solid #222;padding:1.4mm 1.2mm;vertical-align:middle}.items th{background:#fffed2;text-align:center;font-weight:800}.items tbody tr{height:7mm;break-inside:avoid}.items .blank-row{height:7mm}.center{text-align:center}.number{text-align:right;font-variant-numeric:tabular-nums}.strong{font-weight:800}.subtle{margin-top:.5mm;font-size:7.5px;color:#444}.terms{width:100%;border-collapse:collapse;table-layout:fixed}.terms td{border:.25mm solid #222;padding:1.5mm;vertical-align:middle}.terms .term-label{width:27mm;background:#fffed2;text-align:center;font-weight:800}.preline{white-space:pre-line}.bank-cell{height:48mm;padding:2mm 3mm!important}.bank-image{height:43mm;display:flex;align-items:center;justify-content:flex-start;overflow:hidden}.bank-image img{display:block;max-width:100%;max-height:43mm;object-fit:contain;object-position:left center}.bank-grid{display:grid;grid-template-columns:28mm minmax(0,1fr);gap:1.2mm 3mm;align-items:start}.bank-grid span{color:#555}.signature-cell{height:15mm;text-align:center;vertical-align:bottom!important}.footer{margin-top:2mm;text-align:right;font-size:7.5px;color:#555}`)
	builder.WriteString(`</style></head><body><main class="page"><div class="title">PROFORMA INVOICE</div>`)
	builder.WriteString(`<table class="pi"><colgroup><col style="width:50%"><col style="width:50%"></colgroup><tbody>`)
	builder.WriteString(`<tr><th class="section">PI DATE 合同日</th><th class="section">PI NO. 合同号</th></tr><tr><td class="center strong">` + document.IssueDate.Format("2006-01-02") + `</td><td class="center strong">` + html.EscapeString(document.PINumber) + `</td></tr>`)
	builder.WriteString(`<tr><th class="section">Seller 卖方</th><th class="section">Buyer 买方</th></tr>`)
	builder.WriteString(`<tr class="party"><td><span class="field-label">Company:</span><span class="party-value">` + html.EscapeString(profile.CompanyName) + `</span></td><td><span class="field-label">Company:</span><span class="party-value">` + html.EscapeString(customerName) + `</span></td></tr>`)
	builder.WriteString(`<tr class="party"><td><span class="field-label">Add:</span>` + html.EscapeString(firstNonEmptyTrade(profile.Address, "-")) + `</td><td><span class="field-label">Add:</span>` + html.EscapeString(firstNonEmptyTrade(customerAddress, shipTo, "-")) + `</td></tr>`)
	builder.WriteString(`<tr class="party"><td><span class="field-label">Contact:</span>` + html.EscapeString(firstNonEmptyTrade(profile.ContactName, "-")) + `</td><td><span class="field-label">Contact:</span>` + html.EscapeString(firstNonEmptyTrade(customerContact, order.CustomerName, "-")) + `</td></tr>`)
	builder.WriteString(`<tr class="party"><td><span class="field-label">Tel:</span>` + html.EscapeString(firstNonEmptyTrade(profile.Phone, "-")) + `</td><td><span class="field-label">Tel:</span>` + html.EscapeString(firstNonEmptyTrade(customerPhone, "-")) + `</td></tr>`)
	builder.WriteString(`<tr class="party"><td><span class="field-label">Email:</span>` + html.EscapeString(firstNonEmptyTrade(profile.Email, "-")) + `</td><td><span class="field-label">Email:</span>` + html.EscapeString(firstNonEmptyTrade(customerEmail, "-")) + `<br><span class="field-label">Tax number:</span>-</td></tr></tbody></table>`)
	builder.WriteString(`<table class="items"><colgroup><col style="width:6mm"><col style="width:27mm"><col style="width:49mm"><col style="width:27mm"><col style="width:30mm"><col style="width:31mm"><col style="width:26mm"></colgroup><thead><tr><th>No.</th><th>Products<br>产品</th><th>Model Number</th><th>Order Quantity<br>订单数</th><th>UNIT PRICE<br>(` + html.EscapeString(quote.Currency) + `) 单价</th><th>Total<br>(` + html.EscapeString(quote.Currency) + `) 合计金额</th><th>Remarks 备注</th></tr></thead><tbody>`)
	builder.WriteString(rows.String())
	builder.WriteString(`<tr><td colspan="4"></td><td class="center strong">Total:</td><td class="number strong">` + html.EscapeString(quote.Currency) + ` ` + formatTradePIMoney(totalAmount) + `</td><td></td></tr></tbody></table>`)
	builder.WriteString(`<table class="terms"><tbody><tr><td class="term-label">备货期 Prepare time:</td><td>` + html.EscapeString(firstNonEmptyTrade(document.DeliveryTime, "As agreed")) + `</td></tr><tr><td class="term-label">Payment Plan<br>付款计划:</td><td>` + html.EscapeString(firstNonEmptyTrade(document.PaymentMethod, "As agreed")) + `</td></tr><tr><td class="term-label">Ship to:</td><td class="strong">` + html.EscapeString(firstNonEmptyTrade(shipTo, "As agreed")) + `</td></tr><tr><td class="term-label">Bank Account:</td><td class="bank-cell">` + bankContent + `</td></tr><tr><td class="term-label">其他 Others:</td><td class="preline">` + html.EscapeString(otherTerms) + `</td></tr><tr><td class="term-label">Seller Rep. Signature<br>卖方代表签字</td><td class="signature-cell"><strong>` + html.EscapeString(firstNonEmptyTrade(profile.ContactName, profile.CompanyName)) + `</strong> &nbsp;&nbsp;&nbsp;&nbsp; Buyer Rep. Signature / 买方代表签字: ____________________</td></tr></tbody></table>`)
	builder.WriteString(`<div class="footer">` + html.EscapeString(document.PINumber) + ` · This document is computer generated.</div></main></body></html>`)
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

func mergeTradeDestination(values ...string) string {
	parts := make([]string, 0, len(values))
	seen := make(map[string]struct{}, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		parts = append(parts, value)
	}
	return strings.Join(parts, " · ")
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
