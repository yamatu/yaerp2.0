-- YaERP 2.0 - Explicit AI provider and protocol capabilities

ALTER TABLE ai_assistants
    ADD COLUMN IF NOT EXISTS provider VARCHAR(32) NOT NULL DEFAULT 'openai_compatible',
    ADD COLUMN IF NOT EXISTS api_protocol VARCHAR(32) NOT NULL DEFAULT 'chat_completions',
    ADD COLUMN IF NOT EXISTS reasoning_effort VARCHAR(16) NOT NULL DEFAULT 'auto',
    ADD COLUMN IF NOT EXISTS supports_tools BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE ai_assistants DROP CONSTRAINT IF EXISTS ai_assistants_provider_check;
ALTER TABLE ai_assistants
    ADD CONSTRAINT ai_assistants_provider_check
    CHECK (provider IN ('openai', 'openai_compatible'));

ALTER TABLE ai_assistants DROP CONSTRAINT IF EXISTS ai_assistants_api_protocol_check;
ALTER TABLE ai_assistants
    ADD CONSTRAINT ai_assistants_api_protocol_check
    CHECK (api_protocol IN ('responses', 'chat_completions'));

ALTER TABLE ai_assistants DROP CONSTRAINT IF EXISTS ai_assistants_reasoning_effort_check;
ALTER TABLE ai_assistants
    ADD CONSTRAINT ai_assistants_reasoning_effort_check
    CHECK (reasoning_effort IN ('auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'));
