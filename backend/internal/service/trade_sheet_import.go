package service

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/richardlehane/mscfb"
	"github.com/xuri/excelize/v2"
	"golang.org/x/text/encoding/simplifiedchinese"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

// The monthly order workbook (外贸工作表YYMM.xlsx) lists one closed deal per
// row: customer, contract date, goods amount in USD, PayPal/bank fee, freight
// charged to the customer, actual freight in CNY, the ship-to address and the
// tracking number, with a package photo embedded next to the row and one
// settlement rate (汇率) for the whole month under the table.

const TradeOrderSheetMaxBytes = 60 << 20

var (
	tradeSheetFileMonthPattern = regexp.MustCompile(`(?:^|\D)(\d{2})(0[1-9]|1[0-2])(?:\D|$)`)
	tradeSheetCountryPattern   = regexp.MustCompile(`^([\p{Han}]{2,})\s*(.*)$`)
	tradeSheetTrackingSplit    = regexp.MustCompile(`[+,，;；/、\s]+`)
	tradeSheetPIPattern        = regexp.MustCompile(`^(\d{8,9}-\d{3})`)
	tradeSheetRefPattern       = regexp.MustCompile(`\d-\d{5,6}`)
	tradeSheetOleRowPattern    = regexp.MustCompile(`(?s)<(?:\w+:)?oleObject\b[^>]*\br:id="([^"]+)"[^>]*>\s*<(?:\w+:)?objectPr\b.*?<(?:\w+:)?from>.*?<(?:\w+:)?row>(\d+)</(?:\w+:)?row>`)
	tradeSheetRelPattern       = regexp.MustCompile(`<Relationship\b[^>]*>`)
	tradeSheetAttrPattern      = regexp.MustCompile(`(\w+(?::\w+)?)="([^"]*)"`)
	tradeSheetUPSPattern       = regexp.MustCompile(`^1Z[0-9A-Z]{16}$`)
	tradeSheetPostalPattern    = regexp.MustCompile(`^[A-Z]{2}\d{9}[A-Z]{2}$`)
	tradeSheetDigitsPattern    = regexp.MustCompile(`^\d+$`)
)

type tradeSheetImage struct {
	name        string
	contentType string
	data        []byte
}

type tradeSheetParsed struct {
	preview model.TradeOrderSheetPreview
	images  map[int][]tradeSheetImage
}

type tradeSheetColumns struct {
	customer, date, goods, fee, freight, actualFreight, remark, tracking int
	known                                                                map[int]bool
}

// PreviewOrderSheet reads a monthly order workbook without saving anything.
func (s *TradeService) PreviewOrderSheet(userID int64, fileName string, data []byte, sheet string) (*model.TradeOrderSheetPreview, error) {
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanCreateOrders {
		return nil, fmt.Errorf("当前岗位没有录入订单的权限")
	}
	parsed, err := parseTradeOrderSheet(data, fileName, sheet, s.Modules())
	if err != nil {
		return nil, err
	}
	if err := s.matchTradeSheetRows(userID, access, parsed.preview.Rows); err != nil {
		return nil, err
	}
	return &parsed.preview, nil
}

func (s *TradeService) matchTradeSheetRows(userID int64, access *tradeUserAccess, rows []model.TradeOrderSheetRow) error {
	customers, err := s.repo.ListCustomers(userID, access.profile.CanViewAllOrders, "")
	if err != nil {
		return err
	}
	index := tradeSheetCustomerIndex(customers)
	keys := make([]string, 0, len(rows))
	for _, row := range rows {
		keys = append(keys, row.ImportKey)
	}
	existing, err := s.repo.ImportedOrderNumbers(keys)
	if err != nil {
		return err
	}
	for i := range rows {
		row := &rows[i]
		if customer := index.match(row.CustomerLabel, row.CustomerName); customer != nil {
			row.MatchedCustomerID = customer.ID
			row.MatchedCustomerName = firstNonEmptyTrade(customer.Name, customer.CompanyName)
		}
		if orderNo := existing[row.ImportKey]; orderNo != "" {
			row.ExistingOrderNo = orderNo
			if !row.Skip {
				row.Skip, row.SkipReason = true, "已导入为 "+orderNo
			}
		}
	}
	return nil
}

