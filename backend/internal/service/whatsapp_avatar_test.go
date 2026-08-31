package service

import (
	"crypto/sha256"
	"strings"
	"testing"
)

func TestWhatsAppAvatarProxyURLIsSigned(t *testing.T) {
	service := &WhatsAppService{encryptionKey: sha256.Sum256([]byte("avatar-test-secret"))}
	avatarURL := service.avatarProxyURL(8, "8613800000000@c.us")
	if !strings.HasPrefix(avatarURL, "/api/whatsapp/avatar/8/") {
		t.Fatalf("unexpected avatar proxy URL: %s", avatarURL)
	}
	if !strings.Contains(avatarURL, "expires=") || !strings.Contains(avatarURL, "signature=") {
		t.Fatalf("avatar proxy URL must contain expiration and signature: %s", avatarURL)
	}
	if service.signAvatarRequest(8, "8613800000000@c.us", 100) == service.signAvatarRequest(8, "8613900000000@c.us", 100) {
		t.Fatal("different WhatsApp contacts must not share a signature")
	}
}
