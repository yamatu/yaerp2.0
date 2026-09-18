package model

import "time"

// ProxySettings is the single global record that keeps the imported
// subscription plus the routing switches for the outbound proxy core.
type ProxySettings struct {
	ID               int64     `json:"id" db:"id"`
	SubscriptionURL  string    `json:"subscription_url" db:"subscription_url"`
	SubscriptionName string    `json:"subscription_name" db:"subscription_name"`
	SourceType       string    `json:"source_type" db:"source_type"`
	SourcePayload    string    `json:"-" db:"source_payload"`
	ConfigYAML       string    `json:"-" db:"config_yaml"`
	SelectedNode     string    `json:"selected_node" db:"selected_node"`
	SelectedGroup    string    `json:"selected_group" db:"selected_group"`
	Enabled          bool      `json:"enabled" db:"enabled"`
	ProxyAI          bool      `json:"proxy_ai" db:"proxy_ai"`
	ProxyWhatsApp    bool      `json:"proxy_whatsapp" db:"proxy_whatsapp"`
	ProxyMail        bool      `json:"proxy_mail" db:"proxy_mail"`
	MixedPort        int       `json:"mixed_port" db:"mixed_port"` // 0 = 使用 MIHOMO_MIXED_ADDR 的端口
	LastError        string    `json:"last_error" db:"last_error"`
	CreatedAt        time.Time `json:"created_at" db:"created_at"`
	UpdatedAt        time.Time `json:"updated_at" db:"updated_at"`
}

// ProxyNode is a selectable upstream node reported by the proxy core.
type ProxyNode struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Delay    int    `json:"delay"`
	Selected bool   `json:"selected"`
}

// ProxyGroup is a proxy-group reported by the proxy core.
type ProxyGroup struct {
	Name string `json:"name"`
	Type string `json:"type"`
	Now  string `json:"now"`
}

// ProxyStatus is the aggregated state shown on the proxy management page.
type ProxyStatus struct {
	CoreAvailable    bool         `json:"core_available"`
	CoreVersion      string       `json:"core_version"`
	CoreEndpoint     string       `json:"core_endpoint"`
	CoreError        string       `json:"core_error"`
	ConsumerOK       bool         `json:"consumer_ok"`
	ConsumerError    string       `json:"consumer_error"`
	Enabled          bool         `json:"enabled"`
	SubscriptionURL  string       `json:"subscription_url"`
	SubscriptionName string       `json:"subscription_name"`
	SourceType       string       `json:"source_type"`
	SelectedNode     string       `json:"selected_node"`
	SelectedGroup    string       `json:"selected_group"`
	ProxyAI          bool         `json:"proxy_ai"`
	ProxyWhatsApp    bool         `json:"proxy_whatsapp"`
	ProxyMail        bool         `json:"proxy_mail"`
	NodeCount        int          `json:"node_count"`
	GroupCount       int          `json:"group_count"`
	ProxyEndpoint    string       `json:"proxy_endpoint"`
	MixedPort        int          `json:"mixed_port"`
	ControllerPort   int          `json:"controller_port"`
	ConfigPersisted  bool         `json:"config_persisted"`
	LastError        string       `json:"last_error"`
	UpdatedAt        time.Time    `json:"updated_at"`
	Nodes            []ProxyNode  `json:"nodes,omitempty"`
	Groups           []ProxyGroup `json:"groups,omitempty"`
}

// ProxySubscriptionInput accepts either a subscription URL or a raw payload
// (Clash/Mihomo YAML or a base64 encoded node list).
type ProxySubscriptionInput struct {
	URL     string `json:"url"`
	Payload string `json:"payload"`
	Name    string `json:"name"`
}

// ProxyToggleInput switches individual traffic sources on and off.
type ProxyToggleInput struct {
	ProxyAI       *bool `json:"proxy_ai"`
	ProxyWhatsApp *bool `json:"proxy_whatsapp"`
	ProxyMail     *bool `json:"proxy_mail"`
}

// ProxySelectInput selects the upstream node used by the proxy core.
type ProxySelectInput struct {
	Node  string `json:"node"`
	Group string `json:"group"`
}

// ProxyPortInput changes the mixed port used by the core and its consumers.
type ProxyPortInput struct {
	MixedPort int `json:"mixed_port"`
}

// ProxyTestInput lists the nodes that should be latency tested.
type ProxyTestInput struct {
	Names []string `json:"names"`
}

// ProxyNodeResult is a single latency probe result.
type ProxyNodeResult struct {
	Name  string `json:"name"`
	Delay int    `json:"delay"`
	Error string `json:"error,omitempty"`
}
