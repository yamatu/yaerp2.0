package service

import (
	"encoding/json"
	"testing"
)

func TestSameJSONText(t *testing.T) {
	cases := []struct {
		left, right string
		want        bool
	}{
		{`{"v":"SKU1"}`, `{"v": "SKU1"}`, true},
		{`{"v":1,"s":"a"}`, "{\"v\": 1,\n \"s\": \"a\"}", true},
		{`{"v":"a b"}`, `{"v":"ab"}`, false},
		{`{"v":"a  b"}`, `{"v":"a b"}`, false},
		{`{"v":"say \"hi\""}`, `{"v": "say \"hi\""}`, true},
		{`{"v":"x\\"}`, `{"v": "x\\"}`, true},
		{`{"v":"x\\", "f":1}`, `{"v":"x\\","f":1}`, true},
		{`{"v":"\" ,"}`, `{"v":"\",", "x":1}`, false},
		{`{"v":1}`, `{"v":10}`, false},
		{`{"v":1}`, `{"v":1} `, true},
		{`{"s":"a","v":1}`, `{"v":1,"s":"a"}`, false},
		{``, ``, true},
		{`{}`, ``, false},
	}
	for _, item := range cases {
		if got := sameJSONText([]byte(item.left), []byte(item.right)); got != item.want {
			t.Errorf("sameJSONText(%s, %s) = %v, want %v", item.left, item.right, got, item.want)
		}
	}
}

func TestSameJSONValueFallsBackToDecoding(t *testing.T) {
	if !sameJSONValue([]byte(`{"s":"a","v":1}`), []byte(`{"v": 1.0, "s": "a"}`)) {
		t.Fatal("reordered keys and an equal number must compare equal")
	}
	if sameJSONValue([]byte(`{"v":1}`), []byte(`{"v":2}`)) {
		t.Fatal("different values must differ")
	}
}

func TestChangedUniverCellsMatchesFullComparison(t *testing.T) {
	snapshot := func(cells string) json.RawMessage {
		return json.RawMessage(`{"univerSheetData":{"rowCount":10,"cellData":` + cells + `}}`)
	}
	current := snapshot(`{"1": {"0": {"v": "a"}, "1": {"v": 2, "s": "x"}, "2": {"v": "gone"}}, "2": {"0": {"v": "keep"}}}`)
	next := snapshot(`{"1":{"0":{"v":"a"},"1":{"s":"x","v":3},"3":{"v":"new"}},"2":{"0":{"v":"keep"}}}`)
	gotCurrent, gotNext := changedUniverCells(current, next)
	wantCurrent, wantNext := changedCellsOnly(extractUniverCellData(current), extractUniverCellData(next))
	if len(gotCurrent) != 3 || len(gotNext) != 3 {
		t.Fatalf("want 3 changed cells, got %v / %v", gotCurrent, gotNext)
	}
	for key, value := range wantCurrent {
		if gotCurrent[key] != value || gotNext[key] != wantNext[key] {
			t.Fatalf("%s: got %q→%q, want %q→%q", key, gotCurrent[key], gotNext[key], value, wantNext[key])
		}
	}
	if _, listed := gotCurrent["2:0"]; listed {
		t.Fatal("an unchanged cell must not be listed")
	}
	if _, listed := gotCurrent["1:0"]; listed {
		t.Fatal("a cell differing only in spacing must not be listed")
	}
}

func TestChangedUniverCellsReadsOddSnapshots(t *testing.T) {
	current := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"a"}},"2":null}}}`)
	next := json.RawMessage(`{"univerSheetData":{"cellData":{"1":{"0":{"v":"b"}},"2":"oops"}}}`)
	gotCurrent, gotNext := changedUniverCells(current, next)
	if gotCurrent["1:0"] != `{"v":"a"}` || gotNext["1:0"] != `{"v":"b"}` {
		t.Fatalf("fallback lost the change: %v / %v", gotCurrent, gotNext)
	}
}

func TestUniverSheetDimensions(t *testing.T) {
	rows, columns := univerSheetDimensions(json.RawMessage(`{"univerSheetData":{"rowCount":20,"columnCount":5,"cellData":{"30":{"7":{"v":1}}}}}`))
	if rows != 31 || columns != 8 {
		t.Fatalf("got %d x %d, want 31 x 8", rows, columns)
	}
	rows, columns = univerSheetDimensions(json.RawMessage(`{"univerSheetData":{"rowCount":20,"columnCount":5,"cellData":{"3":"bad"}}}`))
	if rows != 20 || columns != 5 {
		t.Fatalf("odd snapshot: got %d x %d, want 20 x 5", rows, columns)
	}
}
