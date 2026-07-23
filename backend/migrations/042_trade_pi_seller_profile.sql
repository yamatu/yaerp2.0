-- Persist seller identity overrides per customer quote round so each PI can
-- retain the exact company/contact details used when it was issued.

ALTER TABLE trade_customer_quote_rounds
    ADD COLUMN IF NOT EXISTS pi_seller_profile JSONB NOT NULL DEFAULT '{}'::jsonb;
