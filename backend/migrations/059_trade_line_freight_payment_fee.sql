-- YaERP 2.0 - freight per product line and the payment fee charged to the
-- customer (PayPal and similar). Both are part of what the customer pays.

ALTER TABLE trade_order_items
    ADD COLUMN IF NOT EXISTS freight_amount NUMERIC(18,4) NOT NULL DEFAULT 0;

ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS payment_fee_amount NUMERIC(18,4) NOT NULL DEFAULT 0;
