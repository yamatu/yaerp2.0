-- YaERP 2.0 - Durable, resumable AI order imports

ALTER TABLE trade_orders DROP CONSTRAINT IF EXISTS trade_orders_data_status_check;
ALTER TABLE trade_orders
    ADD CONSTRAINT trade_orders_data_status_check
    CHECK (data_status IN ('ready', 'incomplete', 'importing'));
