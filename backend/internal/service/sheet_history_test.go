package service

import (
	"encoding/json"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func TestNormalizeSheetVersionSnapshotIsStable(t *testing.T) {
	first := json.RawMessage(`{
		"schema_version":1,
		"sheet":{"name":"采购表","sort_order":2,"columns":{"B":{"type":"number"},"A":{"type":"text"}},"frozen":{},"config":{"zoom":1}},
		"rows":[{"row_index":3,"data":{"B":2,"A":"后"}},{"row_index":0,"data":{"A":"前","B":1}}]
	}`)
	second := json.RawMessage(`{
		"rows":[{"data":{"B":1,"A":"前"},"row_index":0},{"data":{"A":"后","B":2},"row_index":3}],
		"sheet":{"config":{"zoom":1},"frozen":{},"columns":{"A":{"type":"text"},"B":{"type":"number"}},"sort_order":2,"name":"采购表"},
		"schema_version":1
	}`)

	normalizedFirst, snapshot, checksumFirst, err := normalizeSheetVersionSnapshot(first)
	if err != nil {
		t.Fatal(err)
	}
	normalizedSecond, _, checksumSecond, err := normalizeSheetVersionSnapshot(second)
	if err != nil {
		t.Fatal(err)
	}
	if checksumFirst != checksumSecond {
		t.Fatalf("semantically equal snapshots produced different checksums: %s != %s\n%s\n%s", checksumFirst, checksumSecond, normalizedFirst, normalizedSecond)
	}
	if len(snapshot.Rows) != 2 || snapshot.Rows[0].RowIndex != 0 || snapshot.Rows[1].RowIndex != 3 {
		t.Fatalf("rows were not normalized by index: %#v", snapshot.Rows)
	}
}

func TestNormalizeSheetVersionSnapshotRejectsUnsafePayloads(t *testing.T) {
	validSheet := `"sheet":{"name":"Sheet1","sort_order":0,"columns":{},"frozen":{},"config":{}}`
	tests := []struct {
		name string
		raw  string
		want string
	}{
		{name: "unknown field", raw: `{"schema_version":1,` + validSheet + `,"rows":[],"unexpected":true}`, want: "unknown field"},
		{name: "unsupported schema", raw: `{"schema_version":2,` + validSheet + `,"rows":[]}`, want: "unsupported"},
		{name: "duplicate row", raw: `{"schema_version":1,` + validSheet + `,"rows":[{"row_index":0,"data":{}},{"row_index":0,"data":{}}]}`, want: "duplicate row"},
		{name: "negative row", raw: `{"schema_version":1,` + validSheet + `,"rows":[{"row_index":-1,"data":{}}]}`, want: "invalid row"},
		{name: "non object row", raw: `{"schema_version":1,` + validSheet + `,"rows":[{"row_index":0,"data":[1,2]}]}`, want: "must be an object"},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, _, _, err := normalizeSheetVersionSnapshot(json.RawMessage(test.raw))
			if err == nil || !strings.Contains(strings.ToLower(err.Error()), strings.ToLower(test.want)) {
				t.Fatalf("got error %v, want error containing %q", err, test.want)
			}
		})
	}
}

func TestBuildSheetVersionDiffCountsRowsAndCells(t *testing.T) {
	version := &model.SheetVersionSnapshot{
		SchemaVersion: 1,
		Sheet: model.SheetVersionSheetSnapshot{
			Name: "旧名称", SortOrder: 0, Columns: json.RawMessage(`{}`), Frozen: json.RawMessage(`{}`), Config: json.RawMessage(`{}`),
		},
		Rows: []model.SheetVersionRowSnapshot{
			{RowIndex: 0, Data: json.RawMessage(`{"A":"old","B":1}`)},
			{RowIndex: 2, Data: json.RawMessage(`{"A":"removed"}`)},
		},
	}
	current := &model.SheetVersionSnapshot{
		SchemaVersion: 1,
		Sheet: model.SheetVersionSheetSnapshot{
			Name: "新名称", SortOrder: 0, Columns: json.RawMessage(`{}`), Frozen: json.RawMessage(`{}`), Config: json.RawMessage(`{}`),
		},
		Rows: []model.SheetVersionRowSnapshot{
			{RowIndex: 0, Data: json.RawMessage(`{"A":"new","C":true}`)},
			{RowIndex: 1, Data: json.RawMessage(`{"D":"added"}`)},
		},
	}

	diff := buildSheetVersionDiff(version, current, 3)
	if diff.AddedRows != 1 || diff.RemovedRows != 1 || diff.ModifiedRows != 1 {
		t.Fatalf("unexpected row counts: added=%d removed=%d modified=%d", diff.AddedRows, diff.RemovedRows, diff.ModifiedRows)
	}
	if diff.ChangedCells != 5 {
		t.Fatalf("changed cells = %d, want 5", diff.ChangedCells)
	}
	if len(diff.CellChanges) != 3 || !diff.CellChangesLimited {
		t.Fatalf("cell detail limit not applied: len=%d limited=%v", len(diff.CellChanges), diff.CellChangesLimited)
	}
	if len(diff.FieldChanges) != 1 || diff.FieldChanges[0].Field != "name" {
		t.Fatalf("unexpected field changes: %#v", diff.FieldChanges)
	}
}

func TestNormalizeHistoryPageAndSource(t *testing.T) {
	page, size := normalizeHistoryPage(0, 1000, 50)
	if page != 1 || size != 50 {
		t.Fatalf("normalized pagination = %d/%d, want 1/50", page, size)
	}
	if normalizeHistorySource(" AI ") != "ai" || normalizeHistorySource("unknown") != "web" {
		t.Fatal("history source normalization failed")
	}
}
