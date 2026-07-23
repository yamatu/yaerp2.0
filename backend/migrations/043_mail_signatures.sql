-- Per-user reusable mail signatures with independent defaults for new mail
-- and reply/forward flows. Keep mail_accounts.signature_html as a legacy
-- fallback for older clients.

CREATE TABLE IF NOT EXISTS mail_signatures (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title               VARCHAR(100) NOT NULL,
    html_content        TEXT NOT NULL DEFAULT '',
    apply_to_new        BOOLEAN NOT NULL DEFAULT FALSE,
    apply_to_reply      BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, title)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_signatures_default_new
    ON mail_signatures(user_id) WHERE apply_to_new;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_signatures_default_reply
    ON mail_signatures(user_id) WHERE apply_to_reply;