// ApplyOrderSheet creates a completed deal order for every chosen row of the
// workbook. Rows are independent: one failing row does not stop the others,
// and rows imported before are skipped.
func (s *TradeService) ApplyOrderSheet(userID int64, fileName string, data []byte, request *model.TradeOrderSheetApplyRequest) (*model.TradeOrderSheetImportResult, error) {
	if request == nil {
		return nil, fmt.Errorf("导入内容不能为空")
	}
	access, err := s.loadTradeUserAccess(userID)
	if err != nil {
		return nil, err
	}
	if !access.profile.CanCreateOrders {
		return nil, fmt.Errorf("当前岗位没有录入订单的权限")
	}
	month, err := normalizeSettlementMonth(request.SettlementMonth)
	if err != nil {
		return nil, err
	}
	if month == "" {
		return nil, fmt.Errorf("请选择这些订单所属的账期月份")
	}
	currency := strings.ToUpper(firstNonEmptyTrade(strings.TrimSpace(request.Currency), "USD"))
	rate := normalizeTradeOrderRate(currency, request.ExchangeRate)
	if rate <= 0 {
		return nil, fmt.Errorf("表格里没有结汇汇率，请填写 1 %s 兑多少人民币", currency)
	}
	ownerID := userID
	if request.OwnerID > 0 && request.OwnerID != userID {
		if !access.profile.CanViewAllOrders {
			return nil, fmt.Errorf("只有管理员或业务负责人可以把客户分配给其他业务员")
		}
		if _, err := s.userRepo.GetByID(request.OwnerID); err != nil {
			return nil, fmt.Errorf("所选业务员不存在")
		}
		ownerID = request.OwnerID
	}
	if request.CustomerID > 0 {
		if _, err := s.getCustomer(userID, request.CustomerID); err != nil {
			return nil, fmt.Errorf("所选客户不存在或无权访问")
		}
	}
	parsed, err := parseTradeOrderSheet(data, fileName, request.Sheet, s.Modules())
	if err != nil {
		return nil, err
	}
	if err := s.matchTradeSheetRows(userID, access, parsed.preview.Rows); err != nil {
		return nil, err
	}
	sheetRows := make(map[int]model.TradeOrderSheetRow, len(parsed.preview.Rows))
	for _, row := range parsed.preview.Rows {
		sheetRows[row.RowNumber] = row
	}
	result := &model.TradeOrderSheetImportResult{Rows: []model.TradeOrderSheetImportRowResult{}}
	createdCustomers := map[string]int64{}
	for _, input := range request.Rows {
		if !input.Import {
			continue
		}
		row, ok := sheetRows[input.RowNumber]
		outcome := model.TradeOrderSheetImportRowResult{RowNumber: input.RowNumber}
		switch {
		case !ok:
			outcome.Status, outcome.Message = "failed", "表格中没有这一行，请重新预览"
		case row.ExistingOrderNo != "":
			outcome.Status, outcome.OrderNo, outcome.Message = "skipped", row.ExistingOrderNo, "之前已导入"
		default:
			order, err := s.importTradeSheetRow(userID, ownerID, request.CustomerID, month, currency, rate, row, input,
				parsed.images[row.RowNumber], createdCustomers)
			switch {
			case errors.Is(err, repo.ErrTradeOrderAlreadyImported):
				outcome.Status, outcome.Message = "skipped", "之前已导入"
			case err != nil:
				outcome.Status, outcome.Message = "failed", err.Error()
				if order != nil {
					outcome.OrderID, outcome.OrderNo = order.ID, order.OrderNo
				}
			default:
				outcome.Status, outcome.OrderID, outcome.OrderNo = "created", order.ID, order.OrderNo
			}
		}
		switch outcome.Status {
		case "created":
			result.Created++
		case "skipped":
			result.Skipped++
		default:
			result.Failed++
		}
		result.Rows = append(result.Rows, outcome)
	}
	return result, nil
}

