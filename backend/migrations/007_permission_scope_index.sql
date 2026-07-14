-- YaERP 2.0 - normalized row / column / cell permission scopes

DELETE FROM cell_permissions old_perm
USING cell_permissions newer_perm
WHERE old_perm.id < newer_perm.id
  AND old_perm.sheet_id = newer_perm.sheet_id
  AND old_perm.role_id = newer_perm.role_id
  AND COALESCE(old_perm.column_key, '') = COALESCE(newer_perm.column_key, '')
  AND COALESCE(old_perm.row_index, -1) = COALESCE(newer_perm.row_index, -1);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cell_permissions_scope_unique
  ON cell_permissions (
    sheet_id,
    role_id,
    COALESCE(column_key, ''),
    COALESCE(row_index, -1)
  );

CREATE INDEX IF NOT EXISTS idx_cell_permissions_sheet_role
  ON cell_permissions (sheet_id, role_id);
