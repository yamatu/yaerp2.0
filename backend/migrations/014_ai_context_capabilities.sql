-- YaERP 2.0 - Explicit multimodal capabilities for AI assistants

ALTER TABLE ai_assistants
    ADD COLUMN IF NOT EXISTS supports_vision BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS supports_files BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS linked_summary_id BIGINT REFERENCES ai_summary_pages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_channel_messages_summary
    ON channel_messages(linked_summary_id, channel_id)
    WHERE linked_summary_id IS NOT NULL;
