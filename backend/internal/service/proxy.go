package service

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"yaerp/config"
	"yaerp/internal/model"
	"yaerp/internal/repo"
)

const (
	proxyCoreTimeout       = 6 * time.Second
	proxySubscriptionLimit = 10 * 1024 * 1024
	proxyDelayTestTimeout  = 5000
	proxyDelayWorkers      = 16
	proxyDelayMaxNodes     = 200
	proxyUserAgent         = "clash-verge/v1.6.3"
	proxySubscriptionFetch = 60 * time.Second
	// proxyProbeTTL keeps a failed controller probe from being repeated on every
	// status poll (the fallback candidates can take a few seconds to time out).
	proxyProbeTTL = 5 * time.Second
)

// controllerProbe is a cached result of probeController.
type controllerProbe struct {
	version string
	base    string
	err     error
	at      time.Time
}

var proxyGroupTypes = map[string]bool{
	"Selector": true, "URLTest": true, "Fallback": true, "LoadBalance": true,
	"Relay": true, "Compatible": true, "Pass": true, "ProxyProvider": true,
}

var proxyBuiltinNames = map[string]bool{
	"DIRECT": true, "REJECT": true, "REJECT-DROP": true, "PASS": true,
	"COMPATIBLE": true, "GLOBAL": true,
}

// ProxyService owns the XTLS/Mihomo subscription and tells the rest of the
// backend whether AI, WhatsApp and mail traffic should use it.
type ProxyService struct {
	cfg         *config.Config
	repo        *repo.ProxyRepo
	coreClient  *http.Client
	delayClient *http.Client
	fetchClient *http.Client

	mu       sync.RWMutex
	settings *model.ProxySettings

	// controllerMu guards activeController, the controller endpoint that last
	// answered. It lets the service recover when MIHOMO_CONTROLLER_URL does not
	// match the deployment shape (backend in Docker vs. on the host).
	controllerMu     sync.Mutex
	activeController string
	// probe caches the last controller probe for a few seconds so frequent
	// status polls do not repeat slow DNS timeouts while the core is down.
	probeCache *controllerProbe
	// extraControllerCandidates is only used by tests to simulate the Docker /
	// host counterparts of MIHOMO_CONTROLLER_URL.
	extraControllerCandidates []string

	// consumerMu guards the resolved proxy entry point handed to AI, WhatsApp
	// and mail. The value is cached with a short TTL because it is read on every
	// request but requires a reachability probe to be trusted.
	consumerMu        sync.Mutex
	activeConsumer    string
	consumerErr       error
	consumerCheckedAt time.Time
	// extraConsumerCandidates is only used by tests, see extraControllerCandidates.
	extraConsumerCandidates []string

	whatsAppHook func(proxyURL string) error
}

