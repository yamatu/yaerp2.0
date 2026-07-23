-- Poste.io compatible mail client configuration and per-user mailbox bindings.

CREATE TABLE IF NOT EXISTS mail_server_settings (
    id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    imap_host           VARCHAR(255) NOT NULL DEFAULT '',
    imap_port           INTEGER NOT NULL DEFAULT 993 CHECK (imap_port BETWEEN 1 AND 65535),
    imap_security       VARCHAR(16) NOT NULL DEFAULT 'tls'
        CHECK (imap_security IN ('tls', 'starttls')),
    smtp_host           VARCHAR(255) NOT NULL DEFAULT '',
    smtp_port           INTEGER NOT NULL DEFAULT 465 CHECK (smtp_port BETWEEN 1 AND 65535),
    smtp_security       VARCHAR(16) NOT NULL DEFAULT 'tls'
        CHECK (smtp_security IN ('tls', 'starttls')),
    default_domain      VARCHAR(255) NOT NULL DEFAULT '',
    allow_insecure_tls  BOOLEAN NOT NULL DEFAULT FALSE,
    max_attachment_mb   INTEGER NOT NULL DEFAULT 25 CHECK (max_attachment_mb BETWEEN 1 AND 50),
    updated_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO mail_server_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS mail_accounts (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    email_address       VARCHAR(320) NOT NULL,
    display_name        VARCHAR(255) NOT NULL DEFAULT '',
    username            VARCHAR(320) NOT NULL,
    password_encrypted  TEXT NOT NULL,
    signature_html      TEXT NOT NULL DEFAULT '',
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    last_verified_at    TIMESTAMPTZ,
    last_sync_at        TIMESTAMPTZ,
    last_error          TEXT NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_accounts_enabled
    ON mail_accounts(enabled, user_id);
