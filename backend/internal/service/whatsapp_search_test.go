package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestWhatsAppChatNameLooksGenerated(t *testing.T) {
	if !whatsAppChatNameLooksGenerated("8619852854439", "8619852854439@c.us") {
		t.Fatal("numeric WhatsApp identifier should be treated as generated")
	}
	if whatsAppChatNameLooksGenerated("bob", "8619852854439@c.us") {
		t.Fatal("resolved customer name should not be treated as generated")
	}
}

func TestPreferredWhatsAppChatAlias(t *testing.T) {
	aliases := []string{"8619852854439", "bob", "Bob Trading Ltd"}
	if actual := preferredWhatsAppChatAlias(aliases, "8619852854439@c.us"); actual != "bob" {
		t.Fatalf("preferred alias = %q, want bob", actual)
	}
}

func TestDeduplicateWhatsAppChats(t *testing.T) {
	chats := []model.WhatsAppChat{
		{ID: "8619852854439@c.us", Name: "8619852854439", Timestamp: 10, LastMessage: "old", UnreadCount: 1},
		{ID: "8619852854439@c.us", Name: "bob", Timestamp: 20, LastMessage: "new", UnreadCount: 3},
	}
	result := deduplicateWhatsAppChats(chats)
	if len(result) != 1 {
		t.Fatalf("deduplicated chat count = %d, want 1", len(result))
	}
	if result[0].Name != "bob" || result[0].LastMessage != "new" || result[0].UnreadCount != 3 {
		t.Fatalf("unexpected merged chat: %+v", result[0])
	}
}
