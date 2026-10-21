-- YaERP 2.0 - one-off maintenance jobs
-- Migrations run before the server starts, so they must stay cheap. Data
-- rewrites over large tables (such as shrinking oversized operation log
-- metadata) run in the background after startup, in small batches, and are
-- recorded here once finished so they never repeat.

CREATE TABLE IF NOT EXISTS maintenance_jobs (
    name         VARCHAR(100) PRIMARY KEY,
    completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
