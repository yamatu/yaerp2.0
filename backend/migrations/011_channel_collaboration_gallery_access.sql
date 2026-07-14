-- YaERP 2.0 - Channel replies, recall, avatars, pin order, and gallery access

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS avatar_attachment_id BIGINT REFERENCES attachments(id) ON DELETE SET NULL;

ALTER TABLE channel_members
    ADD COLUMN IF NOT EXISTS pin_sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE channel_messages
    ADD COLUMN IF NOT EXISTS reply_to_message_id BIGINT REFERENCES channel_messages(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS recalled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS recalled_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE gallery_directories
    ADD COLUMN IF NOT EXISTS visibility VARCHAR(16) NOT NULL DEFAULT 'private';

UPDATE gallery_directories
   SET visibility = 'channel'
 WHERE channel_id IS NOT NULL
   AND visibility = 'private';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM pg_constraint
         WHERE conname = 'gallery_directories_visibility_check'
    ) THEN
        ALTER TABLE gallery_directories
            ADD CONSTRAINT gallery_directories_visibility_check
            CHECK (visibility IN ('private', 'channel', 'public'));
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS gallery_directory_permissions (
    directory_id BIGINT NOT NULL REFERENCES gallery_directories(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    can_view     BOOLEAN NOT NULL DEFAULT TRUE,
    can_edit     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (directory_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_members_pin_order
    ON channel_members(user_id, is_pinned, pin_sort_order, channel_id);

CREATE INDEX IF NOT EXISTS idx_channel_messages_reply
    ON channel_messages(reply_to_message_id);

CREATE INDEX IF NOT EXISTS idx_gallery_directory_permissions_user
    ON gallery_directory_permissions(user_id, directory_id);
