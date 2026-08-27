-- ============================================================================
--  021 — Velocity limits for the flows that still lacked them.
--
--  WHAT WAS MISSING, AND WHY IT IS THE GAP IT IS. Transfers, purchases and
--  cards each have a ceiling. Crypto withdrawals, FX and gift cards had none —
--  and a crypto withdrawal is the single most consequential thing a stolen
--  session can do here, because once it is on a chain it cannot be recalled by
--  anybody. The one flow with no limit was the one flow with no undo.
--
--  TWO KINDS OF LIMIT, AND THE DIFFERENCE IS THE UNIT.
--
--  A COUNT carries no units, so it applies in every currency and needs no
--  per-asset thought: how many withdrawals in an hour, how many conversions.
--  This is the control that catches a drain, and it is the one that could have
--  existed for these flows all along.
--
--  An AMOUNT does carry units. The existing daily ceilings are published in
--  KOBO and are therefore statements about naira and nothing else — applying a
--  kobo number to USDT because both are integers is the same mistake as adding
--  kobo to cents. So a crypto ceiling is stated PER ASSET, in that asset's own
--  minor units, and an asset with no row has no ceiling. That absence is
--  deliberate and visible rather than a silent zero: a limit nobody configured
--  must not refuse every withdrawal, and must not pretend to cap one either.
-- ============================================================================

BEGIN;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  -- ---- counts: every currency, every asset ------------------------------
  ('crypto_withdrawal_count_hourly', '3', 'integer', 1, 100,
   'Crypto withdrawals per customer per hour',
   'A count, so it applies to every asset. Deliberately the tightest velocity '
   'limit in the platform: a crypto withdrawal is the only money movement here '
   'that cannot be recalled by anybody once it is on a chain.',
   'limits', TRUE),

  ('fx_count_hourly', '10', 'integer', 1, 200,
   'Currency conversions per customer per hour',
   'A count, so it applies to every pair. Catches a script walking a balance '
   'through conversions to obscure where it went.',
   'limits', TRUE),

  ('giftcard_count_hourly', '5', 'integer', 1, 100,
   'Gift card submissions per customer per hour',
   'Every payout is approved by a human, so this is not the control that stops '
   'fraud — it is the one that stops a flood arriving faster than the reviewers '
   'can read it.',
   'limits', TRUE),

  -- ---- amounts: naira only, for the flows denominated in it -------------
  ('fx_daily_limit_kobo', '500000000', 'integer', 100000, 10000000000,
   'Daily conversion limit per customer (kobo)',
   'Applies to the NAIRA side of a conversion only, like every other kobo '
   'ceiling here. A conversion out of another currency is capped by that '
   'currency''s own rules, and by the count above.',
   'limits', TRUE),

  ('giftcard_daily_limit_kobo', '200000000', 'integer', 100000, 10000000000,
   'Daily gift card payout per customer (kobo)',
   'What one customer may be paid for gift cards in a Lagos day. The hold '
   'period and human approval are the real controls; this caps the exposure '
   'while both are still pending.',
   'limits', TRUE),

  -- ---- amounts: per crypto asset, in that asset''s own minor units -------
  --
  -- Named by asset because there is no such thing as a currency-agnostic
  -- amount. USDT has six decimals and BTC has eight, so 1000000 means one
  -- USDT and 0.01 BTC — which is exactly why one shared number would be a bug
  -- rather than a simplification.
  ('crypto_daily_limit_usdt_minor', '5000000000', 'integer', 1000000, 100000000000,
   'Daily USDT withdrawal per customer (micro-USDT)',
   'USDT has SIX decimals: 5,000,000,000 is 5,000 USDT. An asset with no row '
   'here has no amount ceiling and is capped only by the hourly count.',
   'limits', TRUE),

  ('crypto_daily_limit_btc_minor', '10000000', 'integer', 10000, 100000000000,
   'Daily BTC withdrawal per customer (satoshi)',
   'BTC has EIGHT decimals: 10,000,000 is 0.1 BTC.',
   'limits', TRUE)
ON CONFLICT (key) DO NOTHING;

COMMIT;
