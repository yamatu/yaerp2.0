-- ERP changes proposed by AI are stored server-side and can only be applied once
-- by the same user after an explicit confirmation.
CREATE TABLE IF NOT EXISTS ai_erp_plans (
    id BIGSERIAL PRIMARY KEY,
    plan_token VARCHAR(96) NOT NULL UNIQUE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary TEXT NOT NULL DEFAULT '',
    action JSONB NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'applying', 'applied', 'failed', 'expired')),
    expires_at TIMESTAMPTZ NOT NULL,
    applied_at TIMESTAMPTZ,
    result JSONB,
    last_error TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_erp_plans_user_status
    ON ai_erp_plans(user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_erp_plans_expires
    ON ai_erp_plans(expires_at)
    WHERE status = 'pending';
