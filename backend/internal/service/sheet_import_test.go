package service

import "testing"

func TestInferImportedColumnTypeTreatsIdentifiersAsText(t *testing.T) {
	tests := []struct {
		name    string
		header  string
		samples []string
		want    string
	}{
		{
			name:    "employee id header stays text",
			header:  "员工编号",
			samples: []string{"10001", "10002", "10003"},
			want:    "text",
		},
		{
			name:    "mobile numbers stay text",
			header:  "手机号",
			samples: []string{"13800138000", "13900139000"},
			want:    "text",
		},
		{
			name:    "unlabeled long numeric codes stay text",
			header:  "列1",
			samples: []string{"202403140001", "202403140002"},
			want:    "text",
		},
		{
			name:    "age stays numeric",
			header:  "年龄",
			samples: []string{"28", "35", "41"},
			want:    "number",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, _ := inferImportedColumnType(tc.header, tc.samples)
			if got != tc.want {
				t.Fatalf("inferImportedColumnType(%q, %v) = %q, want %q", tc.header, tc.samples, got, tc.want)
			}
		})
	}
}

func TestImportedSampleLooksLikeIdentifier(t *testing.T) {
	tests := []struct {
		sample string
		want   bool
	}{
		{sample: "001234", want: true},
		{sample: "13800138000", want: true},
		{sample: "202403140001", want: true},
		{sample: "123.45", want: false},
		{sample: "-12", want: false},
		{sample: "42", want: false},
	}

	for _, tc := range tests {
		if got := importedSampleLooksLikeIdentifier(tc.sample); got != tc.want {
			t.Fatalf("importedSampleLooksLikeIdentifier(%q) = %v, want %v", tc.sample, got, tc.want)
		}
	}
}

func TestAllImportedSamplesLookLikeIdentifiers(t *testing.T) {
	if !allImportedSamplesLookLikeIdentifiers([]string{"202403140001", "202403140002"}) {
		t.Fatal("expected long numeric codes to be treated as identifiers")
	}
	if allImportedSamplesLookLikeIdentifiers([]string{"28", "35"}) {
		t.Fatal("did not expect short numeric values to be treated as identifiers")
	}
}

func TestDetectImportedHeaderRowIndexSkipsTitleRow(t *testing.T) {
	rows := [][]string{
		{"外贸工作日志模板（请勿改表头名称）"},
		{"询价日期", "客户", "型号", "物品数量"},
		{"46046", "美国Lorrine", "MDS-B-V2-2020", ""},
	}

	got := detectImportedHeaderRowIndex(rows)
	if got != 1 {
		t.Fatalf("detectImportedHeaderRowIndex() = %d, want 1", got)
	}
}

func TestParseImportedDateSupportsExcelSerial(t *testing.T) {
	got, ok := parseImportedDate("46046")
	if !ok {
		t.Fatal("expected Excel serial date to parse")
	}
	if got != "2026-01-24" {
		t.Fatalf("parseImportedDate(\"46046\") = %q, want %q", got, "2026-01-24")
	}
}

func TestIsImportedSummaryRow(t *testing.T) {
	if !isImportedSummaryRow([]string{"", "", "", "Total", "$35.20", "", "#VALUE!"}) {
		t.Fatal("expected summary row to be skipped")
	}
	if isImportedSummaryRow([]string{"46046", "美国Lorrine", "MDS-B-V2-2020", "", "$841"}) {
		t.Fatal("did not expect normal data row to be treated as summary")
	}
}
