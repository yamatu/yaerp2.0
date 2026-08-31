CREATE TABLE IF NOT EXISTS departments (
    id BIGSERIAL PRIMARY KEY,
    name VARCHAR(120) NOT NULL UNIQUE,
    description TEXT NOT NULL DEFAULT '',
    created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS department_members (
    department_id BIGINT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (department_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_department_members_user_id
    ON department_members(user_id);

CREATE TABLE IF NOT EXISTS principal_sheet_permissions (
    id BIGSERIAL PRIMARY KEY,
    sheet_id BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    principal_type VARCHAR(20) NOT NULL CHECK (principal_type IN ('department', 'user')),
    principal_id BIGINT NOT NULL,
    can_view BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete BOOLEAN NOT NULL DEFAULT FALSE,
    can_export BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (sheet_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_principal_sheet_permissions_lookup
    ON principal_sheet_permissions(sheet_id, principal_type, principal_id);

CREATE TABLE IF NOT EXISTS principal_cell_permissions (
    id BIGSERIAL PRIMARY KEY,
    sheet_id BIGINT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
    principal_type VARCHAR(20) NOT NULL CHECK (principal_type IN ('department', 'user')),
    principal_id BIGINT NOT NULL,
    column_key VARCHAR(255) NOT NULL DEFAULT '',
    row_index INTEGER,
    permission VARCHAR(20) NOT NULL CHECK (permission IN ('none', 'read', 'write')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_principal_cell_permissions_scope
    ON principal_cell_permissions (
        sheet_id,
        principal_type,
        principal_id,
        COALESCE(column_key, ''),
        COALESCE(row_index, -1)
    );

CREATE INDEX IF NOT EXISTS idx_principal_cell_permissions_lookup
    ON principal_cell_permissions(sheet_id, principal_type, principal_id);
