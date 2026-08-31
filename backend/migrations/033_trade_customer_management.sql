-- 客户资料维护与删除审批：保留历史订单，只从当前客户档案中软删除。
ALTER TABLE trade_customers
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deleted_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

DROP INDEX IF EXISTS uq_trade_customers_owner_whatsapp_chat;
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_customers_owner_whatsapp_chat
    ON trade_customers (owner_id, whatsapp_chat_id)
    WHERE whatsapp_chat_id IS NOT NULL
      AND whatsapp_chat_id <> ''
      AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_trade_customers_active_updated
    ON trade_customers (updated_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS trade_customer_delete_requests (
    id                  BIGSERIAL PRIMARY KEY,
    customer_id         BIGINT NOT NULL REFERENCES trade_customers(id) ON DELETE CASCADE,
    requested_by        BIGINT REFERENCES users(id) ON DELETE SET NULL,
    reason              TEXT NOT NULL DEFAULT '',
    status              VARCHAR(16) NOT NULL DEFAULT 'pending',
    decided_by          BIGINT REFERENCES users(id) ON DELETE SET NULL,
    decision_comment    TEXT NOT NULL DEFAULT '',
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    decided_at          TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trade_customer_delete_requests_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_customer_pending_delete_request
    ON trade_customer_delete_requests (customer_id)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_trade_customer_delete_requests_status
    ON trade_customer_delete_requests (status, requested_at DESC, id DESC);
