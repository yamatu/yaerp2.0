-- 外贸 ERP 扩展：供应商询价、职位交接、质检图片、运输资料和标签打印
CREATE SEQUENCE IF NOT EXISTS trade_supplier_code_seq START WITH 1;

ALTER TABLE trade_orders DROP CONSTRAINT IF EXISTS trade_orders_stage_check;
ALTER TABLE trade_orders
    ADD CONSTRAINT trade_orders_stage_check
    CHECK (stage IN ('inquiry', 'supplier_quote', 'quotation', 'purchase', 'receiving', 'inspection', 'packing', 'shipment', 'completed', 'cancelled'));

ALTER TABLE trade_orders ADD COLUMN IF NOT EXISTS payment_method VARCHAR(200) NOT NULL DEFAULT '';
ALTER TABLE trade_orders ADD COLUMN IF NOT EXISTS label_width_mm NUMERIC(8,2) NOT NULL DEFAULT 100;
ALTER TABLE trade_orders ADD COLUMN IF NOT EXISTS label_height_mm NUMERIC(8,2) NOT NULL DEFAULT 60;
ALTER TABLE trade_orders ADD COLUMN IF NOT EXISTS inspection_gallery_directory_id BIGINT REFERENCES gallery_directories(id) ON DELETE SET NULL;
ALTER TABLE trade_order_items ADD COLUMN IF NOT EXISTS purchase_currency VARCHAR(8) NOT NULL DEFAULT '';
UPDATE trade_orders SET payment_method = payment_terms WHERE payment_method = '' AND payment_terms <> '';

CREATE TABLE IF NOT EXISTS trade_suppliers (
    id                  BIGSERIAL PRIMARY KEY,
    supplier_code       VARCHAR(32) NOT NULL UNIQUE,
    owner_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name                VARCHAR(200) NOT NULL,
    company_name        VARCHAR(240) NOT NULL DEFAULT '',
    contact_name        VARCHAR(160) NOT NULL DEFAULT '',
    phone               VARCHAR(80) NOT NULL DEFAULT '',
    email               VARCHAR(200) NOT NULL DEFAULT '',
    whatsapp            VARCHAR(100) NOT NULL DEFAULT '',
    country             VARCHAR(120) NOT NULL DEFAULT '',
    default_currency    VARCHAR(8) NOT NULL DEFAULT 'USD',
    payment_method      VARCHAR(200) NOT NULL DEFAULT '',
    status              VARCHAR(24) NOT NULL DEFAULT 'active',
    notes               TEXT NOT NULL DEFAULT '',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trade_suppliers_status_check CHECK (status IN ('active', 'inactive', 'blocked'))
);
CREATE INDEX IF NOT EXISTS idx_trade_suppliers_search
    ON trade_suppliers USING GIN (to_tsvector('simple', supplier_code || ' ' || name || ' ' || company_name || ' ' || contact_name || ' ' || phone || ' ' || email));

CREATE TABLE IF NOT EXISTS trade_supplier_quotes (
    id                  BIGSERIAL PRIMARY KEY,
    order_id            BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    order_item_id       BIGINT NOT NULL REFERENCES trade_order_items(id) ON DELETE CASCADE,
    supplier_id         BIGINT REFERENCES trade_suppliers(id) ON DELETE SET NULL,
    sheet_row_index     INTEGER NOT NULL DEFAULT 0,
    currency            VARCHAR(8) NOT NULL DEFAULT 'USD',
    unit_price          NUMERIC(18,4) NOT NULL DEFAULT 0,
    moq                 NUMERIC(18,4) NOT NULL DEFAULT 0,
    lead_time_days      INTEGER NOT NULL DEFAULT 0,
    valid_until         DATE,
    is_selected         BOOLEAN NOT NULL DEFAULT FALSE,
    notes               TEXT NOT NULL DEFAULT '',
    created_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, sheet_row_index)
);
CREATE INDEX IF NOT EXISTS idx_trade_supplier_quotes_order ON trade_supplier_quotes(order_id, order_item_id, id);

CREATE TABLE IF NOT EXISTS trade_order_shipments (
    order_id            BIGINT PRIMARY KEY REFERENCES trade_orders(id) ON DELETE CASCADE,
    booking_no          VARCHAR(160) NOT NULL DEFAULT '',
    carrier             VARCHAR(200) NOT NULL DEFAULT '',
    vessel_flight       VARCHAR(200) NOT NULL DEFAULT '',
    etd                 DATE,
    eta                 DATE,
    bl_no               VARCHAR(160) NOT NULL DEFAULT '',
    shipping_status     VARCHAR(48) NOT NULL DEFAULT '待订舱',
    notes               TEXT NOT NULL DEFAULT '',
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_inspection_photos (
    id                   BIGSERIAL PRIMARY KEY,
    order_id             BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    order_item_id        BIGINT REFERENCES trade_order_items(id) ON DELETE SET NULL,
    attachment_id        BIGINT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    gallery_directory_id BIGINT REFERENCES gallery_directories(id) ON DELETE SET NULL,
    note                 TEXT NOT NULL DEFAULT '',
    uploaded_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, attachment_id)
);
CREATE INDEX IF NOT EXISTS idx_trade_inspection_photos_order ON trade_inspection_photos(order_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_positions (
    id          BIGSERIAL PRIMARY KEY,
    code        VARCHAR(48) NOT NULL UNIQUE,
    name        VARCHAR(100) NOT NULL,
    description VARCHAR(240) NOT NULL DEFAULT '',
    stage       VARCHAR(24) NOT NULL,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    enabled     BOOLEAN NOT NULL DEFAULT TRUE
);

INSERT INTO trade_positions(code, name, description, stage, sort_order) VALUES
    ('sales', '业务员', '录入客户并承接询价', 'inquiry', 10),
    ('sourcing', '供应商询价', '维护供应商并收集采购报价', 'supplier_quote', 20),
    ('quotation', '报价员', '核算并向客户报价', 'quotation', 30),
    ('purchasing', '采购员', '确认供应商并执行采购', 'purchase', 40),
    ('warehouse', '仓库', '登记到货数量和库位', 'receiving', 50),
    ('quality', '质检员', '完成检验并上传质检照片', 'inspection', 60),
    ('packing', '装箱员', '维护装箱信息并打印 SKU 标签', 'packing', 70),
    ('logistics', '物流员', '维护订舱和发货跟踪', 'shipment', 80),
    ('manager', '业务负责人', '监督流程和确认完结', 'completed', 90)
ON CONFLICT(code) DO UPDATE SET
    name = EXCLUDED.name, description = EXCLUDED.description, stage = EXCLUDED.stage,
    sort_order = EXCLUDED.sort_order, enabled = TRUE;

CREATE TABLE IF NOT EXISTS trade_user_positions (
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    position_id BIGINT NOT NULL REFERENCES trade_positions(id) ON DELETE CASCADE,
    assigned_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(user_id, position_id)
);

CREATE TABLE IF NOT EXISTS trade_settings (
    setting_key VARCHAR(80) PRIMARY KEY,
    value       JSONB NOT NULL DEFAULT '[]',
    updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO trade_settings(setting_key, value)
VALUES ('payment_methods', '["T/T 电汇","银行转账","现金","信用证 L/C","PayPal","Western Union","支付宝","微信支付","30% 订金，70% 发货前付清","月结"]'::jsonb)
ON CONFLICT(setting_key) DO NOTHING;
