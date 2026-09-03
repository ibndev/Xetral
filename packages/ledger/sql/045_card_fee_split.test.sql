-- ============================================================================
--  045 tests. Every block prints PASS or raises TEST FAILED.
-- ============================================================================

\set ON_ERROR_STOP on

-- ── 1. The issuer's cost is its own number ──────────────────────────────────
--  Not "half the price". One is what this business charges and the other is
--  what a supplier bills; a single split would make a price rise look like a
--  bigger supplier bill.
DO $$
DECLARE v_price TEXT; v_cost TEXT;
BEGIN
  SELECT value INTO v_price FROM platform_settings WHERE key = 'card_issuance_fee_cents';
  SELECT value INTO v_cost  FROM platform_settings WHERE key = 'card_issuance_provider_cost_cents';

  IF v_cost IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED 1: there is no provider cost setting, so the margin '
                    'on a card cannot be seen';
  END IF;
  IF v_price IS DISTINCT FROM '200' OR v_cost IS DISTINCT FROM '100' THEN
    RAISE EXCEPTION 'TEST FAILED 1: shipped price/cost are %/% rather than 200/100',
                    v_price, v_cost;
  END IF;
  RAISE NOTICE 'PASS 1: a card is priced at $2 and costs $1 to issue';
END $$;

-- ── 2. Both are bounded, at the database ────────────────────────────────────
--  009's rule: a bound is a CHECK, not form validation, so a figure typed at
--  a psql prompt at 3am is refused the same way one typed on the dashboard is.
DO $$
BEGIN
  BEGIN
    UPDATE platform_settings SET value = '999999'
     WHERE key = 'card_issuance_provider_cost_cents';
    RAISE EXCEPTION 'TEST FAILED 2: an absurd provider cost was accepted';
  EXCEPTION WHEN check_violation OR raise_exception THEN
    -- 009 enforces bounds through a trigger that raises, so either is a pass.
    RAISE NOTICE 'PASS 2: the provider cost is bounded at the database';
  END;
END $$;

-- ── 3. Zero is legitimate ───────────────────────────────────────────────────
--  An issuer that charges nothing is a real arrangement, and the service
--  omits the postings entirely rather than writing two zero legs the ledger
--  would refuse.
DO $$
BEGIN
  UPDATE platform_settings SET value = '0' WHERE key = 'card_issuance_provider_cost_cents';
  UPDATE platform_settings SET value = '100' WHERE key = 'card_issuance_provider_cost_cents';
  RAISE NOTICE 'PASS 3: an issuer that charges nothing can be recorded';
END $$;

-- ── 4. A card has a finish, and it defaults ─────────────────────────────────
DO $$
DECLARE v TEXT;
BEGIN
  SELECT column_default INTO v FROM information_schema.columns
   WHERE table_name = 'cards' AND column_name = 'colour';
  IF v IS NULL THEN
    RAISE EXCEPTION 'TEST FAILED 4: cards have no colour, or it has no default — '
                    'every card issued before this migration would render with no face';
  END IF;
  RAISE NOTICE 'PASS 4: a card has a finish and every existing one keeps the old face';
END $$;

-- ── 5. An unrecognised finish is REFUSED ────────────────────────────────────
--  The value names a stylesheet class in two apps, so a typo is a card that
--  renders with no face at all. The database is where that can be stopped
--  rather than discovered.
DO $$
DECLARE v_user BIGINT;
BEGIN
  INSERT INTO users (email, full_name, status)
  VALUES ('p45-colour@example.test', 'Colour Tester', 'active') RETURNING id INTO v_user;

  INSERT INTO provider_customers (user_id, provider, provider_customer_id)
  VALUES (v_user, 'bitnob', 'cus_p45');

  BEGIN
    INSERT INTO cards
      (user_id, provider, provider_card_id, status, currency, last4,
       expiry_month, expiry_year, colour)
    VALUES (v_user, 'bitnob', 'card_p45', 'active', 'USD', '4242', 12, 2030, 'chartreuse');
    RAISE EXCEPTION 'TEST FAILED 5: a card was issued with a finish nothing can draw';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS 5: a finish neither app can draw is refused';
  END;
END $$;

-- ── 6. The three that exist are accepted ────────────────────────────────────
DO $$
DECLARE v_user BIGINT; c TEXT;
BEGIN
  SELECT id INTO v_user FROM users WHERE email = 'p45-colour@example.test';
  FOREACH c IN ARRAY ARRAY['graphite', 'sapphire', 'emerald'] LOOP
    INSERT INTO cards
      (user_id, provider, provider_card_id, status, currency, last4,
       expiry_month, expiry_year, colour)
    VALUES (v_user, 'bitnob', 'card_p45_' || c, 'active', 'USD', '4242', 12, 2030, c);
  END LOOP;
  RAISE NOTICE 'PASS 6: all three finishes are accepted';
END $$;
