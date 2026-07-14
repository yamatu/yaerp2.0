-- YaERP 2.0 - Channel message editing, WhatsApp quotes and channel backups

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS edited_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS reply_external_message_id VARCHAR(256),
    ADD COLUMN IF NOT EXISTS reply_snapshot_sender VARCHAR(256),
    ADD COLUMN IF NOT EXISTS reply_snapshot_content TEXT;

CREATE TABLE IF NOT EXISTS channel_message_edits (
    id          BIGSERIAL PRIMARY KEY,
    message_id  BIGINT NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
    edited_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    old_content TEXT NOT NULL DEFAULT '',
    new_content TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_message_edits_message
    ON channel_message_edits(message_id, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_backups (
    id                  BIGSERIAL PRIMARY KEY,
    source_channel_id   BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    source_channel_name VARCHAR(128) NOT NULL,
    created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    filename            VARCHAR(255) NOT NULL,
    attachment_id       BIGINT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    message_count       INTEGER NOT NULL DEFAULT 0,
    size                BIGINT NOT NULL DEFAULT 0,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_backups_creator
    ON channel_backups(created_by, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_channel_backups_source
    ON channel_backups(source_channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS channel_backup_restores (
    id                BIGSERIAL PRIMARY KEY,
    backup_id         BIGINT NOT NULL REFERENCES channel_backups(id) ON DELETE CASCADE,
    target_channel_id BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    restored_by       BIGINT REFERENCES users(id) ON DELETE SET NULL,
    message_count     INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_backup_restores_backup
    ON channel_backup_restores(backup_id, created_at DESC);
