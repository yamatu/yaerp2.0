package repo

import (
	"github.com/DATA-DOG/go-sqlmock"
	"github.com/lib/pq"
	"testing"
	"time"
)

func TestEscapeSheetSearchLikeUsesLiteralWildcards(t *testing.T) {
	for _, test := range []struct{ input, want string }{{"最新", "最新"}, {`50%_\path`, `50\%\_\\path`}} {
		if got := escapeSheetSearchLike(test.input); got != test.want {
			t.Fatalf("%q: %q != %q", test.input, got, test.want)
		}
	}
}

func TestSheetSearchRejectsInvalidQueriesBeforeDatabase(t *testing.T) {
	r := &SheetRepo{}
	for _, query := range []SheetContentQuery{{Keywords: []string{"x"}}, {SheetID: 1}, {SheetID: 1, Keywords: []string{" "}}} {
		if _, err := r.SearchSheetContent(query); err == nil {
			t.Fatalf("accepted %+v", query)
		}
	}
}

func TestSheetSearchBindsPatternsAndEmptyColumnArray(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	mock.ExpectQuery("WITH target AS").WithArgs(int64(1), pq.Array([]string{"name"}), 0, pq.Array([]string{`%50\%\_%`}), false, pq.Array([]string{}), 80).
		WillReturnRows(sqlmock.NewRows([]string{"row_num", "source_row", "data"}).AddRow(2, 2, []byte(`{"name":"50%_discount"}`)))
	rows, err := NewSheetRepo(db).SearchSheetContent(SheetContentQuery{SheetID: 1, OrderedColumnKeys: []string{"name"}, Keywords: []string{"50%_"}})
	if err != nil || len(rows) != 1 || rows[0].Row != 2 {
		t.Fatalf("%+v %v", rows, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestSearchCatalogOmitsSnapshotsButKeepsRules(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	now := time.Now()
	mock.ExpectQuery("COALESCE.* - 'univerSheetData' - 'univerStyles'").WithArgs(int64(1)).WillReturnRows(sqlmock.NewRows([]string{"id", "workbook_id", "name", "sort_order", "columns", "config", "created_at", "updated_at"}).AddRow(2, 1, "visible", 0, []byte(`[]`), []byte(`{"sheetState":{"isHidden":false},"protectionRows":[]}`), now, now))
	sheets, err := NewSheetRepo(db).GetSearchSheets(1)
	if err != nil || len(sheets) != 1 {
		t.Fatalf("%+v %v", sheets, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}
