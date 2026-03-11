CREATE TABLE IF NOT EXISTS ai_schedules (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    sheet_id BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    job_type VARCHAR(64) NOT NULL,
    cron_expr VARCHAR(128) NOT NULL,
    timezone VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    filename_template VARCHAR(255) NOT NULL DEFAULT 'daily-report',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at TIMESTAMPTZ,
    last_status VARCHAR(32),
    last_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_schedules_active ON ai_schedules(active);
CREATE INDEX IF NOT EXISTS idx_ai_schedules_user_id ON ai_schedules(user_id);
