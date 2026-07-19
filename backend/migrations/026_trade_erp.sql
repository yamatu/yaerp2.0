-- 外贸业务 ERP：客户、询价/订单、产品明细和流程时间线
CREATE SEQUENCE IF NOT EXISTS trade_customer_code_seq START WITH 1;
CREATE SEQUENCE IF NOT EXISTS trade_order_number_seq START WITH 1;

CREATE TABLE IF NOT EXISTS trade_customers (
    id                      BIGSERIAL PRIMARY KEY,
    customer_code           VARCHAR(32) NOT NULL UNIQUE,
    owner_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name                    VARCHAR(200) NOT NULL,
    company_name            VARCHAR(240) NOT NULL DEFAULT '',
    country                 VARCHAR(120) NOT NULL DEFAULT '',
    region                  VARCHAR(120) NOT NULL DEFAULT '',
    contact_name            VARCHAR(160) NOT NULL DEFAULT '',
    email                   VARCHAR(200) NOT NULL DEFAULT '',
    phone                   VARCHAR(80) NOT NULL DEFAULT '',
    source                  VARCHAR(32) NOT NULL DEFAULT 'manual',
    status                  VARCHAR(24) NOT NULL DEFAULT 'lead',
    customer_level          VARCHAR(8) NOT NULL DEFAULT 'B',
    whatsapp_account_id     BIGINT,
    whatsapp_chat_id        VARCHAR(200),
    whatsapp_chat_name      VARCHAR(240) NOT NULL DEFAULT '',
    avatar_url              TEXT NOT NULL DEFAULT '',
    channel_id              BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    tags                    JSONB NOT NULL DEFAULT '[]',
    notes                   TEXT NOT NULL DEFAULT '',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trade_customers_source_check CHECK (source IN ('manual', 'whatsapp', 'email', 'website', 'exhibition', 'referral', 'marketplace', 'other')),
    CONSTRAINT trade_customers_status_check CHECK (status IN ('lead', 'active', 'inactive', 'blocked')),
    CONSTRAINT trade_customers_level_check CHECK (customer_level IN ('A', 'B', 'C'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_customers_owner_whatsapp_chat
    ON trade_customers (owner_id, whatsapp_chat_id)
    WHERE whatsapp_chat_id IS NOT NULL AND whatsapp_chat_id <> '';
CREATE INDEX IF NOT EXISTS idx_trade_customers_owner_updated
    ON trade_customers (owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_customers_search
    ON trade_customers USING GIN (to_tsvector('simple', name || ' ' || company_name || ' ' || contact_name || ' ' || email || ' ' || phone));

CREATE TABLE IF NOT EXISTS trade_orders (
    id                      BIGSERIAL PRIMARY KEY,
    order_no                VARCHAR(40) NOT NULL UNIQUE,
    customer_id             BIGINT NOT NULL REFERENCES trade_customers(id) ON DELETE RESTRICT,
    owner_id                BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title                   VARCHAR(240) NOT NULL,
    stage                   VARCHAR(24) NOT NULL DEFAULT 'inquiry',
    priority                VARCHAR(16) NOT NULL DEFAULT 'normal',
    inquiry_date            DATE NOT NULL DEFAULT CURRENT_DATE,
    quote_deadline          DATE,
    expected_ship_date      DATE,
    currency                VARCHAR(8) NOT NULL DEFAULT 'USD',
    incoterm                VARCHAR(16) NOT NULL DEFAULT 'FOB',
    destination_country     VARCHAR(120) NOT NULL DEFAULT '',
    destination_port        VARCHAR(160) NOT NULL DEFAULT '',
    payment_terms           VARCHAR(200) NOT NULL DEFAULT '',
    total_amount            NUMERIC(18, 4) NOT NULL DEFAULT 0,
    workbook_id             BIGINT REFERENCES workbooks(id) ON DELETE SET NULL,
    channel_id              BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    notes                   TEXT NOT NULL DEFAULT '',
    stage_updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trade_orders_stage_check CHECK (stage IN ('inquiry', 'quotation', 'purchase', 'receiving', 'inspection', 'packing', 'shipment', 'completed', 'cancelled')),
    CONSTRAINT trade_orders_priority_check CHECK (priority IN ('low', 'normal', 'high', 'urgent'))
);

CREATE INDEX IF NOT EXISTS idx_trade_orders_owner_stage
    ON trade_orders (owner_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_orders_customer
    ON trade_orders (customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trade_orders_deadline
    ON trade_orders (quote_deadline)
    WHERE stage IN ('inquiry', 'quotation');

CREATE TABLE IF NOT EXISTS trade_order_items (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    line_no                 INTEGER NOT NULL,
    sku                     VARCHAR(120) NOT NULL DEFAULT '',
    product_name            VARCHAR(240) NOT NULL,
    description             TEXT NOT NULL DEFAULT '',
    specification           TEXT NOT NULL DEFAULT '',
    quantity                NUMERIC(18, 4) NOT NULL DEFAULT 0,
    unit                    VARCHAR(40) NOT NULL DEFAULT '件',
    target_price            NUMERIC(18, 4) NOT NULL DEFAULT 0,
    quoted_price            NUMERIC(18, 4) NOT NULL DEFAULT 0,
    supplier_name           VARCHAR(240) NOT NULL DEFAULT '',
    purchase_price          NUMERIC(18, 4) NOT NULL DEFAULT 0,
    received_quantity       NUMERIC(18, 4) NOT NULL DEFAULT 0,
    accepted_quantity       NUMERIC(18, 4) NOT NULL DEFAULT 0,
    packed_quantity         NUMERIC(18, 4) NOT NULL DEFAULT 0,
    carton_count            INTEGER NOT NULL DEFAULT 0,
    hs_code                 VARCHAR(80) NOT NULL DEFAULT '',
    gross_weight            NUMERIC(18, 4) NOT NULL DEFAULT 0,
    net_weight              NUMERIC(18, 4) NOT NULL DEFAULT 0,
    status                  VARCHAR(32) NOT NULL DEFAULT 'pending',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_trade_order_items_order
    ON trade_order_items (order_id, line_no);

CREATE TABLE IF NOT EXISTS trade_order_stage_events (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    from_stage              VARCHAR(24) NOT NULL DEFAULT '',
    to_stage                VARCHAR(24) NOT NULL,
    actor_id                BIGINT REFERENCES users(id) ON DELETE SET NULL,
    note                    TEXT NOT NULL DEFAULT '',
    snapshot                JSONB NOT NULL DEFAULT '{}',
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_order_stage_events_order
    ON trade_order_stage_events (order_id, created_at, id);
