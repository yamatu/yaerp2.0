-- YaERP 2.0 - Multiple AI assistants and permission-scoped summary pages

CREATE TABLE IF NOT EXISTS ai_assistants (
    id            BIGSERIAL PRIMARY KEY,
    name          VARCHAR(128) NOT NULL,
    description   TEXT NOT NULL DEFAULT '',
    endpoint      TEXT NOT NULL,
    model         VARCHAR(128) NOT NULL,
    api_key       TEXT NOT NULL DEFAULT '',
    system_prompt TEXT NOT NULL DEFAULT '',
    enabled       BOOLEAN NOT NULL DEFAULT TRUE,
    is_default    BOOLEAN NOT NULL DEFAULT FALSE,
    created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_assistants_single_default
    ON ai_assistants(is_default)
    WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_ai_assistants_enabled
    ON ai_assistants(enabled, is_default DESC, id);

INSERT INTO ai_assistants (
    name,
    description,
    endpoint,
    model,
    api_key,
    system_prompt,
    enabled,
    is_default
)
SELECT
    '默认助手',
    '由原有 AI 配置自动迁移',
    COALESCE((SELECT value FROM settings WHERE key = 'ai_endpoint'), ''),
    COALESCE(NULLIF((SELECT value FROM settings WHERE key = 'ai_model'), ''), 'gpt-4o-mini'),
    COALESCE((SELECT value FROM settings WHERE key = 'ai_api_key'), ''),
    '',
    TRUE,
    TRUE
WHERE NOT EXISTS (SELECT 1 FROM ai_assistants)
  AND NOT EXISTS (SELECT 1 FROM settings WHERE key = 'ai_assistants_migrated')
  AND COALESCE((SELECT value FROM settings WHERE key = 'ai_endpoint'), '') <> '';

INSERT INTO settings (key, value, updated_at)
VALUES ('ai_assistants_migrated', 'true', NOW())
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS ai_summary_pages (
    id                  BIGSERIAL PRIMARY KEY,
    title               VARCHAR(256) NOT NULL,
    owner_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assistant_id        BIGINT REFERENCES ai_assistants(id) ON DELETE SET NULL,
    source_workbook_ids JSONB NOT NULL DEFAULT '[]',
    content             JSONB NOT NULL DEFAULT '{}',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_summary_pages_owner
    ON ai_summary_pages(owner_id, updated_at DESC, id DESC);
