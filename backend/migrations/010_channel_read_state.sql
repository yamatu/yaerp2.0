-- YaERP 2.0 - Per-user channel read state for unread notifications

CREATE TABLE IF NOT EXISTS channel_read_states (
    channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (channel_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_channel_read_states_user
    ON channel_read_states(user_id, channel_id, last_read_at);

INSERT INTO channel_read_states (channel_id, user_id, last_read_at, updated_at)
SELECT channel_id, user_id, NOW(), NOW()
  FROM channel_members
ON CONFLICT (channel_id, user_id) DO NOTHING;
