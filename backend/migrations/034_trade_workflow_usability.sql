-- 外贸 ERP 操作优化：客户目录、付款凭证、组合装箱、返工和自由标签位置
ALTER TABLE trade_customers
    ADD COLUMN IF NOT EXISTS workbook_folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL;

ALTER TABLE trade_orders
    ADD COLUMN IF NOT EXISTS workspace_folder_id BIGINT REFERENCES folders(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS payment_gallery_directory_id BIGINT REFERENCES gallery_directories(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS label_offset_x_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS label_offset_y_mm NUMERIC(8,2) NOT NULL DEFAULT 10,
    ADD COLUMN IF NOT EXISTS rework_required BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS rework_reason TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS rework_count INTEGER NOT NULL DEFAULT 0;

UPDATE trade_orders o
SET workspace_folder_id = w.folder_id
FROM workbooks w
WHERE o.workbook_id = w.id
  AND o.workspace_folder_id IS NULL
  AND w.folder_id IS NOT NULL;

UPDATE trade_orders
SET label_offset_x_mm = label_margin_left_mm,
    label_offset_y_mm = label_margin_top_mm
WHERE label_offset_x_mm = 10
  AND label_offset_y_mm = 10;

ALTER TABLE trade_customer_quote_rounds
    ADD COLUMN IF NOT EXISTS payment_status VARCHAR(16) NOT NULL DEFAULT 'unpaid',
    ADD COLUMN IF NOT EXISTS payment_currency VARCHAR(8) NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS paid_amount NUMERIC(18,4) NOT NULL DEFAULT 0;

ALTER TABLE trade_customer_quote_rounds
    DROP CONSTRAINT IF EXISTS trade_customer_quote_rounds_payment_status_check;
ALTER TABLE trade_customer_quote_rounds
    ADD CONSTRAINT trade_customer_quote_rounds_payment_status_check
    CHECK (payment_status IN ('unpaid', 'partial', 'paid'));

CREATE TABLE IF NOT EXISTS trade_customer_payment_proofs (
    id                   BIGSERIAL PRIMARY KEY,
    order_id             BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    quote_id             BIGINT NOT NULL REFERENCES trade_customer_quote_rounds(id) ON DELETE CASCADE,
    attachment_id        BIGINT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    gallery_directory_id BIGINT REFERENCES gallery_directories(id) ON DELETE SET NULL,
    note                 TEXT NOT NULL DEFAULT '',
    uploaded_by          BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(quote_id, attachment_id)
);

CREATE INDEX IF NOT EXISTS idx_trade_customer_payment_proofs_order
    ON trade_customer_payment_proofs(order_id, quote_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trade_packing_groups (
    id                    BIGSERIAL PRIMARY KEY,
    order_id              BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    group_no              INTEGER NOT NULL,
    length_cm             NUMERIC(12,2) NOT NULL DEFAULT 0,
    width_cm              NUMERIC(12,2) NOT NULL DEFAULT 0,
    height_cm             NUMERIC(12,2) NOT NULL DEFAULT 0,
    weight_kg             NUMERIC(12,3) NOT NULL DEFAULT 0,
    volumetric_weight_kg  NUMERIC(12,3) NOT NULL DEFAULT 0,
    copies                INTEGER NOT NULL DEFAULT 1,
    items                 JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes                 TEXT NOT NULL DEFAULT '',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, group_no),
    CONSTRAINT trade_packing_groups_copies_check CHECK (copies > 0)
);

CREATE INDEX IF NOT EXISTS idx_trade_packing_groups_order
    ON trade_packing_groups(order_id, group_no, id);

CREATE INDEX IF NOT EXISTS idx_trade_customers_workbook_folder
    ON trade_customers(workbook_folder_id)
    WHERE workbook_folder_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_trade_orders_workspace_folder
    ON trade_orders(workspace_folder_id)
    WHERE workspace_folder_id IS NOT NULL;
