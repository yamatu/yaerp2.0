package service

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	proxySourceNone  = "none"
	proxySourceYAML  = "yaml"
	proxySourceLinks = "links"

	// proxyGroupName is the selector group the ERP always routes through.
	proxyGroupName = "PROXY"

	defaultMixedPort      = 7890
	defaultControllerPort = 9090
)

type parsedSubscription struct {
	SourceType string
	Proxies    []map[string]any
	Providers  map[string]any
	ProxyCount int
}

// ---------------------------------------------------------------------------
// Payload detection / parsing
// ---------------------------------------------------------------------------

// payloadKind describes what a subscription body actually looks like so import
// failures can tell the administrator what the panel returned.
type payloadKind int

const (
	payloadUnknown payloadKind = iota
	payloadClashConfig
	payloadLinkList
	payloadHTML
	payloadJSONData
)

func (kind payloadKind) String() string {
	switch kind {
	case payloadClashConfig:
		return "Clash/Mihomo 配置"
	case payloadLinkList:
		return "节点链接列表"
	case payloadHTML:
		return "网页内容(HTML)"
	case payloadJSONData:
		return "JSON 数据接口响应"
	default:
		return "无法识别的格式"
	}
}

// hasYAMLKey reports whether a document contains a top level key. Checking the
// line start is much more reliable than a plain substring match, and base64
// node lists can never match because ":" is not part of the base64 alphabet.
func hasYAMLKey(document, key string) bool {
	for _, line := range strings.Split(document, "\n") {
		line = strings.TrimSpace(line)
		line = strings.TrimPrefix(line, "- ")
		if strings.HasPrefix(line, key+":") {
			return true
		}
	}
	return false
}

func detectPayloadKind(payload string) payloadKind {
	trimmed := strings.TrimSpace(payload)
	if trimmed == "" {
		return payloadUnknown
	}
	lowered := strings.ToLower(trimmed)

	switch {
	case strings.HasPrefix(trimmed, "{"):
		// Some panels return the Clash document as JSON.
		if strings.Contains(lowered, "\"proxies\"") || strings.Contains(lowered, "\"proxy-providers\"") {
			return payloadClashConfig
		}
		return payloadJSONData
	case strings.HasPrefix(trimmed, "<"), strings.Contains(lowered, "<!doctype html"), strings.Contains(lowered, "</html>"):
		return payloadHTML
	case hasYAMLKey(trimmed, "proxies"), hasYAMLKey(trimmed, "proxy-providers"), hasYAMLKey(trimmed, "proxy_providers"):
		return payloadClashConfig
	case strings.Contains(trimmed, "://"):
		return payloadLinkList
	default:
		return payloadUnknown
	}
}

// payloadCandidates returns the payload itself plus any base64 decoded
// variants. Panels either answer with the document directly or wrap it in
// base64, and a few double encode, so two decoding rounds are attempted.
func payloadCandidates(payload string) []string {
	candidates := []string{payload}
	seen := map[string]bool{payload: true}
	current := payload
	for round := 0; round < 2; round++ {
		decoded, ok := decodeBase64Any(current)
		if !ok {
			break
		}
		decoded = strings.TrimSpace(decoded)
		if decoded == "" || seen[decoded] {
			break
		}
		seen[decoded] = true
		candidates = append(candidates, decoded)
		current = decoded
	}
	return candidates
}

// parseSubscriptionPayload accepts a Clash/Mihomo document, a base64 encoded
// node list, a JSON array of links or a plain node link list. Every candidate
// shape is tried before giving up so a panel that only returns a rule template
// still imports whatever node links it contains.
func parseSubscriptionPayload(payload string) (*parsedSubscription, error) {
	trimmed := strings.TrimSpace(payload)
	if trimmed == "" {
		return nil, fmt.Errorf("订阅内容为空")
	}

	var (
		configErr error
		linkErr   error
		sawHTML   bool
	)

	for _, candidate := range payloadCandidates(trimmed) {
		switch detectPayloadKind(candidate) {
		case payloadClashConfig:
			parsed, err := parseClashConfig(candidate)
			if err == nil {
				return parsed, nil
			}
			if configErr == nil {
				configErr = err
			}
		case payloadHTML:
			sawHTML = true
		}

		// Even a document that looks like a Clash config may really be a link
		// list, so the link parsers always get a chance.
		parsed, err := parseLinkPayload(candidate)
		if parsed != nil {
			return parsed, nil
		}
		if err != nil && linkErr == nil {
			linkErr = err
		}
	}

	switch {
	case sawHTML:
		return nil, fmt.Errorf("订阅返回的是网页内容而不是配置文件，通常是登录页或错误页。请确认订阅链接能在浏览器里直接下载 Clash 配置或节点列表")
	case configErr != nil:
		return nil, configErr
	case linkErr != nil:
		return nil, linkErr
	default:
		return nil, fmt.Errorf("无法识别订阅格式（识别为%s）：%s", detectPayloadKind(trimmed), summarizePayload(trimmed))
	}
}

