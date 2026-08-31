-- YaERP 2.0 - Traceable AI order imports and data-completeness state

ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS source VARCHAR(24) NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS data_status VARCHAR(24) NOT NULL DEFAULT 'ready',
    ADD COLUMN IF NOT EXISTS ai_import_id VARCHAR(64) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS ai_source_text TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS ai_missing_fields JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS ai_import_model VARCHAR(256) NOT NULL DEFAULT '';

ALTER TABLE trade_orders DROP CONSTRAINT IF EXISTS trade_orders_source_check;
ALTER TABLE trade_orders
    ADD CONSTRAINT trade_orders_source_check
    CHECK (source IN ('manual', 'ai_import'));

ALTER TABLE trade_orders DROP CONSTRAINT IF EXISTS trade_orders_data_status_check;
ALTER TABLE trade_orders
    ADD CONSTRAINT trade_orders_data_status_check
    CHECK (data_status IN ('ready', 'incomplete'));

CREATE UNIQUE INDEX IF NOT EXISTS idx_trade_orders_ai_import_id
    ON trade_orders(ai_import_id)
    WHERE ai_import_id <> '';
