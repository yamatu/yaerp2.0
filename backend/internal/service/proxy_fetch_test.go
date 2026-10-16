package service

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"yaerp/config"
)

func newTestProxyService() *ProxyService {
	cfg := &config.Config{}
	cfg.Proxy.Enabled = true
	return NewProxyService(cfg, nil)
}

func TestFetchSubscriptionRetriesWithClashFlag(t *testing.T) {
	var paths []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		paths = append(paths, request.URL.RawQuery)
		if request.URL.Query().Get("flag") == "clash" {
			writer.Header().Set("Content-Type", "text/yaml")
			_, _ = writer.Write([]byte("proxies:\n  - name: A\n    type: ss\n    server: 1.1.1.1\n    port: 8388\n    cipher: aes-128-gcm\n    password: p\n"))
			return
		}
		// Plain URL answers with a login page, which cannot be parsed.
		writer.Header().Set("Content-Type", "text/html")
		_, _ = writer.Write([]byte("<!DOCTYPE html><html><body>login</body></html>"))
	}))
	defer server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.AllowPrivateSubscription = true

	payload, err := service.fetchSubscription(server.URL + "/sub?token=abc")
	if err != nil {
		t.Fatalf("fetchSubscription failed: %v", err)
	}
	if !strings.Contains(payload, "name: A") {
		t.Fatalf("expected the flagged answer, got %q", payload)
	}
	if len(paths) != 2 {
		t.Fatalf("expected two attempts, got %v", paths)
	}
	if paths[0] != "token=abc" || paths[1] != "token=abc&flag=clash" {
		t.Fatalf("the subscription token must be preserved verbatim, got %v", paths)
	}
}

func TestFetchSubscriptionKeepsTokenWhenFlagAlreadyPresent(t *testing.T) {
	var queries []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		queries = append(queries, request.URL.RawQuery)
		_, _ = writer.Write([]byte("this is not a subscription"))
	}))
	defer server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.AllowPrivateSubscription = true

	// The payload is returned as-is; the parse error is raised by
	// ImportSubscription so the administrator sees why it failed.
	payload, err := service.fetchSubscription(server.URL + "/sub?flag=clash&token=a+b")
	if err != nil {
		t.Fatalf("fetchSubscription failed: %v", err)
	}
	if payload != "this is not a subscription" {
		t.Fatalf("unexpected payload %q", payload)
	}
	if len(queries) == 0 {
		t.Fatal("the subscription was never requested")
	}
	// Other client identities may be tried, but a URL that already carries a
	// flag must never be rewritten.
	for _, query := range queries {
		if query != "flag=clash&token=a+b" {
			t.Fatalf("the URL must be requested verbatim, got %v", queries)
		}
	}
}

func subscriptionLinkList() string {
	links := "trojan://secret@trojan.example.com:443?sni=trojan.example.com#TR-1\n"
	return base64.StdEncoding.EncodeToString([]byte(links))
}

// A V2Board/XBoard panel whose Clash template is broken answers the Clash
// user agents with Laravel's 500 page while a browser gets the base64 list.
func TestFetchSubscriptionFallsBackWhenClashFormatFails(t *testing.T) {
	var agents []string
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		agent := request.Header.Get("User-Agent")
		agents = append(agents, agent)
		if strings.Contains(strings.ToLower(agent), "clash") || request.URL.Query().Get("flag") != "" {
			writer.Header().Set("Content-Type", "text/html")
			writer.WriteHeader(http.StatusInternalServerError)
			_, _ = writer.Write([]byte(`<!DOCTYPE html><html lang="en"><head><title>Server Error</title><style>/*! normalize.css */</style></head><body>500</body></html>`))
			return
		}
		_, _ = writer.Write([]byte(subscriptionLinkList()))
	}))
	defer server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.AllowPrivateSubscription = true

	payload, err := service.fetchSubscription(server.URL + "/api/v1/client/subscribe?token=abc")
	if err != nil {
		t.Fatalf("fetchSubscription failed: %v", err)
	}
	parsed, err := parseSubscriptionPayload(payload)
	if err != nil || len(parsed.Proxies) != 1 {
		t.Fatalf("expected one node from the fallback answer, got %v (%v)", parsed, err)
	}
	if len(agents) < 2 {
		t.Fatalf("expected a retry with another client identity, got %v", agents)
	}
}

func TestFetchSubscriptionReportsReadableErrorWhenEveryFormatFails(t *testing.T) {
	attempts := 0
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		attempts++
		writer.WriteHeader(http.StatusInternalServerError)
		_, _ = writer.Write([]byte(`<!DOCTYPE html><html><head><title>Server Error</title><style>body{}</style></head></html>`))
	}))
	defer server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.AllowPrivateSubscription = true

	_, err := service.fetchSubscription(server.URL + "/sub?token=abc")
	if err == nil {
		t.Fatal("expected an error")
	}
	message := err.Error()
	for _, want := range []string{"500", "Server Error", "粘贴内容"} {
		if !strings.Contains(message, want) {
			t.Fatalf("error %q should mention %q", message, want)
		}
	}
	if strings.Contains(message, "normaliz") || strings.Contains(message, "DOCTYPE") {
		t.Fatalf("error should not dump the HTML page: %q", message)
	}
	if attempts != len(subscriptionAttempts) {
		t.Fatalf("expected every attempt to be tried once, got %d", attempts)
	}
}

func TestFetchSubscriptionStopsOnTransportError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	address := server.URL
	server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.AllowPrivateSubscription = true

	_, err := service.fetchSubscription(address + "/sub")
	if err == nil || !strings.Contains(err.Error(), "下载订阅失败") {
		t.Fatalf("expected a download error, got %v", err)
	}
}

func TestFetchSubscriptionRejectsPrivateHostByDefault(t *testing.T) {
	service := newTestProxyService()
	_, err := service.fetchSubscription("http://127.0.0.1:8080/sub")
	if err == nil || !strings.Contains(err.Error(), "MIHOMO_ALLOW_PRIVATE_SUBSCRIPTION") {
		t.Fatalf("expected the private host guard, got %v", err)
	}
}
