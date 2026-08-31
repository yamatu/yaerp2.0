-- Order-level costs used by profitability summaries and the management dashboard.
ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS additional_cost_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS additional_cost_notes TEXT NOT NULL DEFAULT '';
