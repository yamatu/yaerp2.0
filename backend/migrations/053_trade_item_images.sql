-- 外贸产品图片：询价/报价时上传的货物图片，按订单产品行保存，供产品报价库按 SKU 汇总展示。
CREATE TABLE IF NOT EXISTS trade_item_images (
    id             BIGSERIAL PRIMARY KEY,
    order_id       BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    order_item_id  BIGINT NOT NULL REFERENCES trade_order_items(id) ON DELETE CASCADE,
    attachment_id  BIGINT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    uploaded_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (order_item_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_item_images_order ON trade_item_images(order_id);
CREATE INDEX IF NOT EXISTS idx_trade_inspection_photos_item ON trade_inspection_photos(order_item_id);
CREATE INDEX IF NOT EXISTS idx_trade_quote_rounds_status_time
    ON trade_customer_quote_rounds(status, (COALESCE(sent_at, created_at)) DESC);
