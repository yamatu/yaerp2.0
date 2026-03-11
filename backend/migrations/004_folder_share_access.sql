-- YaERP 2.0 - Folder share access levels

ALTER TABLE folder_shares
    ADD COLUMN IF NOT EXISTS access_level VARCHAR(16) NOT NULL DEFAULT 'view';

UPDATE folder_shares
SET access_level = 'view'
WHERE access_level IS NULL OR access_level = '';
