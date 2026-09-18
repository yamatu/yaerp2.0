package repo

import (
	"database/sql"

	"yaerp/internal/model"
)

// ProxyRepo stores the single global proxy configuration row (id = 1).
type ProxyRepo struct{ db *sql.DB }

func NewProxyRepo(db *sql.DB) *ProxyRepo { return &ProxyRepo{db: db} }

const proxySelectSQL = `SELECT id, subscription_url, subscription_name, source_type,
	source_payload, config_yaml, selected_node, selected_group, enabled,
	proxy_ai, proxy_whatsapp, proxy_mail, last_error, created_at, updated_at
	FROM proxy_settings WHERE id = 1`

func (r *ProxyRepo) Get() (*model.ProxySettings, error) {
	if _, err := r.db.Exec(`INSERT INTO proxy_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`); err != nil {
		return nil, err
	}
	settings := &model.ProxySettings{}
	err := r.db.QueryRow(proxySelectSQL).Scan(
		&settings.ID, &settings.SubscriptionURL, &settings.SubscriptionName, &settings.SourceType,
		&settings.SourcePayload, &settings.ConfigYAML, &settings.SelectedNode, &settings.SelectedGroup,
		&settings.Enabled, &settings.ProxyAI, &settings.ProxyWhatsApp, &settings.ProxyMail,
		&settings.LastError, &settings.CreatedAt, &settings.UpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	return settings, nil
}

func (r *ProxyRepo) Save(settings *model.ProxySettings) error {
	if settings == nil {
		return nil
	}
	_, err := r.db.Exec(
		`INSERT INTO proxy_settings (
			id, subscription_url, subscription_name, source_type, source_payload, config_yaml,
			selected_node, selected_group, enabled, proxy_ai, proxy_whatsapp, proxy_mail,
			last_error, updated_at
		) VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
		ON CONFLICT (id) DO UPDATE SET
			subscription_url = EXCLUDED.subscription_url,
			subscription_name = EXCLUDED.subscription_name,
			source_type = EXCLUDED.source_type,
			source_payload = EXCLUDED.source_payload,
			config_yaml = EXCLUDED.config_yaml,
			selected_node = EXCLUDED.selected_node,
			selected_group = EXCLUDED.selected_group,
			enabled = EXCLUDED.enabled,
			proxy_ai = EXCLUDED.proxy_ai,
			proxy_whatsapp = EXCLUDED.proxy_whatsapp,
			proxy_mail = EXCLUDED.proxy_mail,
			last_error = EXCLUDED.last_error,
			updated_at = NOW()`,
		settings.SubscriptionURL, settings.SubscriptionName, settings.SourceType, settings.SourcePayload,
		settings.ConfigYAML, settings.SelectedNode, settings.SelectedGroup, settings.Enabled,
		settings.ProxyAI, settings.ProxyWhatsApp, settings.ProxyMail, settings.LastError,
	)
	return err
}
