-- Account-owned conversations and backend-owned runs. Do not store history in
-- a browser: all devices of an account read the same ordered message records.
CREATE TABLE IF NOT EXISTS ai_conversations (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '新对话',
    assistant_id BIGINT,
    context JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_conversations_owner ON ai_conversations(user_id, updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS ai_conversation_messages (
    seq BIGSERIAL PRIMARY KEY,
    id TEXT NOT NULL UNIQUE,
    conversation_id BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user','assistant')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_conversation_messages_order ON ai_conversation_messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS ai_conversation_runs (
    id BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL REFERENCES ai_conversation_messages(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','interrupted')),
    activity TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(conversation_id, request_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_conversation_active_run ON ai_conversation_runs(conversation_id)
    WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS idx_ai_conversation_runs_latest ON ai_conversation_runs(conversation_id, id DESC);