func (s *TradeService) importTradeSheetRow(
	userID, ownerID, sharedCustomerID int64,
	month, currency string,
	rate float64,
	row model.TradeOrderSheetRow,
	input model.TradeOrderSheetApplyRow,
	images []tradeSheetImage,
	createdCustomers map[string]int64,
) (*model.TradeOrder, error) {
	dealDate := firstNonEmptyTrade(strings.TrimSpace(input.DealDate), row.DealDate)
	if dealDate == "" {
		return nil, fmt.Errorf("缺少合同日期")
	}
	goods := nonNegativeTradeValue(input.GoodsAmount)
	if goods <= 0 {
		return nil, fmt.Errorf("订单金额必须大于零")
	}
	customerName := firstNonEmptyTrade(strings.TrimSpace(input.CustomerName), row.CustomerName, row.CustomerLabel)
	customerID := firstPositiveTradeID(sharedCustomerID, input.CustomerID, row.MatchedCustomerID)
	if customerID == 0 {
		key := tradeSheetNameKey(row.Country + customerName)
		customerID = createdCustomers[key]
		if customerID == 0 {
			customer := &model.TradeCustomer{
				OwnerID: ownerID, Name: customerName, CompanyName: customerName, Country: row.Country,
				Source: "manual", CustomerLevel: "B", Tags: []string{}, Notes: "由月度订单表导入",
			}
			if err := validateTradeCustomerLengths(customer); err != nil {
				return nil, err
			}
			if err := s.repo.CreateCustomer(customer); err != nil {
				return nil, err
			}
			customerID = customer.ID
			createdCustomers[key] = customerID
		}
	}

	title := strings.TrimSpace(row.CustomerLabel)
	if row.PINo != "" {
		title += " · " + row.PINo
	}
	stage := model.TradeStageCompleted
	if len(row.TrackingNumbers) == 0 {
		stage = ""
	}
	order, err := s.CreateOrder(userID, &model.CreateTradeOrderRequest{
		CustomerID: customerID, Title: title, Currency: currency, Confirmed: true,
		ExchangeRateCNY: rate, PaymentFeeAmount: nonNegativeTradeValue(input.PaymentFee),
		DealDate: dealDate, SettlementMonth: month, ShippingAddress: row.ShippingAddress,
		Notes: row.Notes, ImportKey: row.ImportKey, ImportStage: stage,
		Items: []model.CreateTradeOrderItemRequest{{
			ProductName: "整单货款（表格导入）", Specification: row.PINo, Quantity: 1, Unit: "单",
			SalesPrice: goods, FreightAmount: nonNegativeTradeValue(input.FreightAmount),
		}},
	})
	if err != nil {
		return nil, err
	}
	if len(order.Items) > 0 {
		for _, image := range images {
			attachment, _, uploadErr := s.uploadSvc.UploadBytes(image.name, image.contentType, image.data, userID)
			if uploadErr != nil {
				return order, fmt.Errorf("订单已创建，但图片 %s 上传失败：%v", image.name, uploadErr)
			}
			if err := s.repo.AddItemImage(order.ID, order.Items[0].ID, attachment.ID, userID); err != nil {
				return order, fmt.Errorf("订单已创建，但图片 %s 关联失败：%v", image.name, err)
			}
		}
	}
	if parcels := tradeSheetParcels(row, nonNegativeTradeValue(input.ActualFreightCNY)); len(parcels) > 0 {
		if err := s.repo.ReplaceParcels(order.ID, parcels, tradeParcelSummary(parcels)); err != nil {
			return order, fmt.Errorf("订单已创建，但物流信息保存失败：%v", err)
		}
	}
	s.notifyOrderUpdated(order.ID)
	return order, nil
}

func firstPositiveTradeID(values ...int64) int64 {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

// tradeSheetParcels makes one shipped parcel per tracking number; the actual
// freight of the row goes on the first one.
func tradeSheetParcels(row model.TradeOrderSheetRow, actualFreightCNY float64) []model.TradeParcel {
	numbers := row.TrackingNumbers
	if len(numbers) == 0 && actualFreightCNY <= 0 {
		return nil
	}
	if len(numbers) == 0 {
		numbers = []string{""}
	}
	parcels := make([]model.TradeParcel, 0, len(numbers))
	for index, number := range numbers {
		parcel := model.TradeParcel{
			ParcelNo: index + 1, Carrier: tradeSheetCarrier(number), TrackingNo: number,
			ShippingStatus: tradeParcelShipped, ActualFreightCurrency: "CNY", ActualFreightToCNYRate: 1,
			Boxes: []model.TradeParcelBox{},
		}
		if number == "" {
			parcel.ShippingStatus = "未发货"
		}
		if index == 0 {
			parcel.ActualFreightAmount = actualFreightCNY
			parcel.Notes = row.ActualFreightNote
		}
		parcels = append(parcels, parcel)
	}
	return parcels
}

// tradeSheetCarrier guesses the carrier from the tracking number format.
func tradeSheetCarrier(number string) string {
	number = strings.ToUpper(strings.TrimSpace(number))
	switch {
	case number == "":
		return ""
	case tradeSheetUPSPattern.MatchString(number):
		return "UPS"
	case tradeSheetPostalPattern.MatchString(number):
		return "邮政 EMS"
	case tradeSheetDigitsPattern.MatchString(number) && (len(number) == 12 || len(number) == 15):
		return "FedEx"
	case tradeSheetDigitsPattern.MatchString(number) && len(number) == 10:
		return "DHL"
	default:
		return ""
	}
}

type tradeSheetCustomers map[string][]*model.TradeCustomer

func tradeSheetCustomerIndex(customers []model.TradeCustomer) tradeSheetCustomers {
	index := tradeSheetCustomers{}
	for i := range customers {
		customer := &customers[i]
		keys := map[string]bool{
			tradeSheetNameKey(customer.Name):                    true,
			tradeSheetNameKey(customer.CompanyName):             true,
			tradeSheetNameKey(customer.Country + customer.Name): true,
		}
		for key := range keys {
			if key != "" {
				index[key] = append(index[key], customer)
			}
		}
	}
	return index
}

// match finds the one customer named like the sheet label; ambiguous names
// match nobody so the user picks by hand.
func (index tradeSheetCustomers) match(label, name string) *model.TradeCustomer {
	for _, key := range []string{tradeSheetNameKey(label), tradeSheetNameKey(name)} {
		candidates := index[key]
		unique := map[int64]*model.TradeCustomer{}
		for _, candidate := range candidates {
			unique[candidate.ID] = candidate
		}
		if len(unique) == 1 {
			return candidates[0]
		}
	}
	return nil
}

func tradeSheetNameKey(value string) string {
	var builder strings.Builder
	for _, r := range strings.ToLower(value) {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			builder.WriteRune(r)
		}
	}
	return builder.String()
}

