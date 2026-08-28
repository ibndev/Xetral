-- ============================================================================
--  027 seed — what counts as notable, per currency.
--
--  `large_value_minor` MUST BE REVIEWED BY THE OPERATOR. The figures below are
--  a starting point and not legal advice: the reporting threshold is set by
--  the NFIU and changes, and a monitoring programme running on a number
--  somebody copied from a migration two years ago is a finding.
--
--  A currency with no row here is NOT MONITORED, and `risk_currency_coverage`
--  reports it — which is why every currency the ledger can hold gets one,
--  including the ones that see little traffic. An unmonitored currency is
--  where money goes when somebody notices the gap.
-- ============================================================================

BEGIN;

INSERT INTO risk_thresholds (currency, large_value_minor, notable_minor) VALUES
  -- ₦5,000,000 and ₦100,000, in kobo.
  ('NGN', 500000000, 10000000),
  -- $10,000 and $500, in cents.
  ('USD', 1000000, 50000),
  -- USDT is 6 decimals, not 2. A figure copied from the USD row would be off
  -- by ten thousand — which is the whole reason exponents are per currency.
  ('USDT', 10000000000, 500000000),
  -- BTC is 8. 0.25 BTC and 0.01 BTC.
  ('BTC', 25000000, 1000000)
ON CONFLICT (currency) DO NOTHING;

COMMIT;
