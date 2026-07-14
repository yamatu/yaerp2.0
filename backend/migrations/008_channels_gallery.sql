-- YaERP 2.0 - Channels and gallery directories

CREATE TABLE IF NOT EXISTS channels (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(128) NOT NULL,
    description TEXT,
    owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_owner ON channels(owner_id);

CREATE TABLE IF NOT EXISTS gallery_directories (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(128) NOT NULL,
    owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    channel_id  BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gallery_directories_owner ON gallery_directories(owner_id);
CREATE INDEX IF NOT EXISTS idx_gallery_directories_channel ON gallery_directories(channel_id);

CREATE TABLE IF NOT EXISTS gallery_images (
    id           BIGSERIAL PRIMARY KEY,
    attachment_id BIGINT REFERENCES attachments(id) ON DELETE CASCADE,
    directory_id  BIGINT REFERENCES gallery_directories(id) ON DELETE SET NULL,
    channel_id    BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    saved_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (attachment_id, directory_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_gallery_images_attachment ON gallery_images(attachment_id);
CREATE INDEX IF NOT EXISTS idx_gallery_images_directory ON gallery_images(directory_id);
CREATE INDEX IF NOT EXISTS idx_gallery_images_channel ON gallery_images(channel_id);

CREATE TABLE IF NOT EXISTS channel_messages (
    id             BIGSERIAL PRIMARY KEY,
    channel_id     BIGINT REFERENCES channels(id) ON DELETE CASCADE,
    sender_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    content        TEXT,
    attachment_id  BIGINT REFERENCES attachments(id) ON DELETE SET NULL,
    linked_workbook_id BIGINT REFERENCES workbooks(id) ON DELETE SET NULL,
    linked_sheet_id    BIGINT REFERENCES sheets(id) ON DELETE SET NULL,
    forwarded_from_message_id BIGINT REFERENCES channel_messages(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_messages_channel ON channel_messages(channel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_channel_messages_sender ON channel_messages(sender_id);
