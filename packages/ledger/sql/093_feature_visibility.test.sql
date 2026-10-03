-- ============================================================================
--  093 invariants — a switched-off service is Coming soon unless somebody
--  chose Hidden, and nothing else can be written
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. Every service ships Coming soon: no deployment changes state by applying 093.
DO $$
BEGIN
  IF (SELECT count(*) FROM platform_settings
       WHERE key IN ('crypto_when_off', 'fx_when_off', 'cards_when_off', 'bills_when_off', 'payouts_when_off')
         AND value = 'coming_soon') <> 5 THEN
    RAISE EXCEPTION 'TEST FAILED: a service does not ship as coming_soon';
  END IF;
  RAISE NOTICE 'PASS 1: all five ship coming_soon';
END $$;

-- 2. Hidden is accepted, and put back.
DO $$
BEGIN
  UPDATE platform_settings SET value = 'hidden' WHERE key = 'crypto_when_off';
  UPDATE platform_settings SET value = 'coming_soon' WHERE key = 'crypto_when_off';
  RAISE NOTICE 'PASS 2: hidden and coming_soon are both writable';
END $$;

-- 3. Anything else is refused, at the table.
DO $$
BEGIN
  BEGIN
    UPDATE platform_settings SET value = 'Hidden' WHERE key = 'cards_when_off';
    RAISE EXCEPTION 'TEST FAILED: a misspelt state was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  BEGIN
    UPDATE platform_settings SET value = 'off' WHERE key = 'bills_when_off';
    RAISE EXCEPTION 'TEST FAILED: an unknown state was accepted';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
  RAISE NOTICE 'PASS 3: only coming_soon and hidden can be written';
END $$;

-- 4. Re-applying 093 is a no-op over a state somebody chose.
DO $$
BEGIN
  UPDATE platform_settings SET value = 'hidden' WHERE key = 'fx_when_off';
  INSERT INTO platform_settings (key, value, value_type, label, description, category, sensitive)
  VALUES ('fx_when_off', 'coming_soon', 'text', 'x', 'x', 'features', TRUE)
  ON CONFLICT (key) DO NOTHING;
  IF (SELECT value FROM platform_settings WHERE key = 'fx_when_off') <> 'hidden' THEN
    RAISE EXCEPTION 'TEST FAILED: re-applying overwrote a chosen state';
  END IF;
  UPDATE platform_settings SET value = 'coming_soon' WHERE key = 'fx_when_off';
  RAISE NOTICE 'PASS 4: re-applying keeps the chosen state';
END $$;
