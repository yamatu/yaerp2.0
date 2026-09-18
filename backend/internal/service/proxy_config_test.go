package service

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestParseVLessRealityLink(t *testing.T) {
	raw := "vless://11111111-2222-3333-4444-555555555555@example.com:443" +
		"?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=abcdef&sid=1234" +
		"&type=grpc&serviceName=grpcsvc&flow=xtls-rprx-vision#%E9%A6%99%E6%B8%AF01"

	proxy, err := parseNodeLink(raw)
	if err != nil {
		t.Fatalf("parseNodeLink failed: %v", err)
	}
	if proxy["type"] != "vless" {
		t.Fatalf("unexpected type %v", proxy["type"])
	}
	if proxy["server"] != "example.com" || proxy["port"] != 443 {
		t.Fatalf("unexpected endpoint %v:%v", proxy["server"], proxy["port"])
	}
	if proxy["tls"] != true {
		t.Fatalf("reality link must enable tls")
	}
	if proxy["name"] != "香港01" {
		t.Fatalf("fragment must be decoded, got %v", proxy["name"])
	}
	reality, ok := proxy["reality-opts"].(map[string]any)
	if !ok || reality["public-key"] != "abcdef" || reality["short-id"] != "1234" {
		t.Fatalf("unexpected reality options %v", proxy["reality-opts"])
	}
	grpc, ok := proxy["grpc-opts"].(map[string]any)
	if !ok || grpc["grpc-service-name"] != "grpcsvc" {
		t.Fatalf("unexpected grpc options %v", proxy["grpc-opts"])
	}
}

func TestParseVMessLink(t *testing.T) {
	payload := `{"v":"2","ps":"测试节点","add":"1.2.3.4","port":"8443","id":"11111111-2222-3333-4444-555555555555","aid":"0","scy":"auto","net":"ws","type":"none","host":"cdn.example.com","path":"/ws","tls":"tls","sni":"cdn.example.com"}`
	raw := "vmess://" + base64.StdEncoding.EncodeToString([]byte(payload))

	proxy, err := parseNodeLink(raw)
	if err != nil {
		t.Fatalf("parseNodeLink failed: %v", err)
	}
	if proxy["name"] != "测试节点" || proxy["server"] != "1.2.3.4" || proxy["port"] != 8443 {
		t.Fatalf("unexpected node %v", proxy)
	}
	ws, ok := proxy["ws-opts"].(map[string]any)
	if !ok {
		t.Fatalf("missing ws-opts %v", proxy)
	}
	headers, _ := ws["headers"].(map[string]any)
	if headers["Host"] != "cdn.example.com" || ws["path"] != "/ws" {
		t.Fatalf("unexpected ws options %v", ws)
	}
}

func TestParseShadowsocksSIP002(t *testing.T) {
	credentials := base64.RawURLEncoding.EncodeToString([]byte("aes-256-gcm:passw0rd"))
	raw := "ss://" + credentials + "@5.6.7.8:8388#%E6%97%A5%E6%9C%AC"

	proxy, err := parseNodeLink(raw)
	if err != nil {
		t.Fatalf("parseNodeLink failed: %v", err)
	}
	if proxy["cipher"] != "aes-256-gcm" || proxy["password"] != "passw0rd" {
		t.Fatalf("unexpected credentials %v", proxy)
	}
	if proxy["server"] != "5.6.7.8" || proxy["port"] != 8388 || proxy["name"] != "日本" {
		t.Fatalf("unexpected node %v", proxy)
	}
}

func TestParseBase64Subscription(t *testing.T) {
	list := strings.Join([]string{
		"trojan://secret@trojan.example.com:443?sni=trojan.example.com#TR-1",
		"hysteria2://pass@hy2.example.com:8443?sni=hy2.example.com&insecure=1#HY2",
		"vless://11111111-2222-3333-4444-555555555555@vless.example.com:8443?security=tls&type=ws&path=%2Fpath#VLESS",
	}, "\n")
	encoded := base64.StdEncoding.EncodeToString([]byte(list))

	parsed, err := parseSubscriptionPayload(encoded)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if parsed.SourceType != proxySourceLinks {
		t.Fatalf("unexpected source type %v", parsed.SourceType)
	}
	if len(parsed.Proxies) != 3 {
		t.Fatalf("expected 3 proxies, got %d", len(parsed.Proxies))
	}
}

func TestParseClashConfigAndGenerate(t *testing.T) {
	document := `
mixed-port: 7890
proxies:
  - name: A
    type: ss
    server: 1.1.1.1
    port: 8388
    cipher: aes-128-gcm
    password: p
  - name: A
    type: ss
    server: 2.2.2.2
    port: 8388
    cipher: aes-128-gcm
    password: p
proxy-groups:
  - name: 供应商组
    type: url-test
    proxies: [A]
rules:
  - DOMAIN-SUFFIX,example.com,供应商组
  - MATCH,DIRECT
`
	parsed, err := parseSubscriptionPayload(document)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if parsed.SourceType != proxySourceYAML || len(parsed.Proxies) != 2 {
		t.Fatalf("unexpected parse result %+v", parsed)
	}

	generated, err := buildMihomoConfig(parsed, "0.0.0.0", 7890, 9090, "s3cret", "http://www.gstatic.com/generate_204")
	if err != nil {
		t.Fatalf("buildMihomoConfig failed: %v", err)
	}
	for _, expected := range []string{
		"mixed-port: 7890",
		"external-controller: 0.0.0.0:9090",
		"secret: s3cret",
		"name: PROXY",
		"MATCH,PROXY",
		"A (2)",
	} {
		if !strings.Contains(generated, expected) {
			t.Fatalf("generated config missing %q:\n%s", expected, generated)
		}
	}
	// Provider groups and rules must be replaced by the managed selector.
	if strings.Contains(generated, "供应商组") {
		t.Fatalf("provider group leaked into generated config:\n%s", generated)
	}

	names := configProxyNames(generated)
	if len(names) != 2 || names[0] != "A" || names[1] != "A (2)" {
		t.Fatalf("unexpected node names %v", names)
	}
}

