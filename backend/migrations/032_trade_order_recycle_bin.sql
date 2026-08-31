-- 外贸业务单回收站：订单先软删除，保留完整流程数据 30 天后再清理。
ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_orders_deleted_at
    ON trade_orders (deleted_at DESC)
    WHERE deleted_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_orders_active_updated
    ON trade_orders (updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;
