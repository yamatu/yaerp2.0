-- YaERP 2.0 - User-level folder sharing

CREATE TABLE IF NOT EXISTS folder_shares (
    folder_id   BIGINT REFERENCES folders(id) ON DELETE CASCADE,
    user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (folder_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_folder_shares_user ON folder_shares (user_id);