// newCoreTransport builds a transport for controller traffic. It never uses an
// environment proxy (HTTP_PROXY and friends) because the core always lives on
// the local network and a proxy would swallow the request.
func newCoreTransport() *http.Transport {
	return &http.Transport{
		Proxy:               nil,
		MaxIdleConns:        10,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 10 * time.Second,
		DialContext: (&net.Dialer{
			Timeout:   3 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
	}
}

func NewProxyService(cfg *config.Config, proxyRepo *repo.ProxyRepo) *ProxyService {
	fetchTransport := &http.Transport{
		Proxy:               nil,
		MaxIdleConns:        10,
		IdleConnTimeout:     60 * time.Second,
		TLSHandshakeTimeout: 15 * time.Second,
	}
	return &ProxyService{
		cfg:         cfg,
		repo:        proxyRepo,
		coreClient:  &http.Client{Timeout: proxyCoreTimeout, Transport: newCoreTransport()},
		delayClient: &http.Client{Timeout: time.Duration(proxyDelayTestTimeout+3000) * time.Millisecond, Transport: newCoreTransport()},
		fetchClient: &http.Client{
			Timeout:   proxySubscriptionFetch,
			Transport: fetchTransport,
		},
	}
}

// SetWhatsAppHook installs the callback that reconfigures the WhatsApp
// sidecar whenever the WhatsApp proxy switch changes.
func (s *ProxyService) SetWhatsAppHook(hook func(proxyURL string) error) {
	s.whatsAppHook = hook
}

// Init loads the persisted configuration and re-applies it to the core.
func (s *ProxyService) Init() error {
	settings, err := s.repo.Get()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.settings = settings
	s.mu.Unlock()

	s.logCoreDiagnostics()

	// Reconnect the consumers (WhatsApp sidecar) even when the core is
	// temporarily unreachable, so the switches and the sidecar stay in sync
	// across backend restarts.
	if err := s.applyConsumers(settings); err != nil {
		log.Printf("proxy: 恢复消费者代理配置失败: %v", err)
	}

	if !settings.Enabled || strings.TrimSpace(settings.ConfigYAML) == "" {
		return nil
	}

	if err := s.pushConfig(settings); err != nil {
		s.setLastError(err.Error())
		return nil
	}
	if err := s.applySelection(settings); err != nil {
		s.setLastError(err.Error())
		return nil
	}
	s.setLastError("")
	return nil
}

// logCoreDiagnostics writes the resolved controller and consumer endpoints to
// the backend log, which makes "内核离线" diagnosable with docker compose logs.
func (s *ProxyService) logCoreDiagnostics() {
	if !s.cfg.Proxy.Enabled {
		log.Printf("proxy: 功能未启用 (MIHOMO_ENABLED=false)")
		return
	}
	version, base, err := s.probeController()
	if err != nil {
		log.Printf("proxy: 代理内核不可用: %v", err)
	} else {
		log.Printf("proxy: 代理内核已连接 version=%s controller=%s", version, base)
	}
	if err := s.checkConsumerAddr(s.cfg.Proxy.MixedAddr); err != nil {
		log.Printf("proxy: 代理入口不可达: %v", err)
	} else {
		log.Printf("proxy: 代理入口可用 addr=%s", s.mixedAddr())
	}
	if vars := environmentProxyVars(); len(vars) > 0 {
		log.Printf("proxy: 检测到环境代理变量 %s（控制器与延迟测试已强制直连，不受其影响）", strings.Join(vars, ", "))
	}
}

// environmentProxyVars reports the proxy related environment variables that are
// set in the backend process. They are useful context when the controller
// looks unreachable, and they are deliberately ignored by the controller and
// delay transports.
func environmentProxyVars() []string {
	names := []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"}
	found := make([]string, 0, len(names))
	for _, name := range names {
		if value := strings.TrimSpace(os.Getenv(name)); value != "" {
			found = append(found, name+"="+value)
		}
	}
	return found
}

// checkConsumerAddr verifies that the address handed to AI / WhatsApp / mail is
// reachable from the backend process. It is a common misconfiguration when the
// backend runs outside Docker or keeps a stale MIHOMO_MIXED_ADDR.
func (s *ProxyService) checkConsumerAddr(addr string) error {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return fmt.Errorf("未配置 MIHOMO_MIXED_ADDR")
	}
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return fmt.Errorf("无法连接 %s: %w", addr, err)
	}
	_ = conn.Close()
	return nil
}

func (s *ProxyService) snapshot() *model.ProxySettings {
	s.mu.RLock()
	settings := s.settings
	s.mu.RUnlock()
	if settings != nil {
		return settings
	}
	loaded, err := s.repo.Get()
	if err != nil {
		return &model.ProxySettings{}
	}
	s.mu.Lock()
	s.settings = loaded
	s.mu.Unlock()
	return loaded
}

func (s *ProxyService) mutate(apply func(*model.ProxySettings)) (*model.ProxySettings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.settings == nil {
		loaded, err := s.repo.Get()
		if err != nil {
			return nil, err
		}
		s.settings = loaded
	}
	next := *s.settings
	apply(&next)
	if err := s.repo.Save(&next); err != nil {
		return nil, err
	}
	s.settings = &next
	return &next, nil
}

func (s *ProxyService) setLastError(message string) {
	_, _ = s.mutate(func(next *model.ProxySettings) {
		next.LastError = message
	})
}

// ---------------------------------------------------------------------------
// Public API used by the handlers and by the other services
// ---------------------------------------------------------------------------

// AIProxyURL returns the HTTP proxy URL for AI requests, or "" when AI traffic
// must go out directly.
func (s *ProxyService) AIProxyURL() string {
	if !s.cfg.Proxy.Enabled {
		return ""
	}
	settings := s.snapshot()
	if settings == nil || !settings.Enabled || !settings.ProxyAI {
		return ""
	}
	return s.httpProxyURL()
}

// MailProxySettings returns a SOCKS5 override for IMAP/SMTP/HTTP mail traffic.
func (s *ProxyService) MailProxySettings() *model.MailServerSettings {
	if !s.cfg.Proxy.Enabled {
		return nil
	}
	settings := s.snapshot()
	if settings == nil || !settings.Enabled || !settings.ProxyMail {
		return nil
	}
	host, port := hostPortFromAddr(s.mixedAddr())
	if strings.TrimSpace(host) == "" || port <= 0 {
		return nil
	}
	return &model.MailServerSettings{ProxyType: "socks5", ProxyHost: host, ProxyPort: port}
}

