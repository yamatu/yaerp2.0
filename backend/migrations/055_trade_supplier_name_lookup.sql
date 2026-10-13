-- Supplier quote entry and import match suppliers by name.
CREATE INDEX IF NOT EXISTS idx_trade_suppliers_lower_name
    ON trade_suppliers (LOWER(TRIM(name)));
CREATE INDEX IF NOT EXISTS idx_trade_suppliers_lower_company
    ON trade_suppliers (LOWER(TRIM(company_name)));
