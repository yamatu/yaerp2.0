-- 付款凭证支持管理员软删除，并在回收站保留 30 天。
ALTER TABLE trade_customer_payment_proofs
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_customer_payment_proofs_deleted
    ON trade_customer_payment_proofs(deleted_at DESC, id DESC)
    WHERE deleted_at IS NOT NULL;