// WhatsAppProxyURL returns the HTTP proxy URL handed to the WhatsApp sidecar.
func (s *ProxyService) WhatsAppProxyURL() string {
	if !s.cfg.Proxy.Enabled {
		return ""
	}
	settings := s.snapshot()
	if settings == nil || !settings.Enabled || !settings.ProxyWhatsApp {
		return ""
	}
	return s.httpProxyURL()
}

func (s *ProxyService) httpProxyURL() string {
	return "http://" + s.mixedAddr()
}

// consumerCacheTTL bounds how often the proxy entry point is re-probed.
const consumerCacheTTL = 30 * time.Second

// mixedAddr returns the proxy entry point the backend should hand to AI,
// WhatsApp and mail. The configured MIHOMO_MIXED_ADDR wins; when it is not
// reachable (for example a container that still carries the host-oriented
// default) the Docker or host counterpart is used instead, so the routing keeps
// working. The result is cached briefly because it is read on every request.
func (s *ProxyService) mixedAddr() string {
	addr, _ := s.resolveConsumer()
	return addr
}

func (s *ProxyService) resolveConsumer() (string, error) {
	s.consumerMu.Lock()
	cached, cachedErr, checkedAt := s.activeConsumer, s.consumerErr, s.consumerCheckedAt
	s.consumerMu.Unlock()
	if cached != "" && time.Since(checkedAt) < consumerCacheTTL {
		return cached, cachedErr
	}

	configured := strings.TrimSpace(s.cfg.Proxy.MixedAddr)
	if configured == "" {
		configured = fmt.Sprintf("127.0.0.1:%d", defaultMixedPort)
	}

	resolved, resolvedErr := configured, s.checkConsumerAddr(configured)
	if resolvedErr != nil {
		candidates := append(consumerCandidates(configured), s.extraConsumerCandidates...)
		for _, candidate := range candidates {
			if candidate == configured {
				continue
			}
			if probeErr := s.checkConsumerAddr(candidate); probeErr == nil {
				log.Printf("proxy: 代理入口 %s 不可达（%v），改用 %s", configured, resolvedErr, candidate)
				resolved, resolvedErr = candidate, nil
				break
			}
		}
	}

	s.consumerMu.Lock()
	s.activeConsumer, s.consumerErr, s.consumerCheckedAt = resolved, resolvedErr, time.Now()
	s.consumerMu.Unlock()
	return resolved, resolvedErr
}

// consumerCandidates mirrors candidateControllers for the mixed (HTTP/SOCKS)
// entry point.
func consumerCandidates(configured string) []string {
	host, port := hostPortFromAddr(configured)
	if port <= 0 {
		port = defaultMixedPort
	}
	portText := fmt.Sprintf("%d", port)
	candidates := []string{configured}
	if isLoopbackHost(host) {
		candidates = append(candidates, "proxy:"+portText, "host.docker.internal:"+portText)
	} else {
		candidates = append(candidates, "127.0.0.1:"+portText)
	}
	return candidates
}

// Status reports the current state, including live core information.
func (s *ProxyService) Status() (*model.ProxyStatus, error) {
	settings := s.snapshot()
	status := &model.ProxyStatus{
		Enabled:          settings.Enabled,
		SubscriptionURL:  settings.SubscriptionURL,
		SubscriptionName: settings.SubscriptionName,
		SourceType:       settings.SourceType,
		SelectedNode:     settings.SelectedNode,
		SelectedGroup:    settings.SelectedGroup,
		ProxyAI:          settings.ProxyAI,
		ProxyWhatsApp:    settings.ProxyWhatsApp,
		ProxyMail:        settings.ProxyMail,
		ProxyEndpoint:    s.cfg.Proxy.MixedAddr,
		LastError:        settings.LastError,
		UpdatedAt:        settings.UpdatedAt,
	}

	version, err := s.coreVersionCached()
	if err != nil {
		status.CoreAvailable = false
		status.CoreError = err.Error()
		status.CoreEndpoint = s.configuredController()
		status.Nodes = s.offlineNodes(settings)
		status.NodeCount = len(status.Nodes)
		s.fillConsumerState(status)
		return status, nil
	}
	status.CoreAvailable = true
	status.CoreVersion = version
	status.CoreEndpoint = s.controllerBase()
	s.fillConsumerState(status)

	nodes, groups, err := s.coreNodes()
	if err != nil {
		status.LastError = err.Error()
		return status, nil
	}
	status.Nodes = nodes
	status.Groups = groups
	status.NodeCount = len(nodes)
	status.GroupCount = len(groups)
	for _, node := range nodes {
		if node.Selected {
			status.SelectedNode = node.Name
			break
		}
	}
	return status, nil
}

// fillConsumerState records whether the proxy entry point handed to AI,
// WhatsApp and mail can be reached from the backend process.
func (s *ProxyService) fillConsumerState(status *model.ProxyStatus) {
	addr, err := s.resolveConsumer()
	status.ProxyEndpoint = addr
	if err != nil {
		status.ConsumerOK = false
		status.ConsumerError = err.Error()
		return
	}
	status.ConsumerOK = true
	status.ConsumerError = ""
}

