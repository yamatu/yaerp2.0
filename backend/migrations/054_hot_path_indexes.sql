-- Opening a workbook lists its sheets by workbook_id; without an index every
-- open scanned the whole sheets table.
CREATE INDEX IF NOT EXISTS idx_sheets_workbook
    ON sheets (workbook_id, sort_order, id);

-- The channel list looks up the customer linked to each channel.
CREATE INDEX IF NOT EXISTS idx_trade_customers_channel
    ON trade_customers (channel_id, updated_at DESC)
    WHERE channel_id IS NOT NULL;

-- Stage permissions resolve the members of a position.
CREATE INDEX IF NOT EXISTS idx_trade_user_positions_position
    ON trade_user_positions (position_id);
