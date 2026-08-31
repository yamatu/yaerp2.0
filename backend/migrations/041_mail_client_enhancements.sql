-- Mail proxy, contacts, batch operations and automatic forwarding support.

ALTER TABLE mail_server_settings
    ADD COLUMN IF NOT EXISTS proxy_type VARCHAR(16) NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS proxy_host VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS proxy_port INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS proxy_username VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS proxy_password_encrypted TEXT NOT NULL DEFAULT '';

ALTER TABLE mail_server_settings
    DROP CONSTRAINT IF EXISTS mail_server_settings_proxy_type_check;
ALTER TABLE mail_server_settings
    ADD CONSTRAINT mail_server_settings_proxy_type_check
    CHECK (proxy_type IN ('none', 'socks5'));

ALTER TABLE mail_server_settings
    DROP CONSTRAINT IF EXISTS mail_server_settings_proxy_port_check;
ALTER TABLE mail_server_settings
    ADD CONSTRAINT mail_server_settings_proxy_port_check
    CHECK (proxy_type = 'none' OR proxy_port BETWEEN 1 AND 65535);

ALTER TABLE mail_accounts
    ADD COLUMN IF NOT EXISTS auto_forward_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS auto_forward_to TEXT[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS forward_attachments BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS forward_uid_validity BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS forward_last_uid BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS mail_contacts (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    trade_customer_id   BIGINT REFERENCES trade_customers(id) ON DELETE SET NULL,
    name                VARCHAR(255) NOT NULL DEFAULT '',
    company             VARCHAR(255) NOT NULL DEFAULT '',
    email               VARCHAR(320) NOT NULL,
    phone               VARCHAR(100) NOT NULL DEFAULT '',
    notes               TEXT NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, email)
);

CREATE INDEX IF NOT EXISTS idx_mail_contacts_user_search
    ON mail_contacts(user_id, lower(email), lower(name));

CREATE TABLE IF NOT EXISTS mail_forward_events (
    id                  BIGSERIAL PRIMARY KEY,
    account_id          BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    folder              VARCHAR(255) NOT NULL DEFAULT 'INBOX',
    uid_validity        BIGINT NOT NULL,
    message_uid         BIGINT NOT NULL,
    message_id          TEXT NOT NULL DEFAULT '',
    recipients          TEXT[] NOT NULL DEFAULT '{}',
    status              VARCHAR(16) NOT NULL DEFAULT 'sent'
        CHECK (status IN ('sent', 'failed')),
    error_message       TEXT NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, folder, uid_validity, message_uid)
);
