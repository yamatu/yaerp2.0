-- YaERP 2.0 - per-mailbox proxy override
-- Values: 'global' follows proxy_settings.proxy_mail, 'on' always uses the
-- XTLS core entry point, 'off' never does (direct connection).

ALTER TABLE mail_accounts
    ADD COLUMN IF NOT EXISTS proxy_mode VARCHAR(16) NOT NULL DEFAULT 'global';

ALTER TABLE mail_accounts
    DROP CONSTRAINT IF EXISTS mail_accounts_proxy_mode_check;

ALTER TABLE mail_accounts
    ADD CONSTRAINT mail_accounts_proxy_mode_check
    CHECK (proxy_mode IN ('global', 'on', 'off'));
