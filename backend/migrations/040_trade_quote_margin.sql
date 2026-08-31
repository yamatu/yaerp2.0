-- Persist the cost markup used to prepare each customer quote round.
ALTER TABLE trade_customer_quote_rounds
    ADD COLUMN IF NOT EXISTS profit_margin_percent NUMERIC(8, 4) NOT NULL DEFAULT 0;

ALTER TABLE trade_customer_quote_rounds
    DROP CONSTRAINT IF EXISTS trade_customer_quote_rounds_profit_margin_check;

ALTER TABLE trade_customer_quote_rounds
    ADD CONSTRAINT trade_customer_quote_rounds_profit_margin_check
    CHECK (profit_margin_percent >= 0 AND profit_margin_percent <= 1000);
