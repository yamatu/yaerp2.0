-- Multiple mailbox providers per employee. Existing Poste.io bindings remain
-- IMAP accounts and become the default account for their owner.

ALTER TABLE mail_accounts
    DROP CONSTRAINT IF EXISTS mail_accounts_user_id_key;

ALTER TABLE mail_accounts
    ADD COLUMN IF NOT EXISTS provider VARCHAR(24) NOT NULL DEFAULT 'imap',
    ADD COLUMN IF NOT EXISTS api_base_url VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS client_id VARCHAR(255) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS client_secret_encrypted TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE mail_accounts
    DROP CONSTRAINT IF EXISTS mail_accounts_provider_check;
ALTER TABLE mail_accounts
    ADD CONSTRAINT mail_accounts_provider_check
    CHECK (provider IN ('imap', 'alimail'));

UPDATE mail_accounts AS account
   SET is_default = TRUE
 WHERE account.id IN (
    SELECT MIN(candidate.id)
      FROM mail_accounts AS candidate
     GROUP BY candidate.user_id
    HAVING NOT BOOL_OR(candidate.is_default)
 );

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_user_provider_address
    ON mail_accounts(user_id, provider, lower(email_address));

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_accounts_user_default
    ON mail_accounts(user_id) WHERE is_default;

CREATE INDEX IF NOT EXISTS idx_mail_accounts_user_order
    ON mail_accounts(user_id, is_default DESC, id);

-- AliMail uses opaque string message IDs. Keep a stable local numeric UID so
-- existing routes, browser history and UI selection logic remain compatible.
CREATE TABLE IF NOT EXISTS mail_remote_message_refs (
    uid             BIGSERIAL PRIMARY KEY,
    account_id      BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    remote_id       TEXT NOT NULL,
    folder_id       TEXT NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (account_id, remote_id)
);

CREATE INDEX IF NOT EXISTS idx_mail_remote_message_refs_account_uid
    ON mail_remote_message_refs(account_id, uid);