// ListNodes returns the selectable upstream nodes.
func (s *ProxyService) ListNodes() ([]model.ProxyNode, []model.ProxyGroup, error) {
	if _, err := s.coreVersion(); err != nil {
		return s.offlineNodes(s.snapshot()), nil, nil
	}
	return s.coreNodes()
}

// ImportSubscription fetches (or accepts) a subscription and stores the
// generated core configuration.
func (s *ProxyService) ImportSubscription(input model.ProxySubscriptionInput) (*model.ProxyStatus, error) {
	payload := strings.TrimSpace(input.Payload)
	subscriptionURL := strings.TrimSpace(input.URL)

	if subscriptionURL != "" {
		fetched, err := s.fetchSubscription(subscriptionURL)
		if err != nil {
			return nil, err
		}
		payload = fetched
	}
	if payload == "" {
		return nil, fmt.Errorf("请填写订阅链接或粘贴订阅内容")
	}

	parsed, err := parseSubscriptionPayload(payload)
	if err != nil {
		return nil, err
	}

	mixedPort := mixedPortFromAddr(s.cfg.Proxy.MixedAddr)
	controllerBind, controllerPort := controllerBindAndPort(s.cfg.Proxy.ControllerURL)
	configYAML, err := buildMihomoConfig(parsed, controllerBind, mixedPort, controllerPort, s.cfg.Proxy.ControllerSecret, s.cfg.Proxy.TestURL)
	if err != nil {
		return nil, err
	}

	nodeNames := configProxyNames(configYAML)
	selectedNode := ""
	if previous := s.snapshot(); previous != nil && previous.SelectedNode != "" {
		for _, name := range nodeNames {
			if name == previous.SelectedNode {
				selectedNode = name
				break
			}
		}
	}
	if selectedNode == "" && len(nodeNames) > 0 {
		selectedNode = nodeNames[0]
	}

	updated, err := s.mutate(func(next *model.ProxySettings) {
		next.SubscriptionURL = subscriptionURL
		next.SubscriptionName = strings.TrimSpace(input.Name)
		next.SourceType = parsed.SourceType
		next.SourcePayload = payload
		next.ConfigYAML = configYAML
		next.SelectedNode = selectedNode
		next.SelectedGroup = proxyGroupName
		next.LastError = ""
	})
	if err != nil {
		return nil, err
	}

	if updated.Enabled {
		if err := s.pushConfig(updated); err != nil {
			s.setLastError(err.Error())
			return s.Status()
		}
		if err := s.applySelection(updated); err != nil {
			s.setLastError(err.Error())
			return s.Status()
		}
		s.setLastError("")
	}
	return s.Status()
}

// RefreshSubscription re-fetches the stored subscription URL.
func (s *ProxyService) RefreshSubscription() (*model.ProxyStatus, error) {
	settings := s.snapshot()
	if strings.TrimSpace(settings.SubscriptionURL) == "" {
		return nil, fmt.Errorf("当前订阅不是通过链接导入的，无法刷新")
	}
	return s.ImportSubscription(model.ProxySubscriptionInput{
		URL:  settings.SubscriptionURL,
		Name: settings.SubscriptionName,
	})
}

// DeleteSubscription clears the stored subscription and disconnects consumers.
func (s *ProxyService) DeleteSubscription() (*model.ProxyStatus, error) {
	updated, err := s.mutate(func(next *model.ProxySettings) {
		next.SubscriptionURL = ""
		next.SubscriptionName = ""
		next.SourceType = proxySourceNone
		next.SourcePayload = ""
		next.ConfigYAML = ""
		next.SelectedNode = ""
		next.SelectedGroup = ""
		next.Enabled = false
		next.LastError = ""
	})
	if err != nil {
		return nil, err
	}
	_ = s.applyConsumers(updated)
	return s.Status()
}

// Connect pushes the configuration into the core and enables the proxy.
func (s *ProxyService) Connect() (*model.ProxyStatus, error) {
	if !s.cfg.Proxy.Enabled {
		return nil, fmt.Errorf("服务端未启用代理功能")
	}
	settings := s.snapshot()
	if strings.TrimSpace(settings.ConfigYAML) == "" {
		return nil, fmt.Errorf("请先导入订阅")
	}
	if err := s.pushConfig(settings); err != nil {
		s.setLastError(err.Error())
		return nil, err
	}
	updated, err := s.mutate(func(next *model.ProxySettings) {
		next.Enabled = true
		next.LastError = ""
	})
	if err != nil {
		return nil, err
	}
	if err := s.applySelection(updated); err != nil {
		s.setLastError(err.Error())
	}
	if err := s.applyConsumers(updated); err != nil {
		s.setLastError(err.Error())
	}
	return s.Status()
}

