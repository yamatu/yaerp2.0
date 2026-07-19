-- 工作表完整版本与可查询操作审计
ALTER TABLE operation_logs
    ADD COLUMN IF NOT EXISTS resource_type VARCHAR(32) NOT NULL DEFAULT 'sheet',
    ADD COLUMN IF NOT EXISTS resource_id BIGINT,
    ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'web',
    ADD COLUMN IF NOT EXISTS summary VARCHAR(512) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS request_id VARCHAR(64),
    ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64),
    ADD COLUMN IF NOT EXISTS user_agent VARCHAR(512);

ALTER TABLE operation_logs
    ALTER COLUMN column_key TYPE VARCHAR(128),
    ALTER COLUMN action TYPE VARCHAR(64);

UPDATE operation_logs
   SET resource_id = sheet_id
 WHERE resource_id IS NULL AND sheet_id IS NOT NULL;

DO $$
DECLARE
    user_delete_action "char";
    sheet_delete_action "char";
BEGIN
    SELECT c.confdeltype INTO user_delete_action
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'operation_logs' AND c.conname = 'operation_logs_user_id_fkey';
    IF user_delete_action IS DISTINCT FROM 'n' THEN
        ALTER TABLE operation_logs DROP CONSTRAINT IF EXISTS operation_logs_user_id_fkey;
        ALTER TABLE operation_logs
            ADD CONSTRAINT operation_logs_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;

    SELECT c.confdeltype INTO sheet_delete_action
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
     WHERE t.relname = 'operation_logs' AND c.conname = 'operation_logs_sheet_id_fkey';
    IF sheet_delete_action IS DISTINCT FROM 'n' THEN
        ALTER TABLE operation_logs DROP CONSTRAINT IF EXISTS operation_logs_sheet_id_fkey;
        ALTER TABLE operation_logs
            ADD CONSTRAINT operation_logs_sheet_id_fkey
            FOREIGN KEY (sheet_id) REFERENCES sheets(id) ON DELETE SET NULL;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_operation_logs_user_created
    ON operation_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_action_created
    ON operation_logs (action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_resource_created
    ON operation_logs (resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_operation_logs_metadata
    ON operation_logs USING GIN (metadata);

CREATE TABLE IF NOT EXISTS sheet_versions (
    id                  BIGSERIAL PRIMARY KEY,
    sheet_id            BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    version_number      BIGINT NOT NULL,
    created_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    source              VARCHAR(32) NOT NULL,
    summary             VARCHAR(512) NOT NULL DEFAULT '',
    snapshot            JSONB NOT NULL,
    checksum            CHAR(64) NOT NULL,
    change_count        INTEGER NOT NULL DEFAULT 1,
    restored_from_id    BIGINT REFERENCES sheet_versions(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(sheet_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_sheet_versions_sheet_updated
    ON sheet_versions (sheet_id, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_sheet_versions_actor_updated
    ON sheet_versions (created_by, updated_at DESC);
