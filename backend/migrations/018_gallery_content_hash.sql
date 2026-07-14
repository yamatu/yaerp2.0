-- YaERP 2.0 - Content hashes for gallery image deduplication

ALTER TABLE attachments
    ADD COLUMN IF NOT EXISTS content_hash VARCHAR(64);

CREATE INDEX IF NOT EXISTS idx_attachments_content_hash
    ON attachments(content_hash)
    WHERE content_hash IS NOT NULL AND content_hash <> '';