// Disconnect stops routing AI/WhatsApp/mail traffic through the core.
func (s *ProxyService) Disconnect() (*model.ProxyStatus, error) {
	updated, err := s.mutate(func(next *model.ProxySettings) {
		next.Enabled = false
	})
	if err != nil {
		return nil, err
	}
	if err := s.applyConsumers(updated); err != nil {
		s.setLastError(err.Error())
	}
	return s.Status()
}

// UpdateToggles switches the individual traffic sources.
func (s *ProxyService) UpdateToggles(input model.ProxyToggleInput) (*model.ProxyStatus, error) {
	updated, err := s.mutate(func(next *model.ProxySettings) {
		if input.ProxyAI != nil {
			next.ProxyAI = *input.ProxyAI
		}
		if input.ProxyWhatsApp != nil {
			next.ProxyWhatsApp = *input.ProxyWhatsApp
		}
		if input.ProxyMail != nil {
			next.ProxyMail = *input.ProxyMail
		}
	})
	if err != nil {
		return nil, err
	}
	if err := s.applyConsumers(updated); err != nil {
		s.setLastError(err.Error())
	}
	return s.Status()
}

// SelectNode selects the upstream node inside the managed selector group.
func (s *ProxyService) SelectNode(name string) (*model.ProxyStatus, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		return nil, fmt.Errorf("请选择节点")
	}
	if err := s.selectNode(name); err != nil {
		return nil, err
	}
	if _, err := s.mutate(func(next *model.ProxySettings) {
		next.SelectedNode = name
		next.SelectedGroup = proxyGroupName
		next.LastError = ""
	}); err != nil {
		return nil, err
	}
	return s.Status()
}

// TestNodes probes latency for the requested nodes (all nodes when empty).
func (s *ProxyService) TestNodes(names []string) ([]model.ProxyNodeResult, error) {
	if _, err := s.coreVersion(); err != nil {
		return nil, fmt.Errorf("代理内核不可用: %w", err)
	}
	nodes, _, err := s.coreNodes()
	if err != nil {
		return nil, err
	}
	if len(names) == 0 {
		for _, node := range nodes {
			names = append(names, node.Name)
		}
	}
	if len(names) == 0 {
		return []model.ProxyNodeResult{}, nil
	}
	if len(names) > proxyDelayMaxNodes {
		names = names[:proxyDelayMaxNodes]
	}

	results := make([]model.ProxyNodeResult, len(names))
	semaphore := make(chan struct{}, proxyDelayWorkers)
	var group sync.WaitGroup
	for index, name := range names {
		group.Add(1)
		semaphore <- struct{}{}
		go func(index int, name string) {
			defer group.Done()
			defer func() { <-semaphore }()
			delay, err := s.testNodeDelay(name)
			result := model.ProxyNodeResult{Name: name, Delay: delay}
			if err != nil {
				result.Delay = 0
				result.Error = err.Error()
			}
			results[index] = result
		}(index, name)
	}
	group.Wait()
	return results, nil
}

// ---------------------------------------------------------------------------
// Core (Mihomo) REST API
// ---------------------------------------------------------------------------

type proxyCoreProxy struct {
	Type    string `json:"type"`
	Now     string `json:"now"`
	All     []string
	History []struct {
		Delay int `json:"delay"`
	} `json:"history"`
}

// controllerBase returns the controller endpoint that should be used for the
// REST calls. When a probe already succeeded, that endpoint wins so every
// request keeps using the same address.
func (s *ProxyService) controllerBase() string {
	s.controllerMu.Lock()
	active := s.activeController
	s.controllerMu.Unlock()
	if active != "" {
		return active
	}
	return s.configuredController()
}

func (s *ProxyService) configuredController() string {
	return strings.TrimRight(strings.TrimSpace(s.cfg.Proxy.ControllerURL), "/")
}

func (s *ProxyService) setActiveController(base string) {
	s.controllerMu.Lock()
	s.activeController = base
	s.controllerMu.Unlock()
}

