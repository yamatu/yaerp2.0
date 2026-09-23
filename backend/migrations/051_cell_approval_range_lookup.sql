-- Whole-row AI sorting checks whether any approval record is bound to a row
-- in the target range. Keep the lookup bounded even on large sheets.
CREATE INDEX IF NOT EXISTS idx_cell_approval_states_sheet_row
    ON cell_approval_states (sheet_id, row_index);
