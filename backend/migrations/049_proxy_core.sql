-- YaERP 2.0 - XTLS / Mihomo outbound proxy core

CREATE TABLE IF NOT EXISTS proxy_settings (
    id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    subscription_url  TEXT NOT NULL DEFAULT '',
    subscription_name TEXT NOT NULL DEFAULT '',
    source_type       VARCHAR(16) NOT NULL DEFAULT 'none',
    source_payload    TEXT NOT NULL DEFAULT '',
    config_yaml       TEXT NOT NULL DEFAULT '',
    selected_node     TEXT NOT NULL DEFAULT '',
    selected_group    TEXT NOT NULL DEFAULT '',
    enabled           BOOLEAN NOT NULL DEFAULT FALSE,
    proxy_ai          BOOLEAN NOT NULL DEFAULT FALSE,
    proxy_whatsapp    BOOLEAN NOT NULL DEFAULT FALSE,
    proxy_mail        BOOLEAN NOT NULL DEFAULT FALSE,
    last_error        TEXT NOT NULL DEFAULT '',
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO proxy_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
