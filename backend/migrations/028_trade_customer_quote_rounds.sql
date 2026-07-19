-- 对客报价与议价：保存每次报价版本、客户反馈和最终接受状态
CREATE TABLE IF NOT EXISTS trade_customer_quote_rounds (
    id                BIGSERIAL PRIMARY KEY,
    order_id          BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    round_no          INTEGER NOT NULL,
    currency          VARCHAR(8) NOT NULL DEFAULT 'USD',
    status            VARCHAR(24) NOT NULL DEFAULT 'draft',
    total_amount      NUMERIC(18,4) NOT NULL DEFAULT 0,
    item_prices       JSONB NOT NULL DEFAULT '[]'::jsonb,
    customer_feedback TEXT NOT NULL DEFAULT '',
    notes             TEXT NOT NULL DEFAULT '',
    created_by        BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    sent_at           TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, round_no),
    CONSTRAINT trade_customer_quote_rounds_status_check
        CHECK (status IN ('draft', 'sent', 'negotiating', 'accepted', 'rejected', 'superseded'))
);

CREATE INDEX IF NOT EXISTS idx_trade_customer_quote_rounds_order
    ON trade_customer_quote_rounds(order_id, round_no DESC, id DESC);

UPDATE trade_positions
SET name = '对客报价与议价',
    description = '向客户报价、记录砍价反馈并进行多轮重新报价'
WHERE code = 'quotation';
