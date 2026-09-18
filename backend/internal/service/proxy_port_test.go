package service

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"yaerp/internal/model"
)

// coreStub is a minimal mihomo external controller.
type coreStub struct {
	server *httptest.Server
	mu     sync.Mutex
	config string
	puts   int
}

func newCoreStub(t *testing.T) *coreStub {
	t.Helper()
	stub := &coreStub{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/version":
			_ = json.NewEncoder(writer).Encode(map[string]any{"version": "v1.19.31", "meta": true})
		case request.Method == http.MethodPut && request.URL.Path == "/configs":
			var payload struct {
				Payload string `json:"payload"`
			}
			_ = json.NewDecoder(request.Body).Decode(&payload)
			stub.mu.Lock()
			stub.config = payload.Payload
			stub.puts++
			stub.mu.Unlock()
			writer.WriteHeader(http.StatusNoContent)
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (s *coreStub) snapshot() (string, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.config, s.puts
}

func sampleConfigYAML(t *testing.T, mixedPort int) string {
	t.Helper()
	parsed, err := parseSubscriptionPayload(`proxies:
  - name: 香港 01
    type: ss
    server: 1.2.3.4
    port: 8388
    cipher: aes-128-gcm
    password: secret
  - name: 日本 02
    type: trojan
    server: 5.6.7.8
    port: 443
    password: pass
    sni: example.com
`)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload: %v", err)
	}
	config, err := buildMihomoConfig(parsed, "0.0.0.0", mixedPort, defaultControllerPort, "", "")
	if err != nil {
		t.Fatalf("buildMihomoConfig: %v", err)
	}
	return config
}

// A core that only binds the mixed port on its own loopback is unreachable for
// every other container, which is exactly what "connection refused on
// proxy:7890" looks like from the backend.
func TestGeneratedConfigListensOnAllInterfaces(t *testing.T) {
	config := sampleConfigYAML(t, 7890)
	for _, fragment := range []string{"allow-lan: true", "bind-address: '*'", "mixed-port: 7890"} {
		if !strings.Contains(config, fragment) {
			t.Fatalf("generated config must contain %q:\n%s", fragment, config)
		}
	}
}

func TestWithMixedPortKeepsNodesAndRules(t *testing.T) {
	original := sampleConfigYAML(t, 7890)
	updated, err := withMixedPort(original, 7897)
	if err != nil {
		t.Fatalf("withMixedPort: %v", err)
	}
	if !strings.Contains(updated, "mixed-port: 7897") {
		t.Fatalf("mixed port was not rewritten:\n%s", updated)
	}
	if strings.Contains(updated, "mixed-port: 7890") {
		t.Fatalf("the old port is still present:\n%s", updated)
	}
	for _, fragment := range []string{"香港 01", "日本 02", "MATCH,PROXY", "allow-lan: true"} {
		if !strings.Contains(updated, fragment) {
			t.Fatalf("rewriting the port dropped %q:\n%s", fragment, updated)
		}
	}

	// An invalid port must never destroy the stored configuration.
	unchanged, err := withMixedPort(original, 0)
	if err != nil {
		t.Fatalf("withMixedPort(0): %v", err)
	}
	if unchanged != original {
		t.Fatal("an out of range port must keep the configuration untouched")
	}
}

func TestEffectiveMixedPortPrefersTheSavedSetting(t *testing.T) {
	service := newTestProxyService()
	service.cfg.Proxy.MixedAddr = "proxy:7890"

	if port := service.effectiveMixedPort(&model.ProxySettings{}); port != 7890 {
		t.Fatalf("expected the address port as fallback, got %d", port)
	}
	if port := service.effectiveMixedPort(&model.ProxySettings{MixedPort: 7897}); port != 7897 {
		t.Fatalf("expected the saved port to win, got %d", port)
	}
	// The host has to stay configurable (docker service name vs loopback),
	// only the port comes from the saved settings.
	if addr := service.consumerAddr(&model.ProxySettings{MixedPort: 7897}); addr != "proxy:7897" {
		t.Fatalf("unexpected consumer address %q", addr)
	}
	if addr := service.consumerAddr(&model.ProxySettings{}); addr != "proxy:7890" {
		t.Fatalf("unexpected consumer address %q", addr)
	}

	service.cfg.Proxy.MixedAddr = ""
	if addr := service.consumerAddr(&model.ProxySettings{MixedPort: 7897}); addr != "127.0.0.1:7897" {
		t.Fatalf("unexpected host fallback %q", addr)
	}
}

func TestUpdatePortRejectsInvalidValues(t *testing.T) {
	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = "http://proxy:9090"

	cases := []struct {
		name string
		port int
		want string
	}{
		{name: "zero", port: 0, want: "1-65535"},
		{name: "too large", port: 70000, want: "1-65535"},
		{name: "controller port", port: 9090, want: "控制器端口"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if _, err := service.UpdatePort(model.ProxyPortInput{MixedPort: testCase.port}); err == nil {
				t.Fatal("expected an error")
			} else if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("error %q must mention %q", err.Error(), testCase.want)
			}
		})
	}
}

