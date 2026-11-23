-- YaERP 2.0 - customer country/region hold free-form addresses (the PI uses
-- them as the bill-to address), so 120 characters is too short.
-- Guarded so restarts do not take an ACCESS EXCLUSIVE lock once applied.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'trade_customers'
          AND column_name IN ('country', 'region') AND data_type <> 'text'
    ) THEN
        ALTER TABLE trade_customers
            ALTER COLUMN country TYPE TEXT,
            ALTER COLUMN region TYPE TEXT;
    END IF;
END $$;
