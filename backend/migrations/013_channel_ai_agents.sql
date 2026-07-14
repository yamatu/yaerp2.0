-- YaERP 2.0 - AI assistants in group channels and private bot conversations

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS channel_type VARCHAR(16) NOT NULL DEFAULT 'group',
    ADD COLUMN IF NOT EXISTS ai_assistant_id BIGINT REFERENCES ai_assistants(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'channels_type_check'
    ) THEN
        ALTER TABLE channels
            ADD CONSTRAINT channels_type_check
            CHECK (channel_type IN ('group', 'ai_private'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_channels_ai_private_owner
    ON channels(owner_id, ai_assistant_id)
    WHERE channel_type = 'ai_private' AND ai_assistant_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS channel_ai_members (
    channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    assistant_id BIGINT NOT NULL REFERENCES ai_assistants(id) ON DELETE CASCADE,
    added_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, assistant_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_ai_members_assistant
    ON channel_ai_members(assistant_id, channel_id);

INSERT INTO channel_ai_members (channel_id, assistant_id, added_by)
SELECT id, ai_assistant_id, owner_id
  FROM channels
 WHERE channel_type = 'ai_private'
   AND ai_assistant_id IS NOT NULL
ON CONFLICT (channel_id, assistant_id) DO NOTHING;

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS sender_type VARCHAR(16) NOT NULL DEFAULT 'user',
    ADD COLUMN IF NOT EXISTS assistant_id BIGINT REFERENCES ai_assistants(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'channel_messages_sender_type_check'
    ) THEN
        ALTER TABLE channel_messages
            ADD CONSTRAINT channel_messages_sender_type_check
            CHECK (sender_type IN ('user', 'ai'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_channel_messages_assistant
    ON channel_messages(assistant_id, channel_id, created_at DESC);
