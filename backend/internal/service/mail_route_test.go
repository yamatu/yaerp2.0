package service

import (
	"net"
	"strings"
	"testing"

	"yaerp/internal/model"
)

func coreProvider(globalSwitch bool) func(bool) *model.MailServerSettings {
	core := &model.MailServerSettings{ProxyType: "socks5", ProxyHost: "proxy", ProxyPort: 7890}
	return func(forced bool) *model.MailServerSettings {
		if forced || globalSwitch {
			return core
		}
		return nil
	}
}

func TestResolveMailRouteModes(t *testing.T) {
	server := &model.MailServerSettings{ProxyType: "none"}
	cases := []struct {
		name         string
		globalSwitch bool
		mode         string
		wantProxy    bool
		wantStrict   bool
	}{
		{"global switch off", false, "global", false, false},
		{"global switch on falls back", true, "global", true, false},
		{"forced on ignores the switch", false, "on", true, true},
		{"off ignores the switch", true, "off", false, false},
	}
	for _, tc := range cases {
		svc := &MailService{}
		svc.SetProxyOverrideProvider(coreProvider(tc.globalSwitch))
		route, err := svc.resolveMailRoute(server, &model.MailAccount{ProxyMode: tc.mode})
		if err != nil {
			t.Fatalf("%s: %v", tc.name, err)
		}
		if (route.proxy != nil) != tc.wantProxy || route.strict != tc.wantStrict {
			t.Fatalf("%s: got proxy=%v strict=%v", tc.name, route.proxy != nil, route.strict)
		}
	}
}

func TestResolveMailRouteForcedWithoutAnyProxy(t *testing.T) {
	svc := &MailService{}
	_, err := svc.resolveMailRoute(&model.MailServerSettings{ProxyType: "none"}, &model.MailAccount{ProxyMode: "on"})
	if err == nil || !strings.Contains(err.Error(), "始终走代理") {
		t.Fatalf("expected an explanatory error, got %v", err)
	}
}

func TestMailHostIsPrivate(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":         true,
		"192.168.1.20":      true,
		"10.0.0.5":          true,
		"100.64.3.4":        true,
		"poste":             true,
		"mail.lan":          true,
		"localhost":         true,
		"8.8.8.8":           false,
		"[::1]":             true,
		"2001:4860:4860::8": false,
	}
	for host, want := range cases {
		if got := mailHostIsPrivate(host); got != want {
			t.Fatalf("%s: got %v want %v", host, got, want)
		}
	}
}

func listenOnce(t *testing.T) (string, func()) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			_ = conn.Close()
		}
	}()
	return listener.Addr().String(), func() { _ = listener.Close() }
}

func deadProxyRoute(t *testing.T, strict bool) mailRoute {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().(*net.TCPAddr)
	_ = listener.Close()
	return mailRoute{
		proxy:  &model.MailServerSettings{ProxyType: "socks5", ProxyHost: "127.0.0.1", ProxyPort: addr.Port},
		strict: strict,
	}
}

// Proxy nodes often refuse mail ports; in "跟随全局" mode the mailbox must still
// connect directly instead of failing.
func TestMailRouteDialerFallsBackToDirect(t *testing.T) {
	target, stop := listenOnce(t)
	defer stop()

	dialer, err := (&MailService{}).dialerForRoute(deadProxyRoute(t, false))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dialer.Dial("tcp", target)
	if err != nil {
		t.Fatalf("expected a direct fallback, got %v", err)
	}
	_ = conn.Close()
}

func TestMailRouteDialerStrictDoesNotFallBack(t *testing.T) {
	target, stop := listenOnce(t)
	defer stop()

	dialer, err := (&MailService{}).dialerForRoute(deadProxyRoute(t, true))
	if err != nil {
		t.Fatal(err)
	}
	if conn, err := dialer.Dial("tcp", target); err == nil {
		_ = conn.Close()
		t.Fatal("a mailbox forced through the proxy connected directly")
	}
}

// A self-hosted Poste.io on the LAN or in docker is unreachable from a remote
// proxy node, so the XTLS core route connects to it directly.
func TestMailRouteDialerBypassesCoreForPrivateHosts(t *testing.T) {
	target, stop := listenOnce(t)
	defer stop()

	route := deadProxyRoute(t, true)
	route.viaCore = true
	dialer, err := (&MailService{}).dialerForRoute(route)
	if err != nil {
		t.Fatal(err)
	}
	conn, err := dialer.Dial("tcp", target)
	if err != nil {
		t.Fatalf("a private mail server should bypass the core, got %v", err)
	}
	_ = conn.Close()
}
