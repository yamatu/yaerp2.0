-- 表格内选区审批：待审批值独立暂存，审批通过后才写入正式单元格。
ALTER TABLE automation_rules
    ADD COLUMN IF NOT EXISTS approval_ranges JSONB NOT NULL DEFAULT '[]';

ALTER TABLE automation_rules
    ADD COLUMN IF NOT EXISTS hold_changes BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS cell_approval_states (
    id                    BIGSERIAL PRIMARY KEY,
    run_id                BIGINT NOT NULL REFERENCES automation_runs(id) ON DELETE CASCADE,
    rule_id               BIGINT REFERENCES automation_rules(id) ON DELETE SET NULL,
    sheet_id              BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    row_index             INTEGER NOT NULL,
    column_key            VARCHAR(160) NOT NULL,
    status                VARCHAR(24) NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'approved', 'rejected', 'failed', 'cancelled')),
    proposed_value        JSONB NOT NULL DEFAULT 'null',
    original_value        JSONB NOT NULL DEFAULT 'null',
    submitted_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    submitted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at            TIMESTAMPTZ,
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cell_approval_states_pending_cell
    ON cell_approval_states (sheet_id, row_index, column_key)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_cell_approval_states_sheet_status
    ON cell_approval_states (sheet_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_cell_approval_states_run
    ON cell_approval_states (run_id, id);