// candidateControllers lists the controller endpoints worth probing. The
// configured URL always comes first; the fallbacks cover the two usual
// deployment shapes so a stale MIHOMO_CONTROLLER_URL (for example a container
// recreated before the variable was added to .env) does not break the page.
func (s *ProxyService) candidateControllers() []string {
	configured := s.configuredController()
	candidates := make([]string, 0, 3)
	seen := map[string]bool{}
	add := func(value string) {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value == "" || seen[value] {
			return
		}
		seen[value] = true
		candidates = append(candidates, value)
	}

	s.controllerMu.Lock()
	active := s.activeController
	s.controllerMu.Unlock()
	add(active)
	add(configured)

	scheme, host, port := splitControllerEndpoint(configured)
	if isLoopbackHost(host) {
		// The backend runs next to the core inside the compose network.
		add(scheme + "://proxy:" + port)
		add(scheme + "://host.docker.internal:" + port)
	} else {
		// The backend runs on the host and reaches the published port.
		add(scheme + "://127.0.0.1:" + port)
	}
	for _, extra := range s.extraControllerCandidates {
		add(extra)
	}
	return candidates
}

func splitControllerEndpoint(base string) (scheme, host, port string) {
	scheme = "http"
	port = fmt.Sprintf("%d", defaultControllerPort)
	parsed, err := url.Parse(base)
	if err != nil {
		return scheme, "", port
	}
	if parsed.Scheme != "" {
		scheme = parsed.Scheme
	}
	host = parsed.Hostname()
	if parsed.Port() != "" {
		port = parsed.Port()
	}
	return scheme, host, port
}

func isLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}

// probeController returns the version and endpoint of the first candidate that
// answers, and caches the winner. The error lists every endpoint that was tried
// so the administrator can see what the backend actually attempted.
func (s *ProxyService) probeController() (string, string, error) {
	s.controllerMu.Lock()
	cached := s.probeCache
	s.controllerMu.Unlock()
	if cached != nil && time.Since(cached.at) < proxyProbeTTL {
		return cached.version, cached.base, cached.err
	}

	version, base, err := s.runControllerProbe()

	s.controllerMu.Lock()
	s.probeCache = &controllerProbe{version: version, base: base, err: err, at: time.Now()}
	s.controllerMu.Unlock()
	return version, base, err
}

func (s *ProxyService) runControllerProbe() (string, string, error) {
	candidates := s.candidateControllers()
	var (
		firstErr  error
		firstBase string
	)
	for _, base := range candidates {
		version, err := s.controllerVersionAt(base)
		if err != nil {
			if firstErr == nil {
				firstErr, firstBase = err, base
			}
			continue
		}
		s.setActiveController(base)
		return version, base, nil
	}
	if firstErr == nil {
		firstErr = fmt.Errorf("没有可用的代理内核地址")
		firstBase = s.configuredController()
	}
	return "", firstBase, fmt.Errorf("%w（已尝试 %s）", firstErr, strings.Join(candidates, "、"))
}