func parseTradeOrderSheet(data []byte, fileName, wantedSheet string, modules model.TradeModules) (*tradeSheetParsed, error) {
	if len(data) == 0 {
		return nil, fmt.Errorf("请选择要导入的 Excel 文件")
	}
	book, err := excelize.OpenReader(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("无法读取这个文件，请确认是 .xlsx 格式（.xls 请先在 Excel 里另存为 .xlsx）")
	}
	defer book.Close()

	type candidate struct {
		name    string
		rows    [][]string
		header  int
		columns tradeSheetColumns
	}
	candidates := make([]candidate, 0)
	for _, name := range book.GetSheetList() {
		rows, err := book.GetRows(name, excelize.Options{RawCellValue: true})
		if err != nil {
			continue
		}
		for index := 0; index < len(rows) && index < 10; index++ {
			if columns, ok := tradeSheetHeader(rows[index]); ok {
				candidates = append(candidates, candidate{name: name, rows: rows, header: index, columns: columns})
				break
			}
		}
	}
	if len(candidates) == 0 {
		return nil, fmt.Errorf("没有找到包含「客户名称、合同日期、订单金额」表头的工作表")
	}
	chosen := candidates[0]
	sheets := make([]string, 0, len(candidates))
	for _, item := range candidates {
		sheets = append(sheets, item.name)
		if item.name == wantedSheet {
			chosen = item
		}
	}

	preview := model.TradeOrderSheetPreview{
		FileName: fileName, Sheet: chosen.name, Sheets: sheets, Currency: "USD",
		Rows: []model.TradeOrderSheetRow{}, Warnings: []string{},
	}
	preview.ExchangeRate = tradeSheetRate(chosen.rows)
	if preview.ExchangeRate <= 0 {
		preview.Warnings = append(preview.Warnings, "表格中没有找到「汇率」，请在下方填写本月结汇汇率")
	}

	seenKeys := map[string]int{}
	for index := chosen.header + 1; index < len(chosen.rows); index++ {
		cells := chosen.rows[index]
		label := tradeSheetCell(cells, chosen.columns.customer)
		if label == "" {
			if tradeSheetIsTotalRow(cells) {
				break
			}
			continue
		}
		row := buildTradeSheetRow(index+1, cells, chosen.columns)
		if previous, ok := seenKeys[row.ImportKey]; ok && !row.Skip {
			row.Skip, row.SkipReason = true, fmt.Sprintf("与第 %d 行重复", previous)
		} else {
			seenKeys[row.ImportKey] = row.RowNumber
		}
		preview.Rows = append(preview.Rows, row)
	}
	if len(preview.Rows) == 0 {
		return nil, fmt.Errorf("工作表「%s」里没有订单行", chosen.name)
	}

	images, imageWarnings := tradeSheetImages(data, book, chosen.name)
	preview.Warnings = append(preview.Warnings, imageWarnings...)
	regroupTradeSheetImages(images)
	for index := range preview.Rows {
		row := &preview.Rows[index]
		for _, image := range images[row.RowNumber] {
			row.Images = append(row.Images, model.TradeOrderSheetImage{Name: image.name, Size: len(image.data)})
			if row.PINo == "" {
				if match := tradeSheetPIPattern.FindStringSubmatch(image.name); match != nil {
					row.PINo = match[1]
				}
			}
		}
		if row.Images == nil {
			row.Images = []model.TradeOrderSheetImage{}
		}
	}
	preview.SettlementMonth, preview.SettlementMonthSource = tradeSheetMonth(fileName, preview.Rows, modules)
	return &tradeSheetParsed{preview: preview, images: images}, nil
}

