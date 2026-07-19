-- Persist stage-specific worksheet fields that do not belong to the core item columns.
ALTER TABLE trade_order_items
    ADD COLUMN IF NOT EXISTS workflow_data JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_trade_order_items_workflow_data
    ON trade_order_items USING GIN (workflow_data);
