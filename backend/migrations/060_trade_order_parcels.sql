-- YaERP 2.0 - an order ships as one or more parcels, each with its own
-- carrier, tracking number and freight, carrying some of the packed boxes.
-- boxes: [{"group_no": 1, "copies": 2}, ...] referring to trade_packing_groups.

CREATE TABLE IF NOT EXISTS trade_order_parcels (
    id                          BIGSERIAL PRIMARY KEY,
    order_id                    BIGINT NOT NULL REFERENCES trade_orders(id) ON DELETE CASCADE,
    parcel_no                   INTEGER NOT NULL,
    carrier                     VARCHAR(64) NOT NULL DEFAULT '',
    tracking_no                 VARCHAR(128) NOT NULL DEFAULT '',
    shipping_status             VARCHAR(32) NOT NULL DEFAULT '未发货',
    ship_date                   DATE,
    actual_freight_currency     VARCHAR(8) NOT NULL DEFAULT 'CNY',
    actual_freight_amount       NUMERIC(18,4) NOT NULL DEFAULT 0,
    actual_freight_to_cny_rate  NUMERIC(18,8) NOT NULL DEFAULT 1,
    boxes                       JSONB NOT NULL DEFAULT '[]'::jsonb,
    notes                       TEXT NOT NULL DEFAULT '',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(order_id, parcel_no)
);

CREATE INDEX IF NOT EXISTS idx_trade_order_parcels_order ON trade_order_parcels(order_id, parcel_no);

-- Existing single shipments become parcel 1 carrying every packed box.
INSERT INTO trade_order_parcels(order_id, parcel_no, carrier, tracking_no, shipping_status, ship_date,
    actual_freight_currency, actual_freight_amount, actual_freight_to_cny_rate, boxes, notes, created_at, updated_at)
SELECT s.order_id, 1, s.carrier, s.booking_no,
       CASE WHEN s.shipping_status IN ('已发货','到了','已离港','运输中','已到港','已签收') THEN '已发货' ELSE '未发货' END,
       s.etd::date, COALESCE(NULLIF(s.actual_freight_currency,''),'CNY'), s.actual_freight_amount,
       COALESCE(NULLIF(s.actual_freight_to_cny_rate,0),1),
       COALESCE((SELECT jsonb_agg(jsonb_build_object('group_no', g.group_no, 'copies', g.copies) ORDER BY g.group_no)
                 FROM trade_packing_groups g WHERE g.order_id = s.order_id), '[]'::jsonb),
       s.notes, s.updated_at, s.updated_at
FROM trade_order_shipments s
WHERE (TRIM(s.carrier) <> '' OR TRIM(s.booking_no) <> '' OR s.actual_freight_amount > 0)
  AND NOT EXISTS (SELECT 1 FROM trade_order_parcels p WHERE p.order_id = s.order_id);
