package service

import (
	"strings"
	"testing"
)

func TestReadAIResponseBodyIsBounded(t *testing.T) {
	if _, err := readAIResponseBody(strings.NewReader(strings.Repeat("x", maxAIResponseBytes+1))); err == nil {
		t.Fatal("oversized AI response should be rejected")
	}
	if data, err := readAIResponseBody(strings.NewReader("ok")); err != nil || string(data) != "ok" {
		t.Fatalf("small AI response = %q, err=%v", data, err)
	}
}
