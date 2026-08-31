-- 对客报价运费、人民币核算、实际发货运费和标签纸张排版
ALTER TABLE trade_customer_quote_rounds
    ADD COLUMN IF NOT EXISTS goods_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS exchange_rate_cny NUMERIC(18,8) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS freight_mode VARCHAR(24) NOT NULL DEFAULT 'customer_forwarder',
    ADD COLUMN IF NOT EXISTS freight_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS total_amount_cny NUMERIC(18,4) NOT NULL DEFAULT 0;

UPDATE trade_customer_quote_rounds
SET goods_amount = total_amount
WHERE goods_amount = 0 AND total_amount > 0;

ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS quoted_goods_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS quote_exchange_rate_cny NUMERIC(18,8) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS freight_mode VARCHAR(24) NOT NULL DEFAULT 'customer_forwarder',
    ADD COLUMN IF NOT EXISTS quoted_freight_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS label_paper_size VARCHAR(24) NOT NULL DEFAULT 'A4',
    ADD COLUMN IF NOT EXISTS label_paper_width_mm NUMERIC(8,2) NOT NULL DEFAULT 210,
    ADD COLUMN IF NOT EXISTS label_paper_height_mm NUMERIC(8,2) NOT NULL DEFAULT 297,
    ADD COLUMN IF NOT EXISTS label_orientation VARCHAR(12) NOT NULL DEFAULT 'portrait',
    ADD COLUMN IF NOT EXISTS label_margin_top_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS label_margin_right_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS label_margin_bottom_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS label_margin_left_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS label_gap_x_mm NUMERIC(8,2) NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS label_gap_y_mm NUMERIC(8,2) NOT NULL DEFAULT 3,
    ADD COLUMN IF NOT EXISTS label_content_scale NUMERIC(6,3) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS label_start_slot INTEGER NOT NULL DEFAULT 0;

UPDATE trade_orders
SET quoted_goods_amount = GREATEST(total_amount - quoted_freight_amount, 0)
WHERE quoted_goods_amount = 0 AND total_amount > 0;

ALTER TABLE trade_order_shipments
    ADD COLUMN IF NOT EXISTS actual_freight_currency VARCHAR(8) NOT NULL DEFAULT 'CNY',
    ADD COLUMN IF NOT EXISTS actual_freight_amount NUMERIC(18,4) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS actual_freight_to_cny_rate NUMERIC(18,8) NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS actual_freight_notes TEXT NOT NULL DEFAULT '';
