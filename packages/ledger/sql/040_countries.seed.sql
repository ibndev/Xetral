BEGIN;

-- ---------------------------------------------------------------------------
-- 040 seed — the countries Xetral opens with, and the cover their currencies
-- need before any of them can be opened.
--
-- THE LIMITS AND THRESHOLDS COME FIRST, and the ordering is the point rather
-- than tidiness: `countries_enable_needs_coverage` refuses to enable a country
-- whose currency has no ceiling at every tier and nothing watching it, so a
-- seed that inserted the countries first would fail on its own trigger. That
-- is the correct failure and this is the correct order — the same argument 038
-- makes about USDC, where the rows go in before the first account can exist.
--
-- EVERY FIGURE HERE IS A STARTING POINT AN OPERATOR MUST REVIEW, exactly as
-- 027's seed says of `large_value_minor`. The cedi and shilling numbers are
-- the naira ones converted at a round rate and rounded to something legible;
-- they are NOT a compliance position, and the reporting threshold in each
-- country is a regulator's number rather than ours.
-- ---------------------------------------------------------------------------

INSERT INTO kyc_tier_limits (tier, currency, daily_limit_minor) VALUES
  -- ---- GHS, exponent 2 (pesewa) --------------------------------------------
  -- ₵500 unverified, roughly the naira tier-0 ceiling.
  (0, 'GHS', 50000),
  -- ₵50,000 verified.
  (1, 'GHS', 5000000),
  -- ₵250,000 with source of funds established.
  (2, 'GHS', 25000000),

  -- ---- KES, exponent 2 (cent) ----------------------------------------------
  -- KSh 5,000 unverified.
  (0, 'KES', 500000),
  -- KSh 500,000 verified.
  (1, 'KES', 50000000),
  -- KSh 2,500,000 with source of funds established.
  (2, 'KES', 250000000),

  -- ---- USDC, exponent 6 ----------------------------------------------------
  -- 038 added USDC's rows for the ledger; a country naming it would need the
  -- same three, and USDC is deliberately not a country's currency. Listed
  -- here only if 038 has not run — ON CONFLICT makes that safe either way.
  (0, 'USDC', 0)
ON CONFLICT (tier, currency) DO NOTHING;

INSERT INTO risk_thresholds (currency, large_value_minor, notable_minor) VALUES
  -- ₵50,000 and ₵1,000, in pesewas. A STARTING POINT: Ghana's own reporting
  -- threshold is the FIC's number, not this one.
  ('GHS', 5000000, 100000),
  -- KSh 500,000 and KSh 10,000, in cents. Kenya's is the FRC's number.
  ('KES', 50000000, 1000000)
ON CONFLICT (currency) DO NOTHING;

-- ---------------------------------------------------------------------------
-- The countries themselves.
--
-- THREE ARE ENABLED AND THE REST ARE NOT, and that asymmetry is a decision
-- rather than an oversight. Nigeria, Ghana and Kenya are where the platform
-- operates; the others are rows an operator can open in one click once there
-- is a payout rail and somebody has read the local rules. A seed that enabled
-- everything would be a licensing claim written by a migration.
--
-- `created_by` is NULL throughout — nobody authored these — and
-- `countries_without_an_author` says so rather than pretending otherwise.
-- ---------------------------------------------------------------------------
INSERT INTO countries (code, name, dial_code, currency, enabled) VALUES
  ('NG', 'Nigeria',        '234', 'NGN', TRUE),
  ('GH', 'Ghana',          '233', 'GHS', TRUE),
  ('KE', 'Kenya',          '254', 'KES', TRUE),

  -- Present and closed. EVERY CURRENCY NAMED HERE IS ONE THE MONEY REGISTRY
  -- ALREADY HOLDS — there is deliberately no South Africa row, because ZAR is
  -- not in `CURRENCIES` and seeding a country that names a currency the code
  -- cannot represent would be the exact thing this migration exists to
  -- prevent, written by its own seed. Adding South Africa is: ZAR in the
  -- registry, its three ceilings, its threshold, then this row.
  --
  -- The pound and the dollar ARE in the registry and their ceilings are not,
  -- so these two stay closed until somebody sets them — which the enable
  -- trigger enforces rather than trusts.
  ('GB', 'United Kingdom', '44',  'GBP', FALSE),
  ('US', 'United States',  '1',   'USD', FALSE)
ON CONFLICT (code) DO NOTHING;

COMMIT;
