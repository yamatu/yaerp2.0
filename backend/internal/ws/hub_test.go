package ws

import (
	"bytes"
	"testing"
	"time"
)

func waitFor(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("condition was not met before timeout")
}

func TestHubRemovesSlowClientsWithoutPerMessageGoroutines(t *testing.T) {
	hub := NewHub()
	go hub.Run()
	defer hub.Close()

	sender := NewClient(hub, 1, "sender")
	receiver := NewClient(hub, 2, "receiver")
	if !hub.Register(sender) || !hub.Register(receiver) {
		t.Fatal("failed to register clients")
	}
	waitFor(t, func() bool { return hub.ClientCount() == 2 })
	hub.JoinSheet(sender, 42)
	hub.JoinSheet(receiver, 42)

	// Fill the receiver queue. The next broadcast must remove it without
	// spawning a goroutine that waits on the unregister channel.
	for i := 0; i < clientSendBuffer; i++ {
		receiver.Send <- []byte("queued")
	}
	if !hub.BroadcastToSheet(42, []byte("overflow"), sender) {
		t.Fatal("broadcast should be accepted by the hub queue")
	}
	waitFor(t, func() bool { return hub.ClientCount() == 1 })
	if got := hub.SlowClientCount(); got != 1 {
		t.Fatalf("slow client count = %d, want 1", got)
	}
}

func TestHubBroadcastIsBoundedAndCopiesPayload(t *testing.T) {
	hub := NewHub()
	payload := []byte("original")
	for i := 0; i < hubBroadcastBuffer; i++ {
		if !hub.BroadcastToSheet(7, payload, nil) {
			t.Fatalf("broadcast %d unexpectedly dropped", i)
		}
	}
	if hub.BroadcastToSheet(7, payload, nil) {
		t.Fatal("broadcast queue should be bounded")
	}
	payload[0] = 'X'
	queued := <-hub.broadcast
	if !bytes.Equal(queued.Data, []byte("original")) {
		t.Fatalf("queued payload was mutated: %q", queued.Data)
	}
}

func TestHubCloseIsIdempotent(t *testing.T) {
	hub := NewHub()
	client := NewClient(hub, 1, "user")
	if !hub.Register(client) {
		t.Fatal("register failed")
	}
	hub.Close()
	hub.Close()
	select {
	case _, ok := <-client.Send:
		if ok {
			t.Fatal("client channel should be closed")
		}
	default:
		t.Fatal("client channel was not closed")
	}
	if hub.Register(client) {
		t.Fatal("closed client must not be registered again")
	}
}

func TestRegisterAndImmediateUnregisterCannotRetainClient(t *testing.T) {
	hub := NewHub()
	client := NewClient(hub, 1, "user")
	if !hub.Register(client) {
		t.Fatal("register failed")
	}
	hub.Unregister(client)
	if got := hub.ClientCount(); got != 0 {
		t.Fatalf("client count = %d, want 0", got)
	}
	select {
	case _, ok := <-client.Send:
		if ok {
			t.Fatal("client channel should be closed")
		}
	default:
		t.Fatal("client channel was not closed")
	}
}
