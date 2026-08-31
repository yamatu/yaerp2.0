-- 通用自动化规则、审批流、任务通知与执行历史
CREATE TABLE IF NOT EXISTS automation_rules (
    id                    BIGSERIAL PRIMARY KEY,
    name                  VARCHAR(160) NOT NULL,
    description           TEXT NOT NULL DEFAULT '',
    owner_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    sheet_id              BIGINT REFERENCES sheets(id) ON DELETE CASCADE,
    trigger_type          VARCHAR(24) NOT NULL CHECK (trigger_type IN ('cell_change', 'schedule', 'manual')),
    watched_columns       JSONB NOT NULL DEFAULT '[]',
    cron_expr             VARCHAR(160) NOT NULL DEFAULT '',
    timezone              VARCHAR(64) NOT NULL DEFAULT 'Asia/Shanghai',
    condition_logic       VARCHAR(8) NOT NULL DEFAULT 'all' CHECK (condition_logic IN ('all', 'any')),
    conditions            JSONB NOT NULL DEFAULT '[]',
    approval_steps        JSONB NOT NULL DEFAULT '[]',
    actions               JSONB NOT NULL DEFAULT '[]',
    enabled               BOOLEAN NOT NULL DEFAULT TRUE,
    last_triggered_at     TIMESTAMPTZ,
    last_status           VARCHAR(32),
    last_message          TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_rules_trigger
    ON automation_rules (trigger_type, enabled, sheet_id);
CREATE INDEX IF NOT EXISTS idx_automation_rules_owner
    ON automation_rules (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS automation_trigger_states (
    rule_id               BIGINT NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
    sheet_id              BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_index             INTEGER NOT NULL,
    last_match            BOOLEAN NOT NULL DEFAULT FALSE,
    last_fingerprint      VARCHAR(64) NOT NULL DEFAULT '',
    last_triggered_at     TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (rule_id, sheet_id, row_index)
);

CREATE TABLE IF NOT EXISTS automation_runs (
    id                    BIGSERIAL PRIMARY KEY,
    rule_id               BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL,
    rule_name             VARCHAR(160) NOT NULL,
    rule_snapshot         JSONB NOT NULL,
    trigger_type          VARCHAR(24) NOT NULL,
    status                VARCHAR(32) NOT NULL CHECK (status IN ('running', 'waiting_approval', 'completed', 'rejected', 'failed', 'cancelled')),
    triggered_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    sheet_id              BIGINT REFERENCES sheets(id) ON DELETE SET NULL,
    row_index             INTEGER,
    idempotency_key       VARCHAR(200),
    trigger_context       JSONB NOT NULL DEFAULT '{}',
    current_step          INTEGER NOT NULL DEFAULT 0,
    result                JSONB NOT NULL DEFAULT '{}',
    error_message         TEXT NOT NULL DEFAULT '',
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_runs_rule_created
    ON automation_runs (rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_status_created
    ON automation_runs (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_actor_created
    ON automation_runs (triggered_by, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_idempotency
    ON automation_runs (idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_requests (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    step_index            INTEGER NOT NULL,
    name                  VARCHAR(160) NOT NULL,
    status                VARCHAR(24) NOT NULL CHECK (status IN ('queued', 'pending', 'approved', 'rejected', 'cancelled')),
    required_approvals    INTEGER NOT NULL DEFAULT 1 CHECK (required_approvals > 0),
    activated_at          TIMESTAMPTZ,
    decided_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_approval_requests_run
    ON approval_requests (run_id, step_index);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status
    ON approval_requests (status, activated_at DESC);

CREATE TABLE IF NOT EXISTS approval_assignees (
    request_id            BIGINT NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source_type           VARCHAR(24) NOT NULL DEFAULT 'user' CHECK (source_type IN ('user', 'department')),
    source_id             BIGINT,
    status                VARCHAR(24) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
    comment               TEXT NOT NULL DEFAULT '',
    decided_at            TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (request_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_approval_assignees_user_status
    ON approval_assignees (user_id, status, request_id);

CREATE TABLE IF NOT EXISTS automation_run_logs (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    level                 VARCHAR(16) NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'warning', 'error')),
    event                 VARCHAR(64) NOT NULL,
    message               TEXT NOT NULL DEFAULT '',
    details               JSONB NOT NULL DEFAULT '{}',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_automation_run_logs_run
    ON automation_run_logs (run_id, created_at, id);

CREATE TABLE IF NOT EXISTS user_notifications (
    id                    BIGSERIAL PRIMARY KEY,
    user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    notification_type     VARCHAR(40) NOT NULL DEFAULT 'automation',
    title                 VARCHAR(200) NOT NULL,
    content               TEXT NOT NULL DEFAULT '',
    link_url              VARCHAR(512) NOT NULL DEFAULT '',
    entity_type           VARCHAR(40) NOT NULL DEFAULT '',
    entity_id             BIGINT,
    metadata              JSONB NOT NULL DEFAULT '{}',
    read_at               TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_notifications_user_created
    ON user_notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_notifications_unread
    ON user_notifications (user_id, created_at DESC)
    WHERE read_at IS NULL;
