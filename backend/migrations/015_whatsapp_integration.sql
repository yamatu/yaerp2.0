-- YaERP 2.0 - WhatsApp Web integration

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS external_source VARCHAR(32),
    ADD COLUMN IF NOT EXISTS external_message_id VARCHAR(256),
    ADD COLUMN IF NOT EXISTS external_sender_name VARCHAR(256),
    ADD COLUMN IF NOT EXISTS external_sender_address VARCHAR(256);

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'channel_messages_sender_type_check'
    ) THEN
        ALTER TABLE channel_messages DROP CONSTRAINT channel_messages_sender_type_check;
    END IF;
    ALTER TABLE channel_messages
        ADD CONSTRAINT channel_messages_sender_type_check
        CHECK (sender_type IN ('user', 'ai', 'whatsapp'));
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_external
    ON channel_messages(external_source, external_message_id)
    WHERE external_source IS NOT NULL AND external_message_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS whatsapp_channel_links (
    channel_id       BIGINT PRIMARY KEY REFERENCES channels(id) ON DELETE CASCADE,
    whatsapp_chat_id VARCHAR(256) NOT NULL UNIQUE,
    whatsapp_chat_name VARCHAR(256) NOT NULL DEFAULT '',
    sync_inbound     BOOLEAN NOT NULL DEFAULT TRUE,
    sync_outbound    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS whatsapp_message_links (
    id                  BIGSERIAL PRIMARY KEY,
    channel_message_id  BIGINT REFERENCES channel_messages(id) ON DELETE CASCADE,
    whatsapp_message_id VARCHAR(256) NOT NULL,
    direction           VARCHAR(16) NOT NULL,
    ack                 INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(channel_message_id, whatsapp_message_id)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_message_links_external
    ON whatsapp_message_links(whatsapp_message_id);

INSERT INTO settings (key, value, updated_at) VALUES
    ('whatsapp_enabled', 'false', NOW()),
    ('whatsapp_auto_start', 'true', NOW()),
    ('whatsapp_proxy_type', 'none', NOW()),
    ('whatsapp_proxy_host', '', NOW()),
    ('whatsapp_proxy_port', '', NOW()),
    ('whatsapp_proxy_username', '', NOW()),
    ('whatsapp_proxy_password', '', NOW())
ON CONFLICT (key) DO NOTHING;