func (s *ProxyService) controllerVersionAt(base string) (string, error) {
	request, err := s.newCoreRequestAt(http.MethodGet, base, "/version", nil)
	if err != nil {
		return "", err
	}
	response, err := s.coreClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("无法连接代理内核(%s): %w", base, err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		if response.StatusCode == http.StatusUnauthorized {
			return "", fmt.Errorf("代理内核(%s)拒绝访问：MIHOMO_CONTROLLER_SECRET 与内核的 secret 不一致", base)
		}
		return "", fmt.Errorf("代理内核(%s)返回状态 %d", base, response.StatusCode)
	}
	var payload struct {
		Version string `json:"version"`
		Meta    bool   `json:"meta"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 4096)).Decode(&payload); err != nil {
		return "", fmt.Errorf("代理内核(%s)响应无法解析: %w", base, err)
	}
	if payload.Version == "" {
		payload.Version = "unknown"
	}
	return payload.Version, nil
}

func (s *ProxyService) newCoreRequest(method, path string, body []byte) (*http.Request, error) {
	return s.newCoreRequestAt(method, s.controllerBase(), path, body)
}

func (s *ProxyService) newCoreRequestAt(method, base, path string, body []byte) (*http.Request, error) {
	endpoint := strings.TrimRight(base, "/") + path
	request, err := http.NewRequest(method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	if secret := strings.TrimSpace(s.cfg.Proxy.ControllerSecret); secret != "" {
		request.Header.Set("Authorization", "Bearer "+secret)
	}
	return request, nil
}

func (s *ProxyService) coreVersion() (string, error) {
	if !s.cfg.Proxy.Enabled {
		return "", fmt.Errorf("服务端未启用代理功能（MIHOMO_ENABLED=false）")
	}
	version, _, err := s.runControllerProbe()
	if err != nil {
		return "", err
	}
	return version, nil
}

// coreVersionCached is the polling variant used by Status: it tolerates a few
// seconds of staleness so a status poll every few seconds does not repeat the
// slow DNS timeouts of the fallback candidates.
func (s *ProxyService) coreVersionCached() (string, error) {
	if !s.cfg.Proxy.Enabled {
		return "", fmt.Errorf("服务端未启用代理功能（MIHOMO_ENABLED=false）")
	}
	version, _, err := s.probeController()
	if err != nil {
		return "", err
	}
	return version, nil
}

func (s *ProxyService) pushConfig(settings *model.ProxySettings) error {
	if settings == nil || strings.TrimSpace(settings.ConfigYAML) == "" {
		return fmt.Errorf("没有可用的代理配置")
	}
	// Resolve the controller first so a stale MIHOMO_CONTROLLER_URL cannot make
	// the push fail when the fallback endpoint is reachable.
	if _, err := s.coreVersion(); err != nil {
		return err
	}
	body, err := json.Marshal(map[string]string{
		"path":    "",
		"payload": settings.ConfigYAML,
	})
	if err != nil {
		return err
	}
	request, err := s.newCoreRequest(http.MethodPut, "/configs?force=true", body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.coreClient.Do(request)
	if err != nil {
		return fmt.Errorf("推送代理配置失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return fmt.Errorf("推送代理配置失败(%d): %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (s *ProxyService) applySelection(settings *model.ProxySettings) error {
	if settings == nil || strings.TrimSpace(settings.SelectedNode) == "" {
		return nil
	}
	return s.selectNode(settings.SelectedNode)
}

func (s *ProxyService) selectNode(name string) error {
	body, err := json.Marshal(map[string]string{"name": name})
	if err != nil {
		return err
	}
	request, err := s.newCoreRequest(http.MethodPut, "/proxies/"+url.PathEscape(proxyGroupName), body)
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.coreClient.Do(request)
	if err != nil {
		return fmt.Errorf("切换节点失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusMultipleChoices {
		message, _ := io.ReadAll(io.LimitReader(response.Body, 1024))
		return fmt.Errorf("切换节点失败(%d): %s", response.StatusCode, strings.TrimSpace(string(message)))
	}
	return nil
}

func (s *ProxyService) coreNodes() ([]model.ProxyNode, []model.ProxyGroup, error) {
	request, err := s.newCoreRequest(http.MethodGet, "/proxies", nil)
	if err != nil {
		return nil, nil, err
	}
	response, err := s.coreClient.Do(request)
	if err != nil {
		return nil, nil, fmt.Errorf("读取节点列表失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("读取节点列表失败(%d)", response.StatusCode)
	}
	var payload struct {
		Proxies map[string]proxyCoreProxy `json:"proxies"`
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 16*1024*1024)).Decode(&payload); err != nil {
		return nil, nil, fmt.Errorf("解析节点列表失败: %w", err)
	}

	selected := ""
	if group, ok := payload.Proxies[proxyGroupName]; ok {
		selected = group.Now
	}

	nodes := make([]model.ProxyNode, 0, len(payload.Proxies))
	groups := make([]model.ProxyGroup, 0)
	for name, proxy := range payload.Proxies {
		if proxyGroupTypes[proxy.Type] {
			groups = append(groups, model.ProxyGroup{Name: name, Type: proxy.Type, Now: proxy.Now})
			continue
		}
		if proxyBuiltinNames[strings.ToUpper(name)] {
			continue
		}
		delay := -1
		if len(proxy.History) > 0 && proxy.History[len(proxy.History)-1].Delay > 0 {
			delay = proxy.History[len(proxy.History)-1].Delay
		}
		nodes = append(nodes, model.ProxyNode{
			Name:     name,
			Type:     proxy.Type,
			Delay:    delay,
			Selected: name == selected,
		})
	}
	sort.Slice(nodes, func(i, j int) bool { return nodes[i].Name < nodes[j].Name })
	sort.Slice(groups, func(i, j int) bool { return groups[i].Name < groups[j].Name })
	return nodes, groups, nil
}

func (s *ProxyService) testNodeDelay(name string) (int, error) {
	testURL := strings.TrimSpace(s.cfg.Proxy.TestURL)
	if testURL == "" {
		testURL = "http://www.gstatic.com/generate_204"
	}
	path := fmt.Sprintf("/proxies/%s/delay?timeout=%d&url=%s",
		url.PathEscape(name), proxyDelayTestTimeout, url.QueryEscape(testURL))
	request, err := s.newCoreRequest(http.MethodGet, path, nil)
	if err != nil {
		return 0, err
	}
	response, err := s.delayClient.Do(request)
	if err != nil {
		return 0, fmt.Errorf("超时")
	}
	defer response.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
	if response.StatusCode != http.StatusOK {
		var payload struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(body, &payload)
		if payload.Message != "" {
			return 0, fmt.Errorf("%s", payload.Message)
		}
		return 0, fmt.Errorf("测试失败(%d)", response.StatusCode)
	}
	var payload struct {
		Delay int `json:"delay"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return 0, fmt.Errorf("解析延迟结果失败")
	}
	return payload.Delay, nil
}

