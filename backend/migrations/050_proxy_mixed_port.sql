-- YaERP 2.0 - configurable mixed (HTTP/SOCKS5) port for the proxy core
-- 0 keeps using the port from MIHOMO_MIXED_ADDR / the default 7890.

ALTER TABLE proxy_settings
    ADD COLUMN IF NOT EXISTS mixed_port INTEGER NOT NULL DEFAULT 0;
