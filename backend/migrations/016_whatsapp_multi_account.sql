-- YaERP 2.0 - Per-user WhatsApp accounts

CREATE TABLE IF NOT EXISTS whatsapp_accounts (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    enabled             BOOLEAN NOT NULL DEFAULT TRUE,
    auto_start          BOOLEAN NOT NULL DEFAULT TRUE,
    status              VARCHAR(32) NOT NULL DEFAULT 'disconnected',
    whatsapp_id         VARCHAR(256) NOT NULL DEFAULT '',
    display_name        VARCHAR(256) NOT NULL DEFAULT '',
    phone_number        VARCHAR(64) NOT NULL DEFAULT '',
    profile_pic_url     TEXT NOT NULL DEFAULT '',
    about               TEXT NOT NULL DEFAULT '',
    platform            VARCHAR(64) NOT NULL DEFAULT '',
    last_error          TEXT NOT NULL DEFAULT '',
    last_connected_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO whatsapp_accounts (user_id, enabled, auto_start)
SELECT id, TRUE, TRUE FROM users
ON CONFLICT (user_id) DO NOTHING;

ALTER TABLE whatsapp_channel_links
    ADD COLUMN IF NOT EXISTS whatsapp_account_id BIGINT REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
    ADD COLUMN IF NOT EXISTS whatsapp_chat_avatar_url TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS whatsapp_chat_about TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS whatsapp_is_group BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS whatsapp_participant_count INTEGER NOT NULL DEFAULT 0;

UPDATE whatsapp_channel_links link
   SET whatsapp_account_id = account.id
  FROM whatsapp_accounts account
 WHERE account.user_id = link.created_by
   AND link.whatsapp_account_id IS NULL;

UPDATE whatsapp_channel_links link
   SET whatsapp_account_id = account.id
  FROM channels channel
  JOIN whatsapp_accounts account ON account.user_id = channel.owner_id
 WHERE channel.id = link.channel_id
   AND link.whatsapp_account_id IS NULL;

ALTER TABLE whatsapp_channel_links DROP CONSTRAINT IF EXISTS whatsapp_channel_links_whatsapp_chat_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_channel_links_account_chat
    ON whatsapp_channel_links(whatsapp_account_id, whatsapp_chat_id)
    WHERE whatsapp_account_id IS NOT NULL;

ALTER TABLE whatsapp_message_links
    ADD COLUMN IF NOT EXISTS whatsapp_account_id BIGINT REFERENCES whatsapp_accounts(id) ON DELETE CASCADE;

UPDATE whatsapp_message_links message_link
   SET whatsapp_account_id = channel_link.whatsapp_account_id
  FROM channel_messages message
  JOIN whatsapp_channel_links channel_link ON channel_link.channel_id = message.channel_id
 WHERE message.id = message_link.channel_message_id
   AND message_link.whatsapp_account_id IS NULL;

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS external_account_id BIGINT REFERENCES whatsapp_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS external_sender_avatar TEXT;

UPDATE channel_messages message
   SET external_account_id = channel_link.whatsapp_account_id
  FROM whatsapp_channel_links channel_link
 WHERE channel_link.channel_id = message.channel_id
   AND message.external_source = 'whatsapp'
   AND message.external_account_id IS NULL;

DROP INDEX IF EXISTS idx_channel_messages_external;
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_external_account
    ON channel_messages(external_source, external_account_id, external_message_id)
    WHERE external_source IS NOT NULL AND external_account_id IS NOT NULL AND external_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_accounts_status
    ON whatsapp_accounts(enabled, auto_start, status);