func (s *ProxyService) offlineNodes(settings *model.ProxySettings) []model.ProxyNode {
	if settings == nil || strings.TrimSpace(settings.ConfigYAML) == "" {
		return nil
	}
	names := configProxyNames(settings.ConfigYAML)
	nodes := make([]model.ProxyNode, 0, len(names))
	for _, name := range names {
		nodes = append(nodes, model.ProxyNode{
			Name:     name,
			Delay:    -1,
			Selected: name == settings.SelectedNode,
		})
	}
	return nodes
}

// ---------------------------------------------------------------------------
// Consumers
// ---------------------------------------------------------------------------

func (s *ProxyService) applyConsumers(settings *model.ProxySettings) error {
	if s.whatsAppHook == nil {
		return nil
	}
	proxyURL := ""
	if settings != nil && settings.Enabled && settings.ProxyWhatsApp {
		proxyURL = s.httpProxyURL()
	}
	if err := s.whatsAppHook(proxyURL); err != nil {
		return fmt.Errorf("WhatsApp 代理配置失败: %w", err)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Subscription fetching
// ---------------------------------------------------------------------------

// fetchSubscription downloads a subscription and makes sure the answer can be
// parsed. Many panels need the Clash conversion flag (?flag=clash), but adding
// it blindly breaks a few servers, so the URL is requested verbatim first and
// only retried with the flag when the first answer is unusable.
func (s *ProxyService) fetchSubscription(rawURL string) (string, error) {
	rawURL = strings.TrimSpace(rawURL)
	payload, err := s.fetchSubscriptionOnce(rawURL)
	if err != nil {
		return "", err
	}
	if _, parseErr := parseSubscriptionPayload(payload); parseErr == nil {
		return payload, nil
	}

	target, parseURLErr := url.Parse(rawURL)
	if parseURLErr != nil || hasSubscriptionFlag(target.RawQuery) {
		// Nothing left to try; let the caller report the original error.
		return payload, nil
	}
	flagged := *target
	if flagged.RawQuery == "" {
		flagged.RawQuery = "flag=clash"
	} else {
		flagged.RawQuery += "&flag=clash"
	}
	retried, retryErr := s.fetchSubscriptionOnce(flagged.String())
	if retryErr != nil {
		return payload, nil
	}
	if _, retryParseErr := parseSubscriptionPayload(retried); retryParseErr != nil {
		return payload, nil
	}
	return retried, nil
}

func hasSubscriptionFlag(rawQuery string) bool {
	return strings.Contains(rawQuery, "flag=") || strings.Contains(rawQuery, "target=")
}

func (s *ProxyService) fetchSubscriptionOnce(rawURL string) (string, error) {
	target, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || target.Host == "" {
		return "", fmt.Errorf("订阅链接格式不正确")
	}
	if target.Scheme != "http" && target.Scheme != "https" {
		return "", fmt.Errorf("订阅链接仅支持 http 或 https")
	}
	if !s.cfg.Proxy.AllowPrivateSubscription {
		if err := rejectPrivateHost(target.Hostname()); err != nil {
			return "", err
		}
	}

	request, err := http.NewRequest(http.MethodGet, target.String(), nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", proxyUserAgent)
	request.Header.Set("Accept", "*/*")

	response, err := s.fetchClient.Do(request)
	if err != nil {
		return "", fmt.Errorf("下载订阅失败: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		snippet := ""
		if body, readErr := io.ReadAll(io.LimitReader(response.Body, 256)); readErr == nil {
			snippet = summarizePayload(string(body))
		}
		if snippet == "" || snippet == "(空内容)" {
			return "", fmt.Errorf("下载订阅失败，订阅服务器返回 %d", response.StatusCode)
		}
		return "", fmt.Errorf("下载订阅失败，订阅服务器返回 %d：%s", response.StatusCode, snippet)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, proxySubscriptionLimit+1))
	if err != nil {
		return "", fmt.Errorf("读取订阅内容失败: %w", err)
	}
	if len(body) > proxySubscriptionLimit {
		return "", fmt.Errorf("订阅内容超过 10MB 限制")
	}
	text := strings.TrimSpace(string(body))
	if text == "" {
		return "", fmt.Errorf("订阅内容为空")
	}
	return text, nil
}

func rejectPrivateHost(host string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("订阅链接缺少主机名")
	}
	if ip := net.ParseIP(host); ip != nil {
		if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() {
			return fmt.Errorf("出于安全考虑，默认禁止导入内网订阅地址；如确需使用请设置 MIHOMO_ALLOW_PRIVATE_SUBSCRIPTION=true")
		}
		return nil
	}
	if strings.EqualFold(host, "localhost") {
		return fmt.Errorf("出于安全考虑，默认禁止导入本机订阅地址")
	}
	return nil
}
