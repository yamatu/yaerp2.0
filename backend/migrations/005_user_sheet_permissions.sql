-- YaERP 2.0 - Direct user sheet permissions

CREATE TABLE IF NOT EXISTS user_sheet_permissions (
    id          BIGSERIAL PRIMARY KEY,
    sheet_id    BIGINT REFERENCES sheets(id) ON DELETE CASCADE,
    user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
    can_view    BOOLEAN DEFAULT FALSE,
    can_edit    BOOLEAN DEFAULT FALSE,
    can_delete  BOOLEAN DEFAULT FALSE,
    can_export  BOOLEAN DEFAULT FALSE,
    UNIQUE(sheet_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sheet_permissions_sheet_user
    ON user_sheet_permissions (sheet_id, user_id);
