-- YaERP 2.0 - Folder hierarchy for file manager view

-- 文件夹表
CREATE TABLE IF NOT EXISTS folders (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(256) NOT NULL,
    parent_id   BIGINT REFERENCES folders(id) ON DELETE CASCADE,
    owner_id    BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders (parent_id);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders (owner_id);

-- 文件夹可见性（按角色）
CREATE TABLE IF NOT EXISTS folder_visibility (
    folder_id   BIGINT REFERENCES folders(id) ON DELETE CASCADE,
    role_id     BIGINT REFERENCES roles(id) ON DELETE CASCADE,
    visible     BOOLEAN DEFAULT TRUE,
    PRIMARY KEY (folder_id, role_id)
);

-- 工作簿关联文件夹
ALTER TABLE workbooks ADD COLUMN IF NOT EXISTS folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_workbooks_folder ON workbooks (folder_id);

-- AI 设置表（用于 Phase 3）
CREATE TABLE IF NOT EXISTS settings (
    key         VARCHAR(128) PRIMARY KEY,
    value       TEXT NOT NULL,
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);
