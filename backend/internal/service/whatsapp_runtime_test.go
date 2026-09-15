package service

import (
	"testing"

	"yaerp/internal/model"
)

func TestWhatsAppRuntimeSnapshotFromStatus(t *testing.T) {
	cases := []struct {
		name      string
		status    string
		raw       map[string]interface{}
		lastError string
		want      whatsAppRuntimeSnapshot
	}{
		{
			name:   "ready session keeps every field",
			status: "ready",
			raw: map[string]interface{}{
				"wid":           "8613800000000@c.us",
				"pushname":      " Yara ",
				"profilePicUrl": "https://example.com/a.jpg",
				"about":         "hello",
				"platform":      "android",
			},
			want: whatsAppRuntimeSnapshot{
				Status: "ready", WhatsAppID: "8613800000000@c.us", DisplayName: "Yara",
				PhoneNumber: "8613800000000", ProfilePicURL: "https://example.com/a.jpg",
				About: "hello", Platform: "android",
			},
		},
		{
			name:   "disconnected session reports nothing",
			status: " disconnected ",
			raw:    map[string]interface{}{},
			want:   whatsAppRuntimeSnapshot{Status: "disconnected"},
		},
		{
			name:      "failure keeps the sidecar error",
			status:    "error",
			raw:       map[string]interface{}{"wid": "1@c.us"},
			lastError: "  boom  ",
			want:      whatsAppRuntimeSnapshot{Status: "error", WhatsAppID: "1@c.us", PhoneNumber: "1", LastError: "boom"},
		},
		{
			name:   "non string payload values are ignored",
			status: "ready",
			raw:    map[string]interface{}{"wid": 42, "pushname": nil},
			want:   whatsAppRuntimeSnapshot{Status: "ready"},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := whatsAppRuntimeSnapshotFromStatus(testCase.status, testCase.raw, testCase.lastError)
			if got != testCase.want {
				t.Fatalf("snapshot mismatch:\n got %+v\nwant %+v", got, testCase.want)
			}
		})
	}
}

func TestWhatsAppRuntimeSnapshotMatches(t *testing.T) {
	account := &model.WhatsAppAccount{
		Status: "ready", WhatsAppID: "8613800000000@c.us", DisplayName: "Yara",
		PhoneNumber: "8613800000000", ProfilePicURL: "https://example.com/a.jpg",
		About: "hello", Platform: "android",
	}
	identical := whatsAppRuntimeSnapshotFromStatus("ready", map[string]interface{}{
		"wid": "8613800000000@c.us", "pushname": "Yara", "about": "hello",
		"profilePicUrl": "https://example.com/a.jpg", "platform": "android",
	}, "")
	if !identical.matches(account) {
		t.Fatalf("an unchanged session must not be written again: %+v", identical)
	}
	if identical.matches(nil) {
		t.Fatalf("a nil account must never match")
	}

	changed := map[string]func(whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot{
		"status":          func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.Status = "qr"; return s },
		"whatsapp id":     func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.WhatsAppID = "1@c.us"; return s },
		"display name":    func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.DisplayName = "Other"; return s },
		"phone number":    func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.PhoneNumber = "1"; return s },
		"profile picture": func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.ProfilePicURL = "x"; return s },
		"about":           func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.About = ""; return s },
		"platform":        func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.Platform = "web"; return s },
		"last error":      func(s whatsAppRuntimeSnapshot) whatsAppRuntimeSnapshot { s.LastError = "boom"; return s },
	}
	for name, mutate := range changed {
		t.Run(name, func(t *testing.T) {
			if mutate(identical).matches(account) {
				t.Fatalf("a changed %s must be persisted", name)
			}
		})
	}
}

func TestWhatsAppRuntimeSnapshotIdentityFallback(t *testing.T) {
	account := &model.WhatsAppAccount{
		Status: "ready", WhatsAppID: "8613800000000@c.us", DisplayName: "Yara",
		PhoneNumber: "8613800000000", ProfilePicURL: "https://example.com/a.jpg", Platform: "android",
	}
	// A profile-only reply must not wipe the stored identity.
	merged := whatsAppRuntimeSnapshotFromStatus("ready", map[string]interface{}{"about": "new"}, "").withIdentityFallback(account)
	if merged.WhatsAppID != account.WhatsAppID || merged.DisplayName != account.DisplayName ||
		merged.PhoneNumber != account.PhoneNumber || merged.ProfilePicURL != account.ProfilePicURL ||
		merged.Platform != account.Platform {
		t.Fatalf("identity was dropped: %+v", merged)
	}
	if merged.About != "new" {
		t.Fatalf("the new about must win: %q", merged.About)
	}

	// A reply that does carry a value must override the stored one.
	updated := whatsAppRuntimeSnapshotFromStatus("ready", map[string]interface{}{
		"wid": "999@c.us", "pushname": "New",
	}, "").withIdentityFallback(account)
	if updated.WhatsAppID != "999@c.us" || updated.DisplayName != "New" || updated.PhoneNumber != "999" {
		t.Fatalf("reported values must win: %+v", updated)
	}

	if got := (whatsAppRuntimeSnapshot{}).withIdentityFallback(nil); got != (whatsAppRuntimeSnapshot{}) {
		t.Fatalf("nil account must be a no-op: %+v", got)
	}
}