// parseLinkPayload turns every node link found in a payload into a proxy map.
// It returns (nil, nil) when the payload holds no link at all so the caller can
// fall through to other strategies.
func parseLinkPayload(text string) (*parsedSubscription, error) {
	links := extractNodeLinks(text)
	if len(links) == 0 {
		return nil, nil
	}

	proxies := make([]map[string]any, 0, len(links))
	unsupported := make([]string, 0, 4)
	for _, link := range links {
		proxy, err := parseNodeLink(link)
		if err != nil || proxy == nil {
			unsupported = append(unsupported, linkScheme(link))
			continue
		}
		proxies = append(proxies, proxy)
	}
	if len(proxies) == 0 {
		return nil, fmt.Errorf("订阅里有 %d 个节点链接，但协议都不受支持（%s）。当前支持 vless / vmess / trojan / ss / hysteria2 / tuic",
			len(links), strings.Join(dedupeStrings(unsupported), "/"))
	}
	return &parsedSubscription{SourceType: proxySourceLinks, Proxies: proxies, ProxyCount: len(proxies)}, nil
}

// extractNodeLinks collects the distinct node links inside a payload. Links may
// be newline separated, space separated, JSON encoded or prefixed with a YAML
// list marker.
func extractNodeLinks(text string) []string {
	if links := jsonLinkList(text); len(links) > 0 {
		return links
	}

	fields := strings.FieldsFunc(text, func(r rune) bool {
		switch r {
		case '\n', '\r', '\t', ' ', '"', '\'', ',', '[', ']', '{', '}':
			return true
		default:
			return false
		}
	})
	links := make([]string, 0, len(fields))
	seen := map[string]bool{}
	for _, field := range fields {
		field = strings.Trim(strings.TrimSpace(field), "-~")
		if !strings.Contains(field, "://") || strings.HasPrefix(field, "://") {
			continue
		}
		if seen[field] {
			continue
		}
		seen[field] = true
		links = append(links, field)
	}
	return links
}

// jsonLinkList walks a JSON document for strings that contain a link. It is
// tried first because it keeps commas inside link paths intact.
func jsonLinkList(text string) []string {
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "{") {
		return nil
	}
	var document any
	if err := json.Unmarshal([]byte(trimmed), &document); err != nil {
		return nil
	}

	links := make([]string, 0, 4)
	var walk func(value any, depth int)
	walk = func(value any, depth int) {
		if depth > 4 {
			return
		}
		switch typed := value.(type) {
		case string:
			if strings.Contains(typed, "://") {
				links = append(links, strings.TrimSpace(typed))
			}
		case []any:
			for _, item := range typed {
				walk(item, depth+1)
			}
		case map[string]any:
			for _, item := range typed {
				walk(item, depth+1)
			}
		}
	}
	walk(document, 0)
	return links
}

func linkScheme(link string) string {
	if index := strings.Index(link, "://"); index > 0 {
		return strings.ToLower(link[:index])
	}
	return "unknown"
}

