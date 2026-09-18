package service

import (
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
	if len(queries) != 1 || queries[0] != "flag=clash&token=a+b" {
		t.Fatalf("the URL must be requested verbatim only once, got %v", queries)
	}
}

func TestFetchSubscriptionRejectsPrivateHostByDefault(t *testing.T) {
	service := newTestProxyService()
	_, err := service.fetchSubscription("http://127.0.0.1:8080/sub")
	if err == nil || !strings.Contains(err.Error(), "MIHOMO_ALLOW_PRIVATE_SUBSCRIPTION") {
		t.Fatalf("expected the private host guard, got %v", err)
	}
}
