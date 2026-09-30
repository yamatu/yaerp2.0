package service

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yaerp/internal/model"
	"yaerp/internal/repo"
)

func TestVisibleSearchPaginatesPastHiddenOnlyPage(t *testing.T) {
	calls := 0
	page, err := scanVisibleSearchRows(0, 2, func(start, size int) ([]repo.SheetContentRow, error) {
		calls++
		if start == 0 {
			rows := make([]repo.SheetContentRow, size)
			for i := range rows {
				rows[i].Row = i
			}
			return rows, nil
		}
		return []repo.SheetContentRow{{Row: 80}, {Row: 81}, {Row: 82}}, nil
	}, func(row repo.SheetContentRow) (*aiPreviewRow, error) {
		if row.Row < 80 {
			return nil, nil
		}
		return &aiPreviewRow{Row: row.Row}, nil
	})
	if err != nil || calls != 2 || len(page.Rows) != 2 || !page.HasMore || page.NextRow != 82 {
		t.Fatalf("calls=%d page=%+v err=%v", calls, page, err)
	}
}

func TestVisibleSearchReportsCandidateBudgetWithoutLeakingHiddenCursor(t *testing.T) {
	page, err := scanVisibleSearchRows(0, 20, func(start, size int) ([]repo.SheetContentRow, error) {
		rows := make([]repo.SheetContentRow, size)
		for i := range rows {
			rows[i].Row = start + i
		}
		return rows, nil
	}, func(repo.SheetContentRow) (*aiPreviewRow, error) { return nil, nil })
	if err != nil || !page.BudgetHit || !page.HasMore || page.NextRow != 0 || len(page.Rows) != 0 {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}

func TestVisibleSearchDoesNotInventMoreMatchesAtExactLimit(t *testing.T) {
	page, err := scanVisibleSearchRows(0, 1, func(start, size int) ([]repo.SheetContentRow, error) {
		return []repo.SheetContentRow{{Row: 3}}, nil
	}, func(row repo.SheetContentRow) (*aiPreviewRow, error) { return &aiPreviewRow{Row: row.Row}, nil })
	if err != nil || page.HasMore || len(page.Rows) != 1 {
		t.Fatalf("%+v %v", page, err)
	}
}

func TestVisibleSearchPropagatesDatabaseErrors(t *testing.T) {
	want := errors.New("database unavailable")
	_, err := scanVisibleSearchRows(0, 1, func(int, int) ([]repo.SheetContentRow, error) { return nil, want },
		func(repo.SheetContentRow) (*aiPreviewRow, error) { t.Fatal("no candidates expected"); return nil, nil })
	if !errors.Is(err, want) {
		t.Fatalf("got %v", err)
	}
}

func TestVisibleRowDataUsesResolvedMatrixWithoutDatabaseCalls(t *testing.T) {
	s := &AIService{} // no repositories: permission checking must be purely in-memory
	matrix := fullAccessMatrix()
	matrix.UserOverrides.Columns["secret"] = "none"
	data, err := s.visibleRowData(1, 2, 3, map[string]interface{}{"name": "visible", "secret": "private"},
		sheetCellFilter{matrix: matrix, protections: protectionMaps{}})
	if err != nil || data["name"] != "visible" || len(data) != 1 {
		t.Fatalf("%v %v", data, err)
	}
}

func TestSearchKeepsLongNumericIDsAndPlainNumberRendering(t *testing.T) {
	data := map[string]interface{}{"number": float64(1234567890123), "long_id": json.Number("12345678901234567890123")}
	for _, keyword := range []string{"1234567890123", "12345678901234567890123"} {
		if !rowDataMayContainKeywords(data, []string{keyword}, "any") || len(collectRowKeywordMatches(data, nil, []string{keyword}, "any")) == 0 {
			t.Fatalf("cannot find %s in %v", keyword, data)
		}
	}
	criteria := map[string]any{"number": float64(1234567890123)}
	if !criteriaMayMatchRow(data, criteria) || len(collectCriteriaMatches(data, []sheetColumnPayload{{Key: "number", Name: "Number"}}, criteria, "exact")) == 0 {
		t.Fatal("numeric criteria must agree with the cheap filter")
	}
}

func TestChatWorkbookContextDoesNotContainCellsOrConfigs(t *testing.T) {
	wb := &model.Workbook{ID: 1, Name: "current", Sheets: []model.Sheet{{ID: 2, Name: "sheet", AccessLevel: "read",
		Columns: json.RawMessage(`[{"key":"name","name":"Name"}]`), Config: json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"SECRET"}}}}}`)}}}
	payload, err := marshalAgentWorkbookContext(wb, []int64{2})
	if err != nil || strings.Contains(payload, "SECRET") || strings.Contains(payload, "cellData") || !strings.Contains(payload, `"content_loaded":false`) {
		t.Fatalf("%s %v", payload, err)
	}
}