func dedupeStrings(values []string) []string {
	seen := map[string]bool{}
	result := make([]string, 0, len(values))
	for _, value := range values {
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

// summarizePayload renders a short single line preview of a subscription body
// so the administrator can see what the panel actually answered.
func summarizePayload(payload string) string {
	preview := strings.Join(strings.Fields(payload), " ")
	if preview == "" {
		return "(空内容)"
	}
	runes := []rune(preview)
	if len(runes) > 180 {
		preview = string(runes[:180]) + "..."
	}
	return preview
}

func parseClashConfig(payload string) (*parsedSubscription, error) {
	var document map[string]any
	if err := yaml.Unmarshal([]byte(payload), &document); err != nil {
		return nil, fmt.Errorf("解析 Clash/Mihomo 配置失败: %w", err)
	}
	if document == nil {
		return nil, fmt.Errorf("Clash/Mihomo 配置内容为空")
	}

	rawProxies, hasProxies := document["proxies"]
	proxies := make([]map[string]any, 0)
	switch typed := rawProxies.(type) {
	case []any:
		for _, item := range typed {
			if entry, ok := toAnyMap(item); ok && len(entry) > 0 {
				proxies = append(proxies, entry)
			}
		}
	case map[string]any:
		// A few panels emit proxies as a mapping of name to definition.
		names := make([]string, 0, len(typed))
		for name := range typed {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			entry, ok := toAnyMap(typed[name])
			if !ok || len(entry) == 0 {
				continue
			}
			if _, exists := entry["name"]; !exists {
				entry["name"] = name
			}
			proxies = append(proxies, entry)
		}
	}

	rawProviders, hasProviders := document["proxy-providers"]
	if !hasProviders {
		rawProviders, hasProviders = document["proxy_providers"]
	}
	providers := map[string]any{}
	if raw, ok := toAnyMap(rawProviders); ok {
		providers = raw
	}

	if len(proxies) == 0 && len(providers) == 0 {
		return nil, fmt.Errorf("订阅里没有任何可用节点（%s）。常见原因：订阅已过期或套餐流量已用尽，或者该链接只返回了规则模板。可以先在浏览器里打开订阅链接确认，必要时在链接后追加 &flag=clash 后重新导入",
			emptyProxiesReason(hasProxies, hasProviders, rawProxies))
	}
	return &parsedSubscription{
		SourceType: proxySourceYAML,
		Proxies:    proxies,
		Providers:  providers,
		ProxyCount: len(proxies),
	}, nil
}

func toAnyMap(value any) (map[string]any, bool) {
	switch typed := value.(type) {
	case map[string]any:
		return typed, true
	case map[any]any:
		converted := make(map[string]any, len(typed))
		for key, item := range typed {
			converted[fmt.Sprint(key)] = item
		}
		return converted, true
	default:
		return nil, false
	}
}

// ---------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------

// buildMihomoConfig produces the runtime config pushed into the core. The
// provider's own groups and rules are intentionally replaced with a single
// selector so node selection from the ERP is always predictable.
func buildMihomoConfig(parsed *parsedSubscription, controllerBind string, mixedPort, controllerPort int, secret, testURL string) (string, error) {
	if parsed == nil {
		return "", fmt.Errorf("订阅内容为空")
	}
	if mixedPort <= 0 || mixedPort > 65535 {
		mixedPort = defaultMixedPort
	}
	if controllerPort <= 0 || controllerPort > 65535 {
		controllerPort = defaultControllerPort
	}
	if strings.TrimSpace(controllerBind) == "" {
		controllerBind = "0.0.0.0"
	}

	proxies, names := dedupeProxyNames(parsed.Proxies)
	members := make([]string, 0, len(names)+1)
	members = append(members, names...)
	members = append(members, "DIRECT")

	group := map[string]any{
		"name":    proxyGroupName,
		"type":    "select",
		"proxies": members,
	}
	if len(parsed.Providers) > 0 {
		providerNames := make([]string, 0, len(parsed.Providers))
		for name := range parsed.Providers {
			providerNames = append(providerNames, name)
		}
		sort.Strings(providerNames)
		group["use"] = providerNames
	}

	config := map[string]any{
		"mixed-port":          mixedPort,
		"allow-lan":           true,
		"bind-address":        "*",
		"mode":                "rule",
		"log-level":           "warning",
		"ipv6":                false,
		"unified-delay":       true,
		"tcp-concurrent":      true,
		"external-controller": fmt.Sprintf("%s:%d", controllerBind, controllerPort),
		"external-controller-cors": map[string]any{
			"allow-origins":         []string{"*"},
			"allow-private-network": true,
		},
		"profile": map[string]any{
			"store-selected": true,
			"store-fake-ip":  true,
		},
		"dns": map[string]any{
			"enable":             true,
			"ipv6":               false,
			"enhanced-mode":      "fake-ip",
			"fake-ip-range":      "198.18.0.1/16",
			"default-nameserver": []string{"223.5.5.5", "119.29.29.29"},
			"nameserver":         []string{"https://223.5.5.5/dns-query", "https://1.1.1.1/dns-query"},
			"fallback":           []string{"https://8.8.8.8/dns-query", "tls://8.8.4.4:853"},
		},
		"proxies":      proxies,
		"proxy-groups": []any{group},
		"rules":        []string{"MATCH," + proxyGroupName},
	}
	// Always keep the field so a controller secret survives config pushes.
	config["secret"] = strings.TrimSpace(secret)
	if len(parsed.Providers) > 0 {
		config["proxy-providers"] = parsed.Providers
	}
	_ = testURL

	encoded, err := yaml.Marshal(config)
	if err != nil {
		return "", fmt.Errorf("生成代理配置失败: %w", err)
	}
	header := "# Generated by YaERP proxy manager. Manual changes will be overwritten.\n"
	return header + string(encoded), nil
}

// withMixedPort rewrites the mixed port of an already generated config. It is
// used when the administrator changes the port, so the stored configuration and
// the core never drift apart.
func withMixedPort(configYAML string, port int) (string, error) {
	if port <= 0 || port > 65535 {
		return configYAML, nil
	}
	document := map[string]any{}
	if err := yaml.Unmarshal([]byte(configYAML), &document); err != nil {
		return "", fmt.Errorf("解析已存配置失败: %w", err)
	}
	document["mixed-port"] = port
	encoded, err := yaml.Marshal(document)
	if err != nil {
		return "", fmt.Errorf("生成代理配置失败: %w", err)
	}
	header := "# Generated by YaERP proxy manager. Manual changes will be overwritten.\n"
	return header + string(encoded), nil
}

func dedupeProxyNames(proxies []map[string]any) ([]map[string]any, []string) {
	result := make([]map[string]any, 0, len(proxies))
	names := make([]string, 0, len(proxies))
	seen := make(map[string]int, len(proxies))
	for _, proxy := range proxies {
		if len(proxy) == 0 {
			continue
		}
		name := strings.TrimSpace(fmt.Sprint(proxy["name"]))
		if name == "" || name == "<nil>" {
			name = fmt.Sprintf("节点 %d", len(result)+1)
		}
		if count, exists := seen[name]; exists {
			seen[name] = count + 1
			name = fmt.Sprintf("%s (%d)", name, count+1)
		} else {
			seen[name] = 1
		}
		proxy["name"] = name
		result = append(result, proxy)
		names = append(names, name)
	}
	return result, names
}

// configProxyNames extracts node names from an already generated config so the
// UI can still list nodes while the core is offline.
func configProxyNames(configYAML string) []string {
	var document map[string]any
	if err := yaml.Unmarshal([]byte(configYAML), &document); err != nil {
		return nil
	}
	raw, ok := document["proxies"].([]any)
	if !ok {
		return nil
	}
	names := make([]string, 0, len(raw))
	for _, item := range raw {
		entry, ok := toAnyMap(item)
		if !ok {
			continue
		}
		if name := strings.TrimSpace(fmt.Sprint(entry["name"])); name != "" && name != "<nil>" {
			names = append(names, name)
		}
	}
	return names
}

// ---------------------------------------------------------------------------
// Address / URL helpers
// ---------------------------------------------------------------------------

func hostPortFromAddr(addr string) (string, int) {
	addr = strings.TrimSpace(addr)
	if addr == "" {
		return "", 0
	}
	host, portText, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port, _ := strconv.Atoi(portText)
	return host, port
}

func controllerBindAndPort(controllerURL string) (string, int) {
	if strings.TrimSpace(controllerURL) == "" {
		return "0.0.0.0", defaultControllerPort
	}
	parsed, err := url.Parse(controllerURL)
	if err != nil || parsed.Host == "" {
		return "0.0.0.0", defaultControllerPort
	}
	_, port := hostPortFromAddr(parsed.Host)
	if port <= 0 {
		port = defaultControllerPort
	}
	return "0.0.0.0", port
}

func controllerHostPort(controllerURL string) string {
	parsed, err := url.Parse(strings.TrimSpace(controllerURL))
	if err != nil || parsed.Host == "" {
		return ""
	}
	host, port := hostPortFromAddr(parsed.Host)
	if port <= 0 {
		port = defaultControllerPort
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// mixedPortFromAddr returns the port consumers connect to on the core.
func mixedPortFromAddr(addr string) int {
	_, port := hostPortFromAddr(addr)
	if port <= 0 {
		return defaultMixedPort
	}
	return port
}

// ---------------------------------------------------------------------------
// Node link parsing
// ---------------------------------------------------------------------------

// emptyProxiesReason explains why a Clash document yielded no node, which is
// usually far more useful than "no proxies field".
func emptyProxiesReason(hasProxies, hasProviders bool, rawProxies any) string {
	switch {
	case hasProxies:
		if list, ok := rawProxies.([]any); ok {
			return fmt.Sprintf("proxies 是空列表，共 %d 项", len(list))
		}
		if rawProxies == nil {
			return "proxies 字段为空"
		}
		return "proxies 字段格式无法识别"
	case hasProviders:
		return "proxy-providers 字段格式无法识别"
	default:
		return "配置里既没有 proxies 也没有 proxy-providers"
	}
}

func parseNodeLink(raw string) (map[string]any, error) {
	scheme := strings.ToLower(raw[:strings.Index(raw, "://")])
	switch scheme {
	case "vmess":
		return parseVMessLink(raw)
	case "vless":
		return parseVLessLink(raw)
	case "trojan":
		return parseTrojanLink(raw)
	case "ss":
		return parseShadowsocksLink(raw)
	case "hysteria2", "hy2":
		return parseHysteria2Link(raw)
	case "tuic":
		return parseTUICLink(raw)
	default:
		return nil, fmt.Errorf("unsupported scheme %s", scheme)
	}
}

func linkName(parsed *url.URL, fallback string) string {
	if parsed != nil && parsed.Fragment != "" {
		if decoded, err := url.QueryUnescape(parsed.Fragment); err == nil && strings.TrimSpace(decoded) != "" {
			return strings.TrimSpace(decoded)
		}
		return strings.TrimSpace(parsed.Fragment)
	}
	return fallback
}

func portValue(raw string) int {
	port, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || port <= 0 || port > 65535 {
		return 0
	}
	return port
}

func parseVMessLink(raw string) (map[string]any, error) {
	encoded := strings.TrimSpace(strings.TrimPrefix(raw, "vmess://"))
	if index := strings.IndexAny(encoded, "#?"); index >= 0 {
		encoded = encoded[:index]
	}
	decoded, ok := decodeBase64Any(encoded)
	if !ok {
		return nil, fmt.Errorf("无效的 vmess 链接")
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(decoded), &payload); err != nil {
		return nil, fmt.Errorf("无效的 vmess 配置: %w", err)
	}
	server := strings.TrimSpace(fmt.Sprint(payload["add"]))
	port := portValue(fmt.Sprint(payload["port"]))
	uuid := strings.TrimSpace(fmt.Sprint(payload["id"]))
	if server == "" || port == 0 || uuid == "" {
		return nil, fmt.Errorf("vmess 节点缺少必要字段")
	}
	name := strings.TrimSpace(fmt.Sprint(payload["ps"]))
	if name == "" || name == "<nil>" {
		name = server
	}

	proxy := map[string]any{
		"name":    name,
		"type":    "vmess",
		"server":  server,
		"port":    port,
		"uuid":    uuid,
		"alterId": intValue(payload["aid"], 0),
		"cipher":  firstNonEmptyValue(strings.TrimSpace(fmt.Sprint(payload["scy"])), "auto"),
		"udp":     true,
	}
	if strings.EqualFold(fmt.Sprint(payload["tls"]), "tls") {
		proxy["tls"] = true
	}
	network := firstNonEmptyValue(strings.TrimSpace(fmt.Sprint(payload["net"])), "tcp")
	proxy["network"] = network
	switch network {
	case "ws":
		proxy["ws-opts"] = buildTransportOptions(strings.TrimSpace(fmt.Sprint(payload["path"])), strings.TrimSpace(fmt.Sprint(payload["host"])))
	case "grpc":
		proxy["grpc-opts"] = map[string]any{"grpc-service-name": strings.TrimSpace(fmt.Sprint(payload["path"]))}
	case "h2", "http":
		proxy["network"] = "h2"
		proxy["h2-opts"] = map[string]any{
			"path": strings.TrimSpace(fmt.Sprint(payload["path"])),
			"host": splitNonEmpty(strings.TrimSpace(fmt.Sprint(payload["host"]))),
		}
	}
	sni := strings.TrimSpace(fmt.Sprint(payload["sni"]))
	if sni != "" && sni != "<nil>" {
		proxy["servername"] = sni
	}
	alpn := strings.TrimSpace(fmt.Sprint(payload["alpn"]))
	if alpn != "" && alpn != "<nil>" {
		proxy["alpn"] = splitNonEmpty(alpn)
	}
	return proxy, nil
}

func parseVLessLink(raw string) (map[string]any, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	uuid := parsed.User.Username()
	server := parsed.Hostname()
	port := portValue(parsed.Port())
	if server == "" || port == 0 || uuid == "" {
		return nil, fmt.Errorf("vless 节点缺少必要字段")
	}
	query := parsed.Query()
	proxy := map[string]any{
		"name":   linkName(parsed, fmt.Sprintf("%s:%d", server, port)),
		"type":   "vless",
		"server": server,
		"port":   port,
		"uuid":   uuid,
		"udp":    true,
	}
	security := strings.ToLower(query.Get("security"))
	if security == "tls" || security == "reality" || security == "xtls" {
		proxy["tls"] = true
	}
	if sni := firstNonEmptyValue(query.Get("sni"), query.Get("peer")); sni != "" {
		proxy["servername"] = sni
	}
	if flow := query.Get("flow"); flow != "" {
		proxy["flow"] = flow
	}
	if fingerprint := query.Get("fp"); fingerprint != "" {
		proxy["client-fingerprint"] = fingerprint
	}
	if security == "reality" {
		reality := map[string]any{}
		if pbk := query.Get("pbk"); pbk != "" {
			reality["public-key"] = pbk
		}
		if sid := query.Get("sid"); sid != "" {
			reality["short-id"] = sid
		}
		if len(reality) > 0 {
			proxy["reality-opts"] = reality
		}
		if _, ok := proxy["client-fingerprint"]; !ok {
			proxy["client-fingerprint"] = "chrome"
		}
	}
	if isTruthy(query.Get("allowInsecure")) || isTruthy(query.Get("insecure")) {
		proxy["skip-cert-verify"] = true
	}
	if alpn := query.Get("alpn"); alpn != "" {
		proxy["alpn"] = splitNonEmpty(alpn)
	}
	applyStreamOptions(query, proxy)
	return proxy, nil
}

func parseTrojanLink(raw string) (map[string]any, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	password := parsed.User.Username()
	server := parsed.Hostname()
	port := portValue(parsed.Port())
	if server == "" || port == 0 || password == "" {
		return nil, fmt.Errorf("trojan 节点缺少必要字段")
	}
	query := parsed.Query()
	proxy := map[string]any{
		"name":     linkName(parsed, fmt.Sprintf("%s:%d", server, port)),
		"type":     "trojan",
		"server":   server,
		"port":     port,
		"password": password,
		"udp":      true,
	}
	if sni := query.Get("sni"); sni != "" {
		proxy["sni"] = sni
	}
	if isTruthy(query.Get("allowInsecure")) || isTruthy(query.Get("insecure")) {
		proxy["skip-cert-verify"] = true
	}
	if alpn := query.Get("alpn"); alpn != "" {
		proxy["alpn"] = splitNonEmpty(alpn)
	}
	applyStreamOptions(query, proxy)
	return proxy, nil
}

func applyStreamOptions(query url.Values, proxy map[string]any) {
	network := strings.ToLower(firstNonEmptyValue(query.Get("type"), "tcp"))
	switch network {
	case "ws":
		proxy["network"] = "ws"
		proxy["ws-opts"] = buildTransportOptions(query.Get("path"), query.Get("host"))
	case "grpc":
		proxy["network"] = "grpc"
		proxy["grpc-opts"] = map[string]any{"grpc-service-name": query.Get("serviceName")}
	case "h2", "http":
		proxy["network"] = "h2"
		proxy["h2-opts"] = map[string]any{
			"path": query.Get("path"),
			"host": splitNonEmpty(query.Get("host")),
		}
	case "xhttp", "splithttp":
		proxy["network"] = "xhttp"
		options := map[string]any{"path": query.Get("path")}
		if host := query.Get("host"); host != "" {
			options["host"] = host
		}
		if mode := query.Get("mode"); mode != "" {
			options["mode"] = mode
		}
		proxy["xhttp-opts"] = options
	case "tcp":
		if headerType := strings.ToLower(query.Get("headerType")); headerType == "http" {
			proxy["network"] = "tcp"
			httpOpts := map[string]any{"method": "GET", "path": splitNonEmpty(query.Get("path"))}
			if host := query.Get("host"); host != "" {
				httpOpts["headers"] = map[string]any{"Host": splitNonEmpty(host)}
			}
			proxy["http-opts"] = httpOpts
		}
	}
}

func buildTransportOptions(path, host string) map[string]any {
	options := map[string]any{}
	if strings.TrimSpace(path) != "" && path != "<nil>" {
		options["path"] = path
	}
	if strings.TrimSpace(host) != "" && host != "<nil>" {
		options["headers"] = map[string]any{"Host": host}
	}
	return options
}

func parseShadowsocksLink(raw string) (map[string]any, error) {
	body := strings.TrimPrefix(raw, "ss://")
	fragment := ""
	if index := strings.Index(body, "#"); index >= 0 {
		fragment = body[index+1:]
		body = body[:index]
	}
	queryText := ""
	if index := strings.Index(body, "?"); index >= 0 {
		queryText = body[index+1:]
		body = body[:index]
	}
	name := ""
	if fragment != "" {
		if decoded, err := url.QueryUnescape(fragment); err == nil {
			name = strings.TrimSpace(decoded)
		} else {
			name = strings.TrimSpace(fragment)
		}
	}

	var credentials, hostPort string
	if at := strings.LastIndex(body, "@"); at >= 0 {
		credentials = body[:at]
		hostPort = body[at+1:]
		if decoded, ok := decodeBase64Any(credentials); ok {
			credentials = decoded
		}
	} else {
		decoded, ok := decodeBase64Any(body)
		if !ok {
			return nil, fmt.Errorf("无效的 ss 链接")
		}
		at := strings.LastIndex(decoded, "@")
		if at < 0 {
			return nil, fmt.Errorf("无效的 ss 链接")
		}
		credentials = decoded[:at]
		hostPort = decoded[at+1:]
	}
	hostPort = strings.TrimSuffix(hostPort, "/")
	separator := strings.LastIndex(credentials, ":")
	if separator < 0 {
		return nil, fmt.Errorf("无效的 ss 凭据")
	}
	method := strings.TrimSpace(credentials[:separator])
	password := credentials[separator+1:]

	host, port := hostPortFromAddr(hostPort)
	port = portValue(strconv.Itoa(port))
	if host == "" || port == 0 || method == "" {
		return nil, fmt.Errorf("ss 节点缺少必要字段")
	}
	if name == "" {
		name = fmt.Sprintf("%s:%d", host, port)
	}

	proxy := map[string]any{
		"name":     name,
		"type":     "ss",
		"server":   host,
		"port":     port,
		"cipher":   method,
		"password": password,
		"udp":      true,
	}
	if queryText != "" {
		values, err := url.ParseQuery(queryText)
		if err == nil {
			applyShadowsocksPlugin(values.Get("plugin"), proxy)
		}
	}
	return proxy, nil
}

func applyShadowsocksPlugin(plugin string, proxy map[string]any) {
	if strings.TrimSpace(plugin) == "" {
		return
	}
	parts := strings.Split(plugin, ";")
	pluginName := strings.ToLower(strings.TrimSpace(parts[0]))
	options := map[string]string{}
	for _, part := range parts[1:] {
		key, value, found := strings.Cut(part, "=")
		if !found {
			continue
		}
		options[strings.TrimSpace(key)] = strings.TrimSpace(value)
	}
	switch {
	case strings.Contains(pluginName, "obfs"):
		proxy["plugin"] = "obfs"
		proxy["plugin-opts"] = map[string]any{
			"mode": firstNonEmptyValue(options["obfs"], "http"),
			"host": options["obfs-host"],
		}
	case strings.Contains(pluginName, "v2ray-plugin"):
		proxy["plugin"] = "v2ray-plugin"
		proxy["plugin-opts"] = map[string]any{
			"mode": "websocket",
			"host": options["host"],
			"path": firstNonEmptyValue(options["path"], "/"),
			"tls":  options["tls"] == "true",
		}
	}
}

func parseHysteria2Link(raw string) (map[string]any, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	server := parsed.Hostname()
	port := portValue(parsed.Port())
	if server == "" || port == 0 {
		return nil, fmt.Errorf("hysteria2 节点缺少必要字段")
	}
	query := parsed.Query()
	password := parsed.User.Username()
	if password == "" {
		password = firstNonEmptyValue(query.Get("auth"), query.Get("password"))
	}
	proxy := map[string]any{
		"name":     linkName(parsed, fmt.Sprintf("%s:%d", server, port)),
		"type":     "hysteria2",
		"server":   server,
		"port":     port,
		"password": password,
		"udp":      true,
	}
	if sni := query.Get("sni"); sni != "" {
		proxy["sni"] = sni
	}
	if isTruthy(query.Get("insecure")) || isTruthy(query.Get("allowInsecure")) {
		proxy["skip-cert-verify"] = true
	}
	if obfs := query.Get("obfs"); obfs != "" {
		proxy["obfs"] = obfs
		proxy["obfs-password"] = query.Get("obfs-password")
	}
	if alpn := query.Get("alpn"); alpn != "" {
		proxy["alpn"] = splitNonEmpty(alpn)
	}
	return proxy, nil
}

func parseTUICLink(raw string) (map[string]any, error) {
	parsed, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	server := parsed.Hostname()
	port := portValue(parsed.Port())
	if server == "" || port == 0 {
		return nil, fmt.Errorf("tuic 节点缺少必要字段")
	}
	uuid := parsed.User.Username()
	password, _ := parsed.User.Password()
	query := parsed.Query()
	proxy := map[string]any{
		"name":   linkName(parsed, fmt.Sprintf("%s:%d", server, port)),
		"type":   "tuic",
		"server": server,
		"port":   port,
		"uuid":   uuid,
		"udp":    true,
	}
	if password != "" {
		proxy["password"] = password
	}
	if sni := query.Get("sni"); sni != "" {
		proxy["sni"] = sni
	}
	if alpn := query.Get("alpn"); alpn != "" {
		proxy["alpn"] = splitNonEmpty(alpn)
	}
	if congestion := firstNonEmptyValue(query.Get("congestion_control"), query.Get("congestion-controller")); congestion != "" {
		proxy["congestion-controller"] = congestion
	}
	if mode := firstNonEmptyValue(query.Get("udp_relay_mode"), query.Get("udp-relay-mode")); mode != "" {
		proxy["udp-relay-mode"] = mode
	}
	if isTruthy(query.Get("allow_insecure")) || isTruthy(query.Get("insecure")) || isTruthy(query.Get("allowInsecure")) {
		proxy["skip-cert-verify"] = true
	}
	return proxy, nil
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

func decodeBase64Any(value string) (string, bool) {
	value = strings.TrimSpace(value)
	value = strings.ReplaceAll(value, "\n", "")
	value = strings.ReplaceAll(value, "\r", "")
	value = strings.TrimRight(value, "=")
	if value == "" {
		return "", false
	}
	for _, encoding := range []*base64.Encoding{
		base64.RawStdEncoding,
		base64.RawURLEncoding,
		base64.StdEncoding,
		base64.URLEncoding,
	} {
		if decoded, err := encoding.DecodeString(value); err == nil && len(decoded) > 0 {
			return string(decoded), true
		}
	}
	return "", false
}

func splitNonEmpty(value string) []string {
	result := make([]string, 0)
	for _, part := range strings.FieldsFunc(value, func(r rune) bool {
		return r == ',' || r == ';' || r == ' '
	}) {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func firstNonEmptyValue(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" && trimmed != "<nil>" {
			return trimmed
		}
	}
	return ""
}

func isTruthy(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func intValue(value any, fallback int) int {
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		if parsed, err := strconv.Atoi(strings.TrimSpace(typed)); err == nil {
			return parsed
		}
	}
	return fallback
}
