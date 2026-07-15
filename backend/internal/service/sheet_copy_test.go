package service

import (
	"encoding/json"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestNextCopiedResourceNameUsesNumberedSuffixes(t *testing.T) {
	existing := []string{
		"采购发票",
		"采购发票 - 副本",
		"采购发票 - 副本 1",
	}

	if got := nextCopiedResourceName("采购发票", existing); got != "采购发票 - 副本 2" {
		t.Fatalf("name = %q, want numbered copy suffix", got)
	}
	if got := nextCopiedResourceName("采购发票 - 副本 1", existing); got != "采购发票 - 副本 2" {
		t.Fatalf("copying an existing copy produced %q", got)
	}
}

func TestNextCopiedResourceNameStartsWithoutNumber(t *testing.T) {
	if got := nextCopiedResourceName("销售台账", []string{"销售台账"}); got != "销售台账 - 副本" {
		t.Fatalf("name = %q, want first copy suffix", got)
	}
}

func TestNextCopiedResourceNameFitsDatabaseLimit(t *testing.T) {
	got := nextCopiedResourceName(strings.Repeat("表", 300), nil)
	if utf8.RuneCountInString(got) != maxCopiedResourceNameRunes {
		t.Fatalf("copied name length = %d, want %d", utf8.RuneCountInString(got), maxCopiedResourceNameRunes)
	}
	if !strings.HasSuffix(got, " - 副本") {
		t.Fatalf("copied name lost suffix: %q", got)
	}
}

func TestDuplicatedWorkbookMetadataRemovesLifecycleAndAssignmentState(t *testing.T) {
	metadata := json.RawMessage(`{
		"workbookState":{"locked":{"id":1}},
		"source_workbook_id":7,
		"assigned_by":1,
		"assigned_at":"2026-07-15T00:00:00Z",
		"importSource":{"filename":"source.xlsx"}
	}`)

	duplicated, err := duplicatedWorkbookMetadata(metadata)
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]interface{}
	if err := json.Unmarshal(duplicated, &payload); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"workbookState", "source_workbook_id", "assigned_by", "assigned_at"} {
		if _, exists := payload[key]; exists {
			t.Fatalf("metadata key %q must not be copied", key)
		}
	}
	if _, exists := payload["importSource"]; !exists {
		t.Fatal("non-lifecycle metadata must be preserved")
	}
}
