-- YaERP 2.0 Database Schema

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    id          BIGSERIAL PRIMARY KEY,
    username    VARCHAR(64) UNIQUE NOT NULL,
    email       VARCHAR(128) UNIQUE NOT NULL,
    password    VARCHAR(256) NOT NULL,
    avatar      VARCHAR(512),
    status      SMALLINT DEFAULT 1,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 角色表
CREATE TABLE IF NOT EXISTS roles (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(64) UNIQUE NOT NULL,
    code        VARCHAR(64) UNIQUE NOT NULL,
    description TEXT,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 用户-角色关联
CREATE TABLE IF NOT EXISTS user_roles (
    user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
    role_id BIGINT REFERENCES roles(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, role_id)
);

-- 工作簿
CREATE TABLE IF NOT EXISTS workbooks (
    id          BIGSERIAL PRIMARY KEY,
    name        VARCHAR(256) NOT NULL,
    description TEXT,
    owner_id    BIGINT REFERENCES users(id),
    metadata    JSONB DEFAULT '{}',
    is_template BOOLEAN DEFAULT FALSE,
    status      SMALLINT DEFAULT 1,
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 工作表
CREATE TABLE IF NOT EXISTS sheets (
    id          BIGSERIAL PRIMARY KEY,
    workbook_id BIGINT REFERENCES workbooks(id) ON DELETE CASCADE,
    name        VARCHAR(256) NOT NULL,
    sort_order  INT DEFAULT 0,
    columns     JSONB NOT NULL DEFAULT '[]',
    frozen      JSONB DEFAULT '{"row": 0, "col": 0}',
    config      JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 行数据
CREATE TABLE IF NOT EXISTS rows (
    id          BIGSERIAL PRIMARY KEY,
    sheet_id    BIGINT REFERENCES sheets(id) ON DELETE CASCADE,
    row_index   INT NOT NULL,
    data        JSONB NOT NULL DEFAULT '{}',
    created_by  BIGINT REFERENCES users(id),
    updated_by  BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW(),
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(sheet_id, row_index)
);

CREATE INDEX IF NOT EXISTS idx_rows_data ON rows USING GIN (data);
CREATE INDEX IF NOT EXISTS idx_rows_sheet_id ON rows (sheet_id, row_index);

-- 表级权限
CREATE TABLE IF NOT EXISTS sheet_permissions (
    id          BIGSERIAL PRIMARY KEY,
    sheet_id    BIGINT REFERENCES sheets(id) ON DELETE CASCADE,
    role_id     BIGINT REFERENCES roles(id) ON DELETE CASCADE,
    can_view    BOOLEAN DEFAULT FALSE,
    can_edit    BOOLEAN DEFAULT FALSE,
    can_delete  BOOLEAN DEFAULT FALSE,
    can_export  BOOLEAN DEFAULT FALSE,
    UNIQUE(sheet_id, role_id)
);

-- 列/单元格级权限
CREATE TABLE IF NOT EXISTS cell_permissions (
    id          BIGSERIAL PRIMARY KEY,
    sheet_id    BIGINT REFERENCES sheets(id) ON DELETE CASCADE,
    role_id     BIGINT REFERENCES roles(id) ON DELETE CASCADE,
    column_key  VARCHAR(8),
    row_index   INT,
    permission  VARCHAR(16) NOT NULL,
    UNIQUE(sheet_id, role_id, column_key, row_index)
);

-- 操作日志
CREATE TABLE IF NOT EXISTS operation_logs (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT REFERENCES users(id),
    sheet_id    BIGINT REFERENCES sheets(id),
    row_index   INT,
    column_key  VARCHAR(8),
    action      VARCHAR(32) NOT NULL,
    old_value   JSONB,
    new_value   JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_logs_sheet ON operation_logs (sheet_id, created_at DESC);

-- 文件附件
CREATE TABLE IF NOT EXISTS attachments (
    id          BIGSERIAL PRIMARY KEY,
    filename    VARCHAR(512) NOT NULL,
    mime_type   VARCHAR(128),
    size        BIGINT,
    bucket      VARCHAR(128) DEFAULT 'yaerp',
    object_key  VARCHAR(512) NOT NULL,
    uploader_id BIGINT REFERENCES users(id),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- 插入默认角色
INSERT INTO roles (name, code, description) VALUES
    ('管理员', 'admin', '系统管理员，拥有所有权限'),
    ('编辑者', 'editor', '可以编辑表格数据'),
    ('查看者', 'viewer', '只能查看表格数据')
ON CONFLICT (code) DO NOTHING;

-- 插入默认管理员用户 (密码: admin123)
-- bcrypt hash of 'admin123'
INSERT INTO users (username, email, password) VALUES
    ('admin', 'admin@yaerp.local', '$2a$10$NQk/X0Vo563o4PMTt1i7yuO9vQTxFepMhCNuqQ5QbfKGJSGpV/QeK')
ON CONFLICT (username) DO NOTHING;

-- 给管理员分配角色
INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u, roles r
WHERE u.username = 'admin' AND r.code = 'admin'
ON CONFLICT DO NOTHING;
