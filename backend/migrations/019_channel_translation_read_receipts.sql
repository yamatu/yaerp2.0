-- YaERP 2.0 - Channel AI translations and message read receipts

CREATE TABLE IF NOT EXISTS channel_message_translations (
    id                 BIGSERIAL PRIMARY KEY,
    message_id         BIGINT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    target_language    VARCHAR(32) NOT NULL,
    source_content     TEXT NOT NULL,
    translated_content TEXT NOT NULL,
    assistant_id       BIGINT REFERENCES ai_assistants(id) ON DELETE SET NULL,
    model              VARCHAR(256) NOT NULL DEFAULT '',
    translated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (message_id, target_language)
);

CREATE INDEX IF NOT EXISTS idx_channel_message_translations_message
    ON channel_message_translations(message_id, target_language);
