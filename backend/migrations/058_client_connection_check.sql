-- YaERP 2.0 - end queries whose client is gone
-- Postgres normally notices a disconnected client only when it next sends it
-- data, so a long statement from a killed backend keeps running and holding
-- locks. With this setting (PostgreSQL 14+) the server checks the connection
-- every 10 seconds while a query runs. Older servers skip it.

DO $$
BEGIN
    EXECUTE format('ALTER DATABASE %I SET client_connection_check_interval = %L', current_database(), '10s');
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'client_connection_check_interval not set: %', SQLERRM;
END
$$;