func TestRejectUnsupportedSubscription(t *testing.T) {
	if _, err := parseSubscriptionPayload("this is not a subscription"); err == nil {
		t.Fatal("expected an error for unsupported content")
	}
}

func TestParseBase64EncodedClashConfig(t *testing.T) {
	// Some panels wrap a full Clash document in base64, and that document
	// contains "://" inside its DNS settings, which used to be mistaken for a
	// node link list.
	document := `
mixed-port: 7890
dns:
  nameserver:
    - https://223.5.5.5/dns-query
proxies:
  - name: 香港01
    type: vless
    server: hk.example.com
    port: 443
    uuid: 11111111-2222-3333-4444-555555555555
    tls: true
`
	encoded := base64.StdEncoding.EncodeToString([]byte(document))

	parsed, err := parseSubscriptionPayload(encoded)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if parsed.SourceType != proxySourceYAML {
		t.Fatalf("expected a YAML source, got %v", parsed.SourceType)
	}
	if len(parsed.Proxies) != 1 || parsed.Proxies[0]["name"] != "香港01" {
		t.Fatalf("unexpected proxies %+v", parsed.Proxies)
	}
}

func TestParseClashConfigWithEmptyProxiesExplainsWhy(t *testing.T) {
	document := "mixed-port: 7890\nproxies: []\nproxy-groups:\n  - name: G\n    type: select\n    proxies: [DIRECT]\nrules:\n  - MATCH,G\n"
	_, err := parseSubscriptionPayload(document)
	if err == nil {
		t.Fatal("expected an error for an empty proxy list")
	}
	if !strings.Contains(err.Error(), "没有任何可用节点") || !strings.Contains(err.Error(), "空列表") {
		t.Fatalf("error should explain the empty proxy list, got: %v", err)
	}
}

func TestParseHTMLSubscriptionIsReportedClearly(t *testing.T) {
	page := "<!DOCTYPE html><html><head><title>Login</title></head><body>请先登录</body></html>"
	_, err := parseSubscriptionPayload(page)
	if err == nil {
		t.Fatal("expected an error for an HTML page")
	}
	if !strings.Contains(err.Error(), "网页内容") {
		t.Fatalf("error should mention HTML content, got: %v", err)
	}
}

func TestParseJSONLinkArray(t *testing.T) {
	payload := `{"servers":["vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#A","trojan://p@b.example.com:443#B"]}`
	parsed, err := parseSubscriptionPayload(payload)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if parsed.SourceType != proxySourceLinks || len(parsed.Proxies) != 2 {
		t.Fatalf("unexpected parse result %+v", parsed)
	}
}

func TestParseSpaceSeparatedLinks(t *testing.T) {
	list := "vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls#A " +
		"trojan://p@b.example.com:443#B\ttuic://u:p@c.example.com:443#C"
	parsed, err := parseSubscriptionPayload(list)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if len(parsed.Proxies) != 3 {
		t.Fatalf("expected 3 proxies, got %d", len(parsed.Proxies))
	}
}

func TestParseURLSafeBase64Subscription(t *testing.T) {
	list := "vless://11111111-2222-3333-4444-555555555555@a.example.com:443?security=tls&fp=chrome#香港01"
	encoded := base64.RawURLEncoding.EncodeToString([]byte(list))

	parsed, err := parseSubscriptionPayload(encoded)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if len(parsed.Proxies) != 1 || parsed.Proxies[0]["name"] != "香港01" {
		t.Fatalf("unexpected parse result %+v", parsed)
	}
}

func TestParseClashConfigWithProxiesMapping(t *testing.T) {
	document := `
proxies:
  香港01:
    type: ss
    server: 1.1.1.1
    port: 8388
    cipher: aes-128-gcm
    password: p
`
	parsed, err := parseSubscriptionPayload(document)
	if err != nil {
		t.Fatalf("parseSubscriptionPayload failed: %v", err)
	}
	if len(parsed.Proxies) != 1 || parsed.Proxies[0]["name"] != "香港01" {
		t.Fatalf("unexpected parse result %+v", parsed.Proxies)
	}
}

func TestParseUnsupportedOnlyLinksExplainsProtocols(t *testing.T) {
	_, err := parseSubscriptionPayload("ssr://c2VydmVyOjEyMzQ6b3JpZ2luOmFlcy0yNTYtY2ZiOnBsYWluOmNHRnpjdz09")
	if err == nil {
		t.Fatal("expected an error for unsupported protocols")
	}
	if !strings.Contains(err.Error(), "ssr") {
		t.Fatalf("error should name the unsupported protocol, got: %v", err)
	}
}
