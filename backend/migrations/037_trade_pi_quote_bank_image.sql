-- Allow each customer quote round to keep its own PI bank/payment information image.
ALTER TABLE trade_customer_quote_rounds
    ADD COLUMN IF NOT EXISTS pi_bank_details_image_attachment_id BIGINT
        REFERENCES attachments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_trade_customer_quote_rounds_pi_bank_image
    ON trade_customer_quote_rounds(pi_bank_details_image_attachment_id)
    WHERE pi_bank_details_image_attachment_id IS NOT NULL;
