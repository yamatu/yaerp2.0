package service

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

// deadLoopbackAddr returns a loopback address that nothing is listening on.
func deadLoopbackAddr(t *testing.T) string {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	return addr
}

func versionServer(version string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/version" {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"version": version, "meta": true})
	}))
}

func TestCandidateControllersCoverBothDeploymentShapes(t *testing.T) {
	cases := []struct {
		name       string
		controller string
		want       []string
	}{
		{
			// Backend inside Docker: a stale loopback URL must fall back to the
			// compose service name.
			name:       "loopback falls back to the docker service",
			controller: "http://127.0.0.1:19090/",
			want: []string{
				"http://127.0.0.1:19090",
				"http://proxy:19090",
				"http://host.docker.internal:19090",
			},
		},
		{
			// Backend on the host: a docker-only URL must fall back to the
			// published port.
			name:       "docker service falls back to loopback",
			controller: "http://proxy:9090",
			want:       []string{"http://proxy:9090", "http://127.0.0.1:9090"},
		},
		{
			name:       "unparseable url keeps the default port",
			controller: "not a url",
			want:       []string{"not a url", "http://127.0.0.1:9090"},
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			service := newTestProxyService()
			service.cfg.Proxy.ControllerURL = testCase.controller
			if got := service.candidateControllers(); !reflect.DeepEqual(got, testCase.want) {
				t.Fatalf("candidateControllers() = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestProbeControllerUsesReachableEndpointAndCachesIt(t *testing.T) {
	core := versionServer("v1.19.31")
	defer core.Close()

	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = "http://" + deadLoopbackAddr(t)
	service.extraControllerCandidates = []string{core.URL}

	version, base, err := service.probeController()
	if err != nil {
		t.Fatalf("probeController failed: %v", err)
	}
	if version != "v1.19.31" {
		t.Fatalf("unexpected version %q", version)
	}
	if base != core.URL {
		t.Fatalf("expected the reachable endpoint %s, got %s", core.URL, base)
	}
	if service.controllerBase() != core.URL {
		t.Fatalf("the reachable endpoint must be cached, got %s", service.controllerBase())
	}
	if _, err := service.coreVersion(); err != nil {
		t.Fatalf("coreVersion failed after a successful probe: %v", err)
	}
}

func TestProbeControllerReportsEveryAttemptedEndpoint(t *testing.T) {
	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = "http://" + deadLoopbackAddr(t)

	if _, _, err := service.probeController(); err == nil {
		t.Fatal("expected an error when no endpoint answers")
	} else {
		message := err.Error()
		for _, fragment := range []string{"无法连接代理内核", "已尝试", "127.0.0.1", "proxy", "host.docker.internal"} {
			if !strings.Contains(message, fragment) {
				t.Fatalf("error %q must mention %q", message, fragment)
			}
		}
	}
}

func TestControllerVersionAtExplainsSecretMismatch(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer right" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(writer).Encode(map[string]any{"version": "v1.19.31", "meta": true})
	}))
	defer server.Close()

	service := newTestProxyService()
	service.cfg.Proxy.ControllerSecret = "wrong"
	if _, err := service.controllerVersionAt(server.URL); err == nil || !strings.Contains(err.Error(), "MIHOMO_CONTROLLER_SECRET") {
		t.Fatalf("expected a secret hint, got %v", err)
	}

	service.cfg.Proxy.ControllerSecret = "right"
	version, err := service.controllerVersionAt(server.URL)
	if err != nil {
		t.Fatalf("controllerVersionAt failed: %v", err)
	}
	if version != "v1.19.31" {
		t.Fatalf("unexpected version %q", version)
	}
}

func TestCoreTransportNeverUsesEnvironmentProxy(t *testing.T) {
	service := newTestProxyService()
	transport, ok := service.coreClient.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil {
		t.Fatalf("the controller needs an explicit direct transport, got %#v", service.coreClient.Transport)
	}

	core := versionServer("v1.19.31")
	defer core.Close()

	proxied := make(chan string, 1)
	envProxy := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		select {
		case proxied <- request.URL.String():
		default:
		}
		writer.WriteHeader(http.StatusBadGateway)
	}))
	defer envProxy.Close()

	t.Setenv("HTTP_PROXY", envProxy.URL)
	t.Setenv("HTTPS_PROXY", envProxy.URL)
	t.Setenv("ALL_PROXY", envProxy.URL)

	version, err := service.controllerVersionAt(core.URL)
	if err != nil {
		t.Fatalf("HTTP_PROXY must not affect controller traffic: %v", err)
	}
	if version != "v1.19.31" {
		t.Fatalf("unexpected version %q", version)
	}
	select {
	case target := <-proxied:
		t.Fatalf("controller traffic was routed through the environment proxy: %s", target)
	default:
	}
}

func TestMixedAddrFallsBackToReachableEntryPoint(t *testing.T) {
	entry, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer entry.Close()
	entryAddr := entry.Addr().String()

	service := newTestProxyService()
	service.cfg.Proxy.MixedAddr = deadLoopbackAddr(t)
	service.extraConsumerCandidates = []string{entryAddr}

	if got := service.mixedAddr(); got != entryAddr {
		t.Fatalf("mixedAddr() = %s, want the reachable %s", got, entryAddr)
	}
	if got := service.httpProxyURL(); got != "http://"+entryAddr {
		t.Fatalf("httpProxyURL() = %s, want http://%s", got, entryAddr)
	}
	// The resolution is cached, so a second read must not re-probe.
	if got := service.mixedAddr(); got != entryAddr {
		t.Fatalf("mixedAddr() = %s after caching, want %s", got, entryAddr)
	}
}

func TestMixedAddrKeepsTheConfiguredValueWhenNothingAnswers(t *testing.T) {
	configured := deadLoopbackAddr(t)

	service := newTestProxyService()
	service.cfg.Proxy.MixedAddr = configured

	if got := service.mixedAddr(); got != configured {
		t.Fatalf("mixedAddr() = %s, want the configured %s", got, configured)
	}
	if err := service.checkConsumerAddr(""); err == nil || !strings.Contains(err.Error(), "MIHOMO_MIXED_ADDR") {
		t.Fatalf("expected the empty address hint, got %v", err)
	}
}
