package repo

import (
	"testing"

	"github.com/lib/pq"
)

func TestNonNilMailAddresses(t *testing.T) {
	empty := nonNilMailAddresses(nil)
	if empty == nil {
		t.Fatal("expected nil forwarding addresses to become a non-nil empty slice")
	}
	if len(empty) != 0 {
		t.Fatalf("expected empty forwarding addresses, got %v", empty)
	}
	value, err := pq.Array(empty).Value()
	if err != nil {
		t.Fatalf("encode forwarding addresses: %v", err)
	}
	if value != "{}" {
		t.Fatalf("expected PostgreSQL empty array, got %#v", value)
	}

	addresses := []string{"notify@example.com"}
	result := nonNilMailAddresses(addresses)
	if len(result) != 1 || result[0] != addresses[0] {
		t.Fatalf("expected configured forwarding addresses to be preserved, got %v", result)
	}
}
