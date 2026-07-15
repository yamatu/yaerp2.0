ALTER TABLE channel_backups
    ADD COLUMN IF NOT EXISTS checksum VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS snapshot_version INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_channel_backups_verified
    ON channel_backups(verified_at DESC, created_at DESC);
