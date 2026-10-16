package service

import (
	"context"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/proxy"

	"yaerp/internal/model"
)

// mailProxyFallbackTimeout bounds a proxied dial when a direct retry is
// allowed, so a blocked port on the proxy node costs seconds, not the full
// connection timeout.
const mailProxyFallbackTimeout = 10 * time.Second

// mailRoute is the outbound path chosen for one mailbox.
type mailRoute struct {
	// proxy is nil for a direct connection.
	proxy *model.MailServerSettings
	// viaCore marks the XTLS core entry point. Only that proxy skips private
	// destinations: a remote node cannot reach a self-hosted Poste.io on the
	// LAN or a docker service name.
	viaCore bool
	// strict forbids falling back to a direct connection when the proxy fails.
	strict bool
}

func (route mailRoute) key() string {
	if route.proxy == nil {
		return "direct"
	}
	return strings.Join([]string{
		"socks5", route.proxy.ProxyHost, strconv.Itoa(route.proxy.ProxyPort),
		route.proxy.ProxyUsername, route.proxy.ProxyPasswordEncrypted,
		strconv.FormatBool(route.viaCore), strconv.FormatBool(route.strict),
	}, "|")
}

// SetProxyOverrideProvider installs the callback that returns the XTLS core
// entry point for mail traffic. forced=true asks for it regardless of the
// global 邮箱流量 switch; nil means the core is not available.
func (s *MailService) SetProxyOverrideProvider(provider func(forced bool) *model.MailServerSettings) {
	s.proxyOverrideProvider = provider
}

func (s *MailService) coreMailProxy(forced bool) *model.MailServerSettings {
	if s.proxyOverrideProvider == nil {
		return nil
	}
	return s.proxyOverrideProvider(forced)
}

// resolveMailRoute decides how one mailbox reaches its servers.
//
//   - off:    always direct.
//   - on:     the XTLS core even when the global switch is off, else the
//     administrator's SOCKS5; never falls back to direct.
//   - global: the XTLS core when the 邮箱流量 switch is on, falling back to a
//     direct connection if the node cannot reach the server (proxy nodes
//     commonly block SMTP ports); otherwise the administrator's SOCKS5.
func (s *MailService) resolveMailRoute(settings *model.MailServerSettings, account *model.MailAccount) (mailRoute, error) {
	mode := mailProxyModeGlobal
	if account != nil {
		mode = normalizeMailAccountProxyMode(account.ProxyMode, nil)
	}
	var configured *model.MailServerSettings
	if settings != nil && normalizeMailProxyType(settings.ProxyType) == "socks5" {
		configured = settings
	}
	switch mode {
	case mailProxyModeOff:
		return mailRoute{}, nil
	case mailProxyModeOn:
		if core := s.coreMailProxy(true); core != nil {
			return mailRoute{proxy: core, viaCore: true, strict: true}, nil
		}
		if configured != nil {
			return mailRoute{proxy: configured, strict: true}, nil
		}
		return mailRoute{}, fmt.Errorf("该邮箱设置为「始终走代理」，但 XTLS 代理未连接，也没有配置 SOCKS5 代理")
	}
	if core := s.coreMailProxy(false); core != nil {
		return mailRoute{proxy: core, viaCore: true}, nil
	}
	if configured != nil {
		// The administrator's own proxy keeps its previous strict behaviour.
		return mailRoute{proxy: configured, strict: true}, nil
	}
	return mailRoute{}, nil
}

// mailRouteDialer dials through the chosen route and, when allowed, retries a
// failed proxied dial directly.
type mailRouteDialer struct {
	direct    *net.Dialer
	proxied   proxy.ContextDialer
	proxyAddr string
	route     mailRoute
}

func (d *mailRouteDialer) Dial(network, address string) (net.Conn, error) {
	return d.DialContext(context.Background(), network, address)
}

