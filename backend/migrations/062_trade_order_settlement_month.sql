-- YaERP 2.0 - orders are counted per monthly settlement cycle (账期).
-- deal_date: the day the customer confirmed the contract (合同日期).
-- settlement_month: YYYY-MM cycle the order belongs to; derived from the deal
-- date and the cycle start day, and editable per order.
-- import_key: identifies a row imported from a monthly order workbook so the
-- same sheet can be imported again without duplicating orders.

ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS deal_date DATE,
    ADD COLUMN IF NOT EXISTS settlement_month VARCHAR(7) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS shipping_address TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS import_key VARCHAR(200) NOT NULL DEFAULT '';

UPDATE trade_orders
SET deal_date = inquiry_date
WHERE deal_date IS NULL
  AND stage NOT IN ('inquiry', 'supplier_quote', 'quotation');

UPDATE trade_orders
SET settlement_month = to_char(COALESCE(deal_date, inquiry_date), 'YYYY-MM')
WHERE settlement_month = '';

CREATE INDEX IF NOT EXISTS idx_trade_orders_settlement_month
    ON trade_orders (settlement_month, updated_at DESC)
    WHERE deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_orders_import_key
    ON trade_orders (import_key)
    WHERE import_key <> '' AND deleted_at IS NULL;
