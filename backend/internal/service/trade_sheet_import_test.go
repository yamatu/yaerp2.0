package service

import (
	"bytes"
	"encoding/binary"
	"testing"

	"github.com/xuri/excelize/v2"

	"yaerp/internal/model"
)

func monthlyOrderWorkbook(t *testing.T, withRate bool) []byte {
	t.Helper()
	book := excelize.NewFile()
	defer book.Close()
	sheet := "6月份"
	if err := book.SetSheetName("Sheet1", sheet); err != nil {
		t.Fatal(err)
	}
	rows := [][]any{
		{"6月份销售额"},
		{"序号", "客户名称", "合同日期", "订单金额", "Paypal费/银行费", "总金额", "运费", "订单金额 人民币", "运费  人民币", "提成3%", "利润", "备注", "物流单号", "运费"},
		{1, "美国 Bob Kirk", 20261026, 800, 59.45, 859.45, 389, nil, "计费27kg", nil, nil, "301 S 12th Street\nMillville, NJ 08332\nUS", "1Z70W0426625363558", nil, nil, "电池罚款"},
		{2, "美国Brad", 20261030, 316, 21.7, 337.7, 118, nil, 840, nil, nil, "8303 McHard Rd\nHouston, TX 77053\nUS", "384166122472+384166116205"},
		{3, "美国Cory", 20261008, 335, 20.15, 355.15, 68, nil, 580, nil, nil, "补发", "384166012365", nil, nil, nil, "补发一个", "1Z70W0420434811065"},
		{4, "美国Lean", nil, nil, nil, 0},
		{5, "美国Brad", 20261030, 316, 21.7},
		{},
		{nil, nil, "美金小计：", 1451},
	}
	if withRate {
		rows = append(rows, []any{nil, nil, "汇率：", 6.6})
	}
	for index, row := range rows {
		cell, _ := excelize.CoordinatesToCellName(1, index+1)
		if err := book.SetSheetRow(sheet, cell, &row); err != nil {
			t.Fatal(err)
		}
	}
	var buffer bytes.Buffer
	if err := book.Write(&buffer); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func TestParseTradeOrderSheet(t *testing.T) {
	parsed, err := parseTradeOrderSheet(monthlyOrderWorkbook(t, true), "副本A外贸工作表2611.xlsx", "", model.DefaultTradeModules())
	if err != nil {
		t.Fatal(err)
	}
	preview := parsed.preview
	if preview.SettlementMonth != "2026-11" || preview.SettlementMonthSource != "filename" || preview.ExchangeRate != 6.6 {
		t.Fatalf("month/rate: %s %s %v", preview.SettlementMonth, preview.SettlementMonthSource, preview.ExchangeRate)
	}
	if len(preview.Rows) != 5 {
		t.Fatalf("expected 5 rows before the totals, got %d", len(preview.Rows))
	}
	bob := preview.Rows[0]
	if bob.Country != "美国" || bob.CustomerName != "Bob Kirk" || bob.DealDate != "2026-10-26" || bob.GoodsAmount != 800 ||
		bob.PaymentFee != 59.45 || bob.FreightAmount != 389 || bob.ActualFreightCNY != 0 || bob.ActualFreightNote != "计费27kg" {
		t.Fatalf("unexpected first row: %#v", bob)
	}
	if bob.ShippingAddress != "301 S 12th Street\nMillville, NJ 08332\nUS" || bob.Notes != "电池罚款" || bob.Skip {
		t.Fatalf("address/notes: %#v", bob)
	}
	if brad := preview.Rows[1]; len(brad.TrackingNumbers) != 2 || brad.ActualFreightCNY != 840 {
		t.Fatalf("two parcels expected: %#v", brad)
	}
	if cory := preview.Rows[2]; len(cory.TrackingNumbers) != 2 || cory.TrackingNumbers[1] != "1Z70W0420434811065" || cory.Notes != "补发；补发一个；1Z70W0420434811065" {
		t.Fatalf("re-shipment tracking should be picked up from the notes: %#v", cory)
	}
	if lean := preview.Rows[3]; !lean.Skip {
		t.Fatalf("empty placeholder rows are skipped: %#v", lean)
	}
	if dup := preview.Rows[4]; !dup.Skip || dup.SkipReason != "与第 4 行重复" {
		t.Fatalf("the same deal twice is flagged: %#v", dup)
	}
}

func TestParseTradeOrderSheetWithoutRate(t *testing.T) {
	parsed, err := parseTradeOrderSheet(monthlyOrderWorkbook(t, false), "orders.xlsx", "", model.TradeModules{SettlementStartDay: 26})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.preview.ExchangeRate != 0 || len(parsed.preview.Warnings) == 0 {
		t.Fatalf("a missing rate must be reported: %#v", parsed.preview)
	}
	// Oct 26 and Oct 30 fall in the November cycle, Oct 8 in October.
	if parsed.preview.SettlementMonth != "2026-11" || parsed.preview.SettlementMonthSource != "dates" {
		t.Fatalf("month from dates: %s %s", parsed.preview.SettlementMonth, parsed.preview.SettlementMonthSource)
	}
}

func TestParseOle10Native(t *testing.T) {
	payload := []byte{0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3}
	var stream bytes.Buffer
	stream.Write(make([]byte, 6))
	stream.WriteString("20261026-001 1-32067-2.jpg\x00")
	stream.WriteString("C:\\photos\\a.jpg\x00")
	stream.Write([]byte{0, 0, 3, 0})
	temp := []byte("C:\\Temp\\a.jpg\x00")
	_ = binary.Write(&stream, binary.LittleEndian, uint32(len(temp)))
	stream.Write(temp)
	_ = binary.Write(&stream, binary.LittleEndian, uint32(len(payload)))
	stream.Write(payload)
	name, data, err := parseOle10Native(stream.Bytes())
	if err != nil || name != "20261026-001 1-32067-2.jpg" || !bytes.Equal(data, payload) {
		t.Fatalf("got %q %v %v", name, data, err)
	}
	if _, _, err := parseOle10Native(stream.Bytes()[:20]); err == nil {
		t.Fatal("a truncated stream must fail")
	}
	gbk := []byte{0xb0, 0xfc, 0xb9, 0xfc} // 包裹 in GBK
	if got := tradeSheetDecodeName(gbk); got != "包裹" {
		t.Fatalf("GBK name decoded as %q", got)
	}
}

func TestTradeSheetCarrierAndPhotos(t *testing.T) {
	for number, want := range map[string]string{
		"1Z70W0426625363558": "UPS", "384166122472": "FedEx", "4594525003": "DHL", "AT102750716CN": "邮政 EMS", "X1": "",
	} {
		if got := tradeSheetCarrier(number); got != want {
			t.Fatalf("%s: got %q want %q", number, got, want)
		}
	}
	images := map[int][]tradeSheetImage{
		16: {{name: "1-31822.jpg"}, {name: "20261008-001 31826.jpg"}},
		17: {{name: "20261008-002 1-31822.jpg"}},
	}
	regroupTradeSheetImages(images)
	if len(images[16]) != 1 || len(images[17]) != 2 || images[17][1].name != "1-31822.jpg" {
		t.Fatalf("loose photo should follow its order number: %#v", images)
	}
}

func TestTradeSheetCustomerMatch(t *testing.T) {
	index := tradeSheetCustomerIndex([]model.TradeCustomer{
		{ID: 1, Name: "Bob Kirk", Country: "美国"},
		{ID: 2, Name: "Kevin"}, {ID: 3, Name: "kevin "},
	})
	if customer := index.match("美国 Bob Kirk", "Bob Kirk"); customer == nil || customer.ID != 1 {
		t.Fatalf("Bob Kirk should match: %#v", customer)
	}
	if customer := index.match("美国Kevin", "Kevin"); customer != nil {
		t.Fatalf("two customers named Kevin must not auto-match: %#v", customer)
	}
}