func TestPushConfigEnablesLanAndPersists(t *testing.T) {
	stub := newCoreStub(t)
	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = stub.server.URL
	configDir := t.TempDir()
	service.cfg.Proxy.ConfigDir = configDir

	config := sampleConfigYAML(t, 7899)
	settings := &model.ProxySettings{ConfigYAML: config}
	if err := service.pushConfig(settings); err != nil {
		t.Fatalf("pushConfig: %v", err)
	}

	sent, puts := stub.snapshot()
	if puts != 1 {
		t.Fatalf("expected exactly one config push, got %d", puts)
	}
	if sent != config {
		t.Fatal("the pushed payload must be the generated configuration")
	}

	// The controller keeps the config in memory only, so the pushed document
	// has to be persisted next to the core as well.
	persisted, err := os.ReadFile(filepath.Join(configDir, "config.yaml"))
	if err != nil {
		t.Fatalf("reading the persisted config: %v", err)
	}
	if string(persisted) != config {
		t.Fatal("the persisted configuration differs from the pushed one")
	}
	info, err := os.Stat(filepath.Join(configDir, "config.yaml"))
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	// Windows has no POSIX permissions, so the mode check only makes sense on
	// the platforms the deployment actually uses.
	if runtime.GOOS != "windows" && info.Mode().Perm() != 0o600 {
		t.Fatalf("unexpected file mode %v", info.Mode().Perm())
	}
	if _, err := os.Stat(filepath.Join(configDir, "config.yaml.tmp")); !os.IsNotExist(err) {
		t.Fatal("the temporary file must not be left behind")
	}
}

func TestPersistCoreConfigIsBestEffort(t *testing.T) {
	service := newTestProxyService()
	// No directory configured: nothing to do, and definitely no panic.
	service.persistCoreConfig("mixed-port: 7890\n")

	service.cfg.Proxy.ConfigDir = filepath.Join(t.TempDir(), "missing", "deeper")
	service.persistCoreConfig("mixed-port: 7890\n")

	service.cfg.Proxy.ConfigDir = t.TempDir()
	service.persistCoreConfig("")
	if entries, err := os.ReadDir(service.cfg.Proxy.ConfigDir); err != nil {
		t.Fatalf("read dir: %v", err)
	} else if len(entries) != 0 {
		t.Fatal("an empty config must not create a file")
	}
}
func TestRepairCoreConfigGuards(t *testing.T) {
	stub := newCoreStub(t)
	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = stub.server.URL

	settings := &model.ProxySettings{ConfigYAML: sampleConfigYAML(t, 7890)}
	groups := []model.ProxyGroup{{Name: proxyGroupName, Type: "Selector"}}

	// The core already knows the group: no push at all.
	service.repairCoreConfig(settings, groups)
	// A repair that just happened is throttled.
	service.controllerMu.Lock()
	service.lastRepairAt = time.Now()
	service.controllerMu.Unlock()
	service.repairCoreConfig(settings, nil)

	if _, puts := stub.snapshot(); puts != 0 {
		t.Fatalf("expected no config push, got %d", puts)
	}
}

// Without an imported subscription the core still has to be told to listen on
// every interface, otherwise mihomo's own default config binds the mixed port on
// its loopback and every other container is refused.
func TestRepairCoreConfigPushesBaselineWithoutSubscription(t *testing.T) {
	stub := newCoreStub(t)
	service := newTestProxyService()
	service.cfg.Proxy.ControllerURL = stub.server.URL
	service.cfg.Proxy.MixedAddr = "proxy:7890"

	service.repairCoreConfig(&model.ProxySettings{}, nil)

	pushed, puts := stub.snapshot()
	if puts != 1 {
		t.Fatalf("expected the baseline config to be pushed, got %d pushes", puts)
	}
	for _, fragment := range []string{"allow-lan: true", "mixed-port: 7890", "name: " + proxyGroupName, "MATCH," + proxyGroupName} {
		if !strings.Contains(pushed, fragment) {
			t.Fatalf("baseline config must contain %q:\n%s", fragment, pushed)
		}
	}
}

func TestCorePayloadPrefersTheStoredConfiguration(t *testing.T) {
	service := newTestProxyService()
	service.cfg.Proxy.MixedAddr = "proxy:7890"

	stored := sampleConfigYAML(t, 7890)
	payload, err := service.corePayload(&model.ProxySettings{ConfigYAML: stored, MixedPort: 7897})
	if err != nil {
		t.Fatalf("corePayload: %v", err)
	}
	if payload != stored {
		t.Fatal("a stored configuration must be pushed verbatim")
	}

	payload, err = service.corePayload(nil)
	if err != nil {
		t.Fatalf("corePayload(nil): %v", err)
	}
	if !strings.Contains(payload, "allow-lan: true") || !strings.Contains(payload, "mixed-port: 7890") {
		t.Fatalf("unexpected baseline config:\n%s", payload)
	}
}

func TestHasProxyGroup(t *testing.T) {
	if hasProxyGroup(nil) {
		t.Fatal("an empty group list has no managed group")
	}
	if hasProxyGroup([]model.ProxyGroup{{Name: "GLOBAL"}}) {
		t.Fatal("GLOBAL is not the managed group")
	}
	if !hasProxyGroup([]model.ProxyGroup{{Name: "GLOBAL"}, {Name: proxyGroupName}}) {
		t.Fatal("the managed group must be detected")
	}
}
