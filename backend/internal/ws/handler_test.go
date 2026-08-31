package ws

import "testing"

func TestOriginAllowed(t *testing.T) {
	tests := []struct {
		name    string
		origin  string
		allowed []string
		want    bool
	}{
		{name: "same origin client without header", allowed: []string{"https://erp.example.com"}, want: true},
		{name: "exact origin", origin: "https://erp.example.com", allowed: []string{"https://erp.example.com"}, want: true},
		{name: "trailing slash", origin: "https://erp.example.com/", allowed: []string{"https://erp.example.com/"}, want: true},
		{name: "case insensitive host", origin: "HTTPS://ERP.EXAMPLE.COM", allowed: []string{"https://erp.example.com"}, want: true},
		{name: "wildcard", origin: "https://erp.example.com", allowed: []string{"*"}, want: true},
		{name: "different origin", origin: "https://attacker.example.com", allowed: []string{"https://erp.example.com"}, want: false},
		{name: "empty allow list", origin: "https://erp.example.com", allowed: nil, want: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := originAllowed(test.origin, test.allowed); got != test.want {
				t.Fatalf("originAllowed() = %v, want %v", got, test.want)
			}
		})
	}
}