func tradeSheetHeader(cells []string) (tradeSheetColumns, bool) {
	columns := tradeSheetColumns{customer: -1, date: -1, goods: -1, fee: -1, freight: -1, actualFreight: -1, remark: -1, tracking: -1, known: map[int]bool{}}
	for index, raw := range cells {
		text := strings.ToLower(strings.Join(strings.Fields(raw), ""))
		if text == "" {
			continue
		}
		assign := func(target *int) {
			if *target < 0 {
				*target = index
				columns.known[index] = true
			}
		}
		switch {
		case strings.Contains(text, "客户"):
			assign(&columns.customer)
		case strings.Contains(text, "日期"):
			assign(&columns.date)
		case text == "订单金额" || text == "订单金额usd" || text == "金额":
			assign(&columns.goods)
		case strings.Contains(text, "paypal") || strings.Contains(text, "手续费") || strings.Contains(text, "银行费"):
			assign(&columns.fee)
		case strings.Contains(text, "运费") && (strings.Contains(text, "人民币") || strings.Contains(text, "rmb") || strings.Contains(text, "cny")):
			assign(&columns.actualFreight)
		case text == "运费" || text == "运费usd" || text == "运费美金":
			assign(&columns.freight)
		case strings.Contains(text, "物流单号") || strings.Contains(text, "运单号") || strings.Contains(text, "快递单号") || strings.Contains(text, "tracking"):
			assign(&columns.tracking)
		case text == "备注" || strings.Contains(text, "地址"):
			assign(&columns.remark)
		default:
			// 序号, 总金额, 订单金额人民币, 提成, 利润 and a second 运费 column are
			// derived or bookkeeping values; they are not imported or noted.
			columns.known[index] = true
		}
	}
	return columns, columns.customer >= 0 && columns.date >= 0 && columns.goods >= 0
}

func buildTradeSheetRow(rowNumber int, cells []string, columns tradeSheetColumns) model.TradeOrderSheetRow {
	label := strings.Join(strings.Fields(tradeSheetCell(cells, columns.customer)), " ")
	row := model.TradeOrderSheetRow{
		RowNumber: rowNumber, CustomerLabel: label, CustomerName: label,
		TrackingNumbers: []string{}, Problems: []string{}, Images: []model.TradeOrderSheetImage{},
	}
	if match := tradeSheetCountryPattern.FindStringSubmatch(label); match != nil && strings.TrimSpace(match[2]) != "" {
		row.Country, row.CustomerName = match[1], strings.TrimSpace(match[2])
	}
	if date, ok := parseTradeSheetDate(tradeSheetCell(cells, columns.date)); ok {
		row.DealDate = date.Format("2006-01-02")
	}
	row.GoodsAmount, _ = parseTradeSheetAmount(tradeSheetCell(cells, columns.goods))
	row.PaymentFee, _ = parseTradeSheetAmount(tradeSheetCell(cells, columns.fee))
	row.FreightAmount, _ = parseTradeSheetAmount(tradeSheetCell(cells, columns.freight))
	if text := tradeSheetCell(cells, columns.actualFreight); text != "" {
		if amount, ok := parseTradeSheetAmount(text); ok {
			row.ActualFreightCNY = amount
		} else {
			row.ActualFreightNote = text
		}
	}

	notes := make([]string, 0)
	remark := strings.TrimSpace(tradeSheetCell(cells, columns.remark))
	if lines := tradeSheetLines(remark); len(lines) >= 2 {
		row.ShippingAddress = strings.Join(lines, "\n")
	} else if remark != "" {
		notes = append(notes, remark)
	}
	addTracking := func(number string) {
		number = strings.ToUpper(strings.TrimSpace(number))
		if len(number) >= 6 && !containsTradeString(row.TrackingNumbers, number) {
			row.TrackingNumbers = append(row.TrackingNumbers, number)
		}
	}
	for _, part := range tradeSheetTrackingSplit.Split(tradeSheetCell(cells, columns.tracking), -1) {
		addTracking(part)
	}
	for index, cell := range cells {
		text := strings.TrimSpace(cell)
		if text == "" || columns.known[index] {
			continue
		}
		notes = append(notes, text)
		// A second shipment (补发) is often noted next to the row.
		if upper := strings.ToUpper(text); tradeSheetUPSPattern.MatchString(upper) || tradeSheetPostalPattern.MatchString(upper) {
			addTracking(upper)
		}
	}
	row.Notes = strings.Join(notes, "；")

	switch {
	case row.GoodsAmount <= 0 && row.DealDate == "":
		row.Skip, row.SkipReason = true, "没有合同日期和订单金额"
	case row.GoodsAmount <= 0:
		row.Skip, row.SkipReason = true, "订单金额为空"
	case row.DealDate == "":
		row.Skip, row.SkipReason = true, "缺少合同日期"
	}
	if !row.Skip && row.ActualFreightCNY <= 0 && len(row.TrackingNumbers) > 0 {
		row.Problems = append(row.Problems, "实际运费（人民币）未填，利润暂不完整")
	}
	if !row.Skip && len(row.TrackingNumbers) == 0 {
		row.Problems = append(row.Problems, "没有物流单号，订单会停在发货前的环节")
	}
	row.ImportKey = fmt.Sprintf("sheet:%s:%s:%.2f", strings.ReplaceAll(row.DealDate, "-", ""), tradeSheetNameKey(label), row.GoodsAmount)
	return row
}

