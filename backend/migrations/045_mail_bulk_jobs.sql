-- Durable bulk-mail jobs. Redis carries only job IDs; PostgreSQL remains the
-- source of truth for payloads, recipients, attachments and progress.

CREATE TABLE IF NOT EXISTS mail_bulk_jobs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id      BIGINT NOT NULL REFERENCES mail_accounts(id) ON DELETE CASCADE,
    status          VARCHAR(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')),
    subject         TEXT NOT NULL DEFAULT '',
    payload         JSONB NOT NULL,
    total_count     INTEGER NOT NULL CHECK (total_count > 0 AND total_count <= 1000),
    sent_count      INTEGER NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
    failed_count    INTEGER NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    last_error      TEXT NOT NULL DEFAULT '',
    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_bulk_jobs_user_created
    ON mail_bulk_jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mail_bulk_jobs_status
    ON mail_bulk_jobs(status, created_at) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS mail_bulk_recipients (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES mail_bulk_jobs(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL DEFAULT '',
    email           VARCHAR(320) NOT NULL,
    status          VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled')),
    message_id      TEXT NOT NULL DEFAULT '',
    error_message   TEXT NOT NULL DEFAULT '',
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (job_id, email)
);

CREATE INDEX IF NOT EXISTS idx_mail_bulk_recipients_job_status
    ON mail_bulk_recipients(job_id, status, id);

CREATE TABLE IF NOT EXISTS mail_bulk_attachments (
    id              BIGSERIAL PRIMARY KEY,
    job_id          BIGINT NOT NULL REFERENCES mail_bulk_jobs(id) ON DELETE CASCADE,
    filename        VARCHAR(255) NOT NULL,
    content_type    VARCHAR(255) NOT NULL DEFAULT 'application/octet-stream',
    data            BYTEA NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mail_bulk_attachments_job
    ON mail_bulk_attachments(job_id, id);
