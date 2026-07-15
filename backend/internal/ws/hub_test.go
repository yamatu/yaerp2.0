package ws

import (
	"fmt"
	"testing"
)

func TestBroadcastToSheetByUserBuildsPermissionPayloadOncePerUser(t *testing.T) {
	hub := NewHub()
	firstTab := &Client{UserID: 1, ClientID: "first", Send: make(chan []byte, 1)}
	secondTab := &Client{UserID: 1, ClientID: "second", Send: make(chan []byte, 1)}
	otherUser := &Client{UserID: 2, ClientID: "other", Send: make(chan []byte, 1)}
	excluded := &Client{UserID: 3, ClientID: "excluded", Send: make(chan []byte, 1)}
	hub.sheets[7] = map[*Client]bool{
		firstTab:  true,
		secondTab: true,
		otherUser: true,
		excluded:  true,
	}

	buildCount := map[int64]int{}
	hub.BroadcastToSheetByUser(7, "excluded", func(userID int64) []byte {
		buildCount[userID]++
		return []byte(fmt.Sprintf("user:%d", userID))
	})

	assertClientPayload(t, firstTab, "user:1")
	assertClientPayload(t, secondTab, "user:1")
	assertClientPayload(t, otherUser, "user:2")
	select {
	case payload := <-excluded.Send:
		t.Fatalf("excluded client received payload %q", payload)
	default:
	}
	if buildCount[1] != 1 || buildCount[2] != 1 || buildCount[3] != 0 {
		t.Fatalf("unexpected payload build counts: %#v", buildCount)
	}
}

func assertClientPayload(t *testing.T, client *Client, expected string) {
	t.Helper()
	select {
	case payload := <-client.Send:
		if string(payload) != expected {
			t.Fatalf("received payload %q, expected %q", payload, expected)
		}
	default:
		t.Fatalf("client %d did not receive a payload", client.UserID)
	}
}