func (d *mailRouteDialer) DialContext(ctx context.Context, network, address string) (net.Conn, error) {
	if d.proxied == nil {
		return d.direct.DialContext(ctx, network, address)
	}
	host, _, _ := net.SplitHostPort(address)
	if d.route.viaCore && mailHostIsPrivate(host) {
		return d.direct.DialContext(ctx, network, address)
	}
	timeout := mailConnectionTimeout
	if !d.route.strict {
		timeout = mailProxyFallbackTimeout
	}
	proxyCtx, cancel := context.WithTimeout(ctx, timeout)
	conn, proxyErr := d.proxied.DialContext(proxyCtx, network, address)
	cancel()
	if proxyErr == nil {
		return conn, nil
	}
	if d.route.strict {
		return nil, fmt.Errorf("经代理 %s 连接 %s 失败: %w", d.proxyAddr, address, proxyErr)
	}
	log.Printf("mail: 经 XTLS 代理连接 %s 失败（%v），改为直连", address, proxyErr)
	conn, directErr := d.direct.DialContext(ctx, network, address)
	if directErr != nil {
		return nil, fmt.Errorf("经 XTLS 代理连接 %s 失败（%v），直连也失败: %w", address, proxyErr, directErr)
	}
	return conn, nil
}

func (s *MailService) mailDialer(settings *model.MailServerSettings, account *model.MailAccount) (*mailRouteDialer, error) {
	route, err := s.resolveMailRoute(settings, account)
	if err != nil {
		return nil, err
	}
	return s.dialerForRoute(route)
}

func (s *MailService) dialerForRoute(route mailRoute) (*mailRouteDialer, error) {
	dialer := &mailRouteDialer{direct: &net.Dialer{Timeout: mailConnectionTimeout}, route: route}
	if route.proxy == nil {
		return dialer, nil
	}
	settings := route.proxy
	if strings.TrimSpace(settings.ProxyHost) == "" || settings.ProxyPort < 1 || settings.ProxyPort > 65535 {
		return nil, fmt.Errorf("SOCKS5 代理地址或端口无效")
	}
	var auth *proxy.Auth
	if strings.TrimSpace(settings.ProxyUsername) != "" {
		password := ""
		if strings.TrimSpace(settings.ProxyPasswordEncrypted) != "" {
			value, err := s.decryptSecret(settings.ProxyPasswordEncrypted)
			if err != nil {
				return nil, fmt.Errorf("SOCKS5 代理密码无法读取: %w", err)
			}
			password = value
		}
		auth = &proxy.Auth{User: strings.TrimSpace(settings.ProxyUsername), Password: password}
	}
	dialer.proxyAddr = net.JoinHostPort(strings.TrimSpace(settings.ProxyHost), strconv.Itoa(settings.ProxyPort))
	socks, err := proxy.SOCKS5("tcp", dialer.proxyAddr, auth, dialer.direct)
	if err != nil {
		return nil, err
	}
	contextDialer, ok := socks.(proxy.ContextDialer)
	if !ok {
		return nil, fmt.Errorf("SOCKS5 拨号器不支持超时控制")
	}
	dialer.proxied = contextDialer
	return dialer, nil
}

// mailHostIsPrivate reports whether a mail server lives on a network a remote
// proxy node cannot reach: loopback/private IPs, single-label names (docker
// services such as "poste") and names that only resolve to private addresses.
func mailHostIsPrivate(host string) bool {
	host = strings.Trim(strings.TrimSpace(host), "[]")
	if host == "" {
		return false
	}
	if ip := net.ParseIP(host); ip != nil {
		return mailIPIsPrivate(ip)
	}
	lower := strings.ToLower(strings.TrimSuffix(host, "."))
	if lower == "localhost" || !strings.Contains(lower, ".") {
		return true
	}
	for _, suffix := range []string{".local", ".lan", ".internal", ".localdomain", ".home.arpa"} {
		if strings.HasSuffix(lower, suffix) {
			return true
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupIPAddr(ctx, lower)
	if err != nil || len(addrs) == 0 {
		return false
	}
	for _, addr := range addrs {
		if !mailIPIsPrivate(addr.IP) {
			return false
		}
	}
	return true
}

var mailCGNATRange = &net.IPNet{IP: net.IPv4(100, 64, 0, 0), Mask: net.CIDRMask(10, 32)}

func mailIPIsPrivate(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsUnspecified() || mailCGNATRange.Contains(ip)
}