func tradeSheetCell(cells []string, index int) string {
	if index < 0 || index >= len(cells) {
		return ""
	}
	return strings.TrimSpace(cells[index])
}

func tradeSheetLines(value string) []string {
	lines := make([]string, 0)
	for _, line := range strings.Split(strings.ReplaceAll(value, "\r\n", "\n"), "\n") {
		if line = strings.TrimSpace(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func tradeSheetIsTotalRow(cells []string) bool {
	for _, cell := range cells {
		if strings.Contains(cell, "小计") || strings.Contains(cell, "合计") || strings.Contains(cell, "总计") {
			return true
		}
	}
	return false
}

// tradeSheetRate reads the number next to the 汇率 label under the table.
func tradeSheetRate(rows [][]string) float64 {
	for _, cells := range rows {
		for index, cell := range cells {
			if !strings.Contains(cell, "汇率") {
				continue
			}
			for next := index + 1; next < len(cells); next++ {
				if rate, ok := parseTradeSheetAmount(cells[next]); ok && rate > 0 && rate < 100 {
					return rate
				}
			}
		}
	}
	return 0
}

func parseTradeSheetAmount(value string) (float64, bool) {
	cleaned := strings.NewReplacer(",", "", "，", "", "$", "", "¥", "", "￥", "", " ", "").Replace(strings.TrimSpace(value))
	if cleaned == "" {
		return 0, false
	}
	amount, err := strconv.ParseFloat(cleaned, 64)
	if err != nil || math.IsNaN(amount) || math.IsInf(amount, 0) {
		return 0, false
	}
	return math.Round(amount*100) / 100, true
}

// parseTradeSheetDate reads 20261026, an Excel date serial or a written date.
func parseTradeSheetDate(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return time.Time{}, false
	}
	if tradeSheetDigitsPattern.MatchString(value) && len(value) == 8 {
		parsed, err := time.ParseInLocation("20060102", value, time.Local)
		return parsed, err == nil
	}
	if serial, err := strconv.ParseFloat(value, 64); err == nil {
		if serial < 20000 || serial > 80000 {
			return time.Time{}, false
		}
		base := time.Date(1899, time.December, 30, 0, 0, 0, 0, time.Local)
		return base.AddDate(0, 0, int(serial)), true
	}
	for _, layout := range []string{"2006-01-02", "2006/1/2", "2006.1.2", "2006-1-2", "2006年1月2日"} {
		if parsed, err := time.ParseInLocation(layout, value, time.Local); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

// tradeSheetMonth reads the cycle from a file name like 外贸工作表2611, or
// takes the cycle most deal dates fall in.
func tradeSheetMonth(fileName string, rows []model.TradeOrderSheetRow, modules model.TradeModules) (string, string) {
	base := strings.TrimSuffix(path.Base(strings.ReplaceAll(fileName, "\\", "/")), path.Ext(fileName))
	if matches := tradeSheetFileMonthPattern.FindAllStringSubmatch(base, -1); len(matches) > 0 {
		match := matches[len(matches)-1]
		return fmt.Sprintf("20%s-%s", match[1], match[2]), "filename"
	}
	counts := map[string]int{}
	for _, row := range rows {
		if date, err := time.ParseInLocation("2006-01-02", row.DealDate, time.Local); err == nil && !row.Skip {
			counts[modules.SettlementMonthFor(date)]++
		}
	}
	best, bestCount := "", 0
	for month, count := range counts {
		if count > bestCount || (count == bestCount && month > best) {
			best, bestCount = month, count
		}
	}
	if best == "" {
		return modules.SettlementMonthFor(time.Now()), "today"
	}
	return best, "dates"
}

// tradeSheetImages collects the photos of each row: pictures placed in cells
// and files embedded as packaged OLE objects (Excel's 插入对象), keyed by the
// 1-based row they are anchored to.
func tradeSheetImages(data []byte, book *excelize.File, sheet string) (map[int][]tradeSheetImage, []string) {
	images := map[int][]tradeSheetImage{}
	warnings := []string{}
	if cells, err := book.GetPictureCells(sheet); err == nil {
		for _, cell := range cells {
			_, row, err := excelize.CellNameToCoordinates(cell)
			if err != nil {
				continue
			}
			pictures, _ := book.GetPictures(sheet, cell)
			for index, picture := range pictures {
				contentType := http.DetectContentType(picture.File)
				if !strings.HasPrefix(contentType, "image/") {
					continue
				}
				name := fmt.Sprintf("%s-%d%s", cell, index+1, picture.Extension)
				images[row] = append(images[row], tradeSheetImage{name: name, contentType: contentType, data: picture.File})
			}
		}
	}
	embedded, skipped, err := tradeSheetEmbeddedFiles(data, sheet)
	if err != nil {
		warnings = append(warnings, "读取表格中嵌入的图片失败："+err.Error())
	}
	for row, files := range embedded {
		images[row] = append(images[row], files...)
	}
	if skipped > 0 {
		warnings = append(warnings, fmt.Sprintf("有 %d 个嵌入的附件不是图片，未导入", skipped))
	}
	return images, warnings
}

// regroupTradeSheetImages moves a photo named only by the internal order
// number (1-31822.jpg) to the row whose PI photo carries that number
// (20261008-002 1-31822.jpg); photos dropped next to the wrong row are common.
func regroupTradeSheetImages(images map[int][]tradeSheetImage) {
	owners := map[string]map[int]bool{}
	for row, files := range images {
		for _, file := range files {
			if !tradeSheetPIPattern.MatchString(file.name) {
				continue
			}
			for _, ref := range tradeSheetRefPattern.FindAllString(file.name, -1) {
				if owners[ref] == nil {
					owners[ref] = map[int]bool{}
				}
				owners[ref][row] = true
			}
		}
	}
	rows := make([]int, 0, len(images))
	for row := range images {
		rows = append(rows, row)
	}
	sort.Ints(rows)
	for _, row := range rows {
		kept := images[row][:0]
		for _, file := range images[row] {
			target := row
			if !tradeSheetPIPattern.MatchString(file.name) {
				if ref := tradeSheetRefPattern.FindString(file.name); ref != "" && len(owners[ref]) == 1 {
					for owner := range owners[ref] {
						target = owner
					}
				}
			}
			if target == row {
				kept = append(kept, file)
			} else {
				images[target] = append(images[target], file)
			}
		}
		images[row] = kept
	}
}

func tradeSheetEmbeddedFiles(data []byte, sheet string) (map[int][]tradeSheetImage, int, error) {
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, 0, err
	}
	files := map[string]*zip.File{}
	for _, file := range archive.File {
		files[file.Name] = file
	}
	read := func(name string) ([]byte, error) {
		file := files[name]
		if file == nil {
			return nil, fmt.Errorf("missing %s", name)
		}
		reader, err := file.Open()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(io.LimitReader(reader, TradeOrderSheetMaxBytes))
	}
	sheetPath, err := tradeSheetXMLPath(read, sheet)
	if err != nil {
		return nil, 0, err
	}
	sheetXML, err := read(sheetPath)
	if err != nil {
		return nil, 0, err
	}
	relsPath := path.Join(path.Dir(sheetPath), "_rels", path.Base(sheetPath)+".rels")
	targets := map[string]string{}
	if rels, err := read(relsPath); err == nil {
		targets = tradeSheetRelationships(rels, path.Dir(sheetPath))
	}
	result := map[int][]tradeSheetImage{}
	skipped := 0
	for _, match := range tradeSheetOleRowPattern.FindAllSubmatch(sheetXML, -1) {
		target := targets[string(match[1])]
		zeroRow, _ := strconv.Atoi(string(match[2]))
		if target == "" {
			continue
		}
		raw, err := read(target)
		if err != nil {
			continue
		}
		name, payload, err := tradeSheetPackagePayload(raw)
		if err != nil {
			skipped++
			continue
		}
		contentType := http.DetectContentType(payload)
		if !strings.HasPrefix(contentType, "image/") {
			skipped++
			continue
		}
		result[zeroRow+1] = append(result[zeroRow+1], tradeSheetImage{name: name, contentType: contentType, data: payload})
	}
	for row := range result {
		sort.SliceStable(result[row], func(a, b int) bool { return result[row][a].name < result[row][b].name })
	}
	return result, skipped, nil
}

func tradeSheetXMLPath(read func(string) ([]byte, error), sheet string) (string, error) {
	workbook, err := read("xl/workbook.xml")
	if err != nil {
		return "", err
	}
	rels, err := read("xl/_rels/workbook.xml.rels")
	if err != nil {
		return "", err
	}
	targets := tradeSheetRelationships(rels, "xl")
	for _, tag := range regexp.MustCompile(`<(?:\w+:)?sheet\b[^>]*>`).FindAll(workbook, -1) {
		attrs := tradeSheetAttrs(tag)
		if attrs["name"] == sheet {
			if target := targets[attrs["r:id"]]; target != "" {
				return target, nil
			}
		}
	}
	return "", fmt.Errorf("找不到工作表 %s", sheet)
}

func tradeSheetRelationships(rels []byte, baseDir string) map[string]string {
	targets := map[string]string{}
	for _, tag := range tradeSheetRelPattern.FindAll(rels, -1) {
		attrs := tradeSheetAttrs(tag)
		target := attrs["Target"]
		if attrs["Id"] == "" || target == "" {
			continue
		}
		if strings.HasPrefix(target, "/") {
			target = strings.TrimPrefix(target, "/")
		} else {
			target = path.Clean(path.Join(baseDir, target))
		}
		targets[attrs["Id"]] = target
	}
	return targets
}

func tradeSheetAttrs(tag []byte) map[string]string {
	attrs := map[string]string{}
	for _, match := range tradeSheetAttrPattern.FindAllSubmatch(tag, -1) {
		attrs[string(match[1])] = string(match[2])
	}
	return attrs
}

// tradeSheetPackagePayload unwraps a file Excel embedded through a packager
// object: an OLE compound file whose Ole10Native stream holds the name and
// the bytes.
func tradeSheetPackagePayload(raw []byte) (string, []byte, error) {
	reader, err := mscfb.New(bytes.NewReader(raw))
	if err != nil {
		return "", nil, err
	}
	for entry, err := reader.Next(); err == nil; entry, err = reader.Next() {
		if !strings.HasSuffix(entry.Name, "Ole10Native") {
			continue
		}
		stream, err := io.ReadAll(entry)
		if err != nil {
			return "", nil, err
		}
		return parseOle10Native(stream)
	}
	return "", nil, fmt.Errorf("not a packaged file")
}

// parseOle10Native: total size, flags, label, source path, reserved, temp
// path (length-prefixed), then the length-prefixed file data.
func parseOle10Native(stream []byte) (string, []byte, error) {
	invalid := fmt.Errorf("invalid Ole10Native stream")
	position := 6
	readString := func() (string, bool) {
		end := bytes.IndexByte(stream[min(position, len(stream)):], 0)
		if end < 0 {
			return "", false
		}
		value := stream[position : position+end]
		position += end + 1
		return tradeSheetDecodeName(value), true
	}
	readUint32 := func() (int, bool) {
		if position+4 > len(stream) {
			return 0, false
		}
		value := int(binary.LittleEndian.Uint32(stream[position:]))
		position += 4
		return value, true
	}
	if len(stream) < position {
		return "", nil, invalid
	}
	name, ok := readString()
	if !ok {
		return "", nil, invalid
	}
	if _, ok := readString(); !ok {
		return "", nil, invalid
	}
	position += 4
	tempLength, ok := readUint32()
	if !ok || tempLength < 0 || position+tempLength > len(stream) {
		return "", nil, invalid
	}
	position += tempLength
	size, ok := readUint32()
	if !ok || size <= 0 || position+size > len(stream) {
		return "", nil, invalid
	}
	return name, stream[position : position+size], nil
}

// tradeSheetDecodeName decodes the ANSI file name a Chinese Windows Excel
// writes (GBK); plain ASCII and UTF-8 pass through.
func tradeSheetDecodeName(value []byte) string {
	if isASCIIOrUTF8(value) {
		return string(value)
	}
	if decoded, err := simplifiedchinese.GBK.NewDecoder().Bytes(value); err == nil {
		return string(decoded)
	}
	return string(bytes.ToValidUTF8(value, []byte("?")))
}

func isASCIIOrUTF8(value []byte) bool {
	for _, b := range value {
		if b >= 0x80 {
			return bytes.Equal(bytes.ToValidUTF8(value, nil), value)
		}
	}
	return true
}
