package service

import (
	"encoding/json"
	"testing"
)

func TestUniverCellValueType(t *testing.T) {
	cases := map[string]string{
		`42`: "2", `-3.5`: "2", `"42"`: "1", `"苹果"`: "1", `true`: "3", `false`: "3", `null`: "", ``: "", `{"a":1}`: "",
	}
	for input, want := range cases {
		if got := univerCellValueType(json.RawMessage(input)); got != want {
			t.Errorf("univerCellValueType(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestAgentUniverCellSetsValueType(t *testing.T) {
	if cell := agentUniverCell(12.5); cell["t"] == nil || string(cell["t"].(json.RawMessage)) != "2" {
		t.Fatalf("number cell = %#v, want t=2", cell)
	}
	if cell := agentUniverCell("=SUM(A1:A2)"); cell["t"] != nil || cell["f"] != "=SUM(A1:A2)" {
		t.Fatalf("formula cell = %#v, want only f", cell)
	}
}
