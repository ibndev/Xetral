-- ============================================================================
--  061 — the country a customer is in, and the rail their money moves on,
--        re-asserted
--
--  WHAT WAS WRONG. The Send screen in Accra kept saying "a bank account" and
--  "Account number" after three separate fixes, and every one of those fixes
--  was in the right place. Both apps read `payout_method` off the session,
--  fall back to the public country list, and only then to 'bank'; 046 has set
--  GH and KE to 'mobile_money' since it landed; 050 backfills `users.country`
--  from the E.164 number the customer typed. Reproduced against a fresh
--  database the screen is correct in every particular.
--
--  SO THE CODE WAS NEVER THE THING TO CHANGE. What decides the wording is
--  DATA, and there are exactly three rows that can make a customer in Accra
--  read as Nigerian:
--
--    * `users.country` is NULL, so the session says nothing and both apps
--      fall through to 'NG'. 050 fixes that, and 050 has to have RUN.
--    * `countries.payout_method` for GH or KE is 'bank', which is 046's
--      default and what an operator sees if 046's UPDATE was reverted, or if
--      the row was re-inserted by hand afterwards.
--    * `provider_routes` has no row for GHS or KES, so the checkout and the
--      payout both refuse — 059's seed is `ON CONFLICT DO NOTHING`, which is
--      right, and means a table populated before 059 keeps whatever it had.
--
--  This migration re-asserts all three. Every statement is IDEMPOTENT and
--  none of them overrules a decision somebody made: the backfill touches only
--  rows with no country at all, the route seed still conflicts to nothing, and
--  the only UPDATE is the one 046 already wrote.
--
--  AND IT MAKES THE GAP VISIBLE RATHER THAN GUESSABLE. The reason this took
--  three rounds is that nothing anywhere reported "this customer has no
--  country" — the fallback is silent by construction, and a silent fallback
--  looks exactly like a screen that was never fixed.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  1. The country, from the number they typed.
--
--  050 defines the rule and runs it once. Running it again costs nothing on a
--  database where it already ran — the UPDATE inside is `WHERE country IS
--  NULL` — and settles every account imported, restored or registered against
--  a build that predated it.
--
--  NOT re-derived here. A second copy of "where does this customer live" is
--  the drift 050's own header refuses, so this calls the function.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_settled BIGINT;
BEGIN
    SELECT backfill_country_from_phone() INTO v_settled;
    RAISE NOTICE '061: settled the country on % account(s)', v_settled;
END $$;

-- ---------------------------------------------------------------------------
--  2. How money leaves Ghana and Kenya.
--
--  046 wrote exactly this. It is here again because it is the row the Send
--  screen reads, and a wrong value in it is indistinguishable from an app
--  that was never changed.
--
--  Nigeria is deliberately NOT named. `bank` is both its default and the true
--  answer, so a statement about it would be a statement with no effect that
--  the next reader has to check.
-- ---------------------------------------------------------------------------
UPDATE countries
   SET payout_method = 'mobile_money'
 WHERE code IN ('GH', 'KE')
   AND payout_method IS DISTINCT FROM 'mobile_money';

-- ---------------------------------------------------------------------------
--  3. The rails, for the corridors that have one.
--
--  Same list as 059 plus the dollar collection 060 added, and the same
--  `DO NOTHING`: an operator who has moved a corridor made a decision, and a
--  migration that overwrote it would be a migration that undoes an incident
--  response.
-- ---------------------------------------------------------------------------
INSERT INTO provider_routes (operation, currency, provider)
VALUES
  ('collect', 'NGN', 'paystack'),
  ('collect', 'GHS', 'flutterwave'),
  ('collect', 'KES', 'flutterwave'),
  ('collect', 'USD', 'flutterwave'),
  ('payout',  'NGN', 'paystack'),
  ('payout',  'GHS', 'flutterwave'),
  ('payout',  'KES', 'flutterwave')
ON CONFLICT (operation, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  4. What nothing could say.
--
--  An account with no country is one where the home currency, the wallets
--  offered, the activity rail and the payout rail each fall back separately —
--  and every one of those fallbacks is Nigerian. That is correct for the
--  history it was written for and wrong for anybody who signed up since, and
--  it is INVISIBLE: the screens render, the account works, and the customer
--  is simply shown another country's product.
--
--  So it is counted. `phone_suggests` is what 050 would settle it to, which
--  is the difference between "nothing to do" and "run the backfill" — and
--  NULL there means the number matches no dialling code we hold, which is the
--  only case a person has to look at.
--
--  It carries no email and no name: it is a count and a code, which is all an
--  operator needs to decide whether anything is wrong.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW customers_without_a_country AS
SELECT (SELECT c.code
          FROM countries c
         WHERE regexp_replace(u.phone, '^\+', '') LIKE c.dial_code || '%'
         ORDER BY length(c.dial_code) DESC
         LIMIT 1)                         AS phone_suggests,
       COUNT(*)                           AS customers,
       MIN(u.created_at)                  AS oldest,
       MAX(u.created_at)                  AS newest
  FROM users u
 WHERE u.country IS NULL
 GROUP BY 1;

COMMENT ON VIEW customers_without_a_country IS
  'Accounts with no country, grouped by what their phone number suggests. '
  'A row with a code is one backfill_country_from_phone() will settle; a row '
  'with none holds a number matching no dialling code in `countries`.';

-- ---------------------------------------------------------------------------
--  036 classifies EVERY view, in both directions, and fails the build on one
--  nobody decided about. This is a `watch`: it is a number an operator reads,
--  not a queue with items to work through — the work is one function call,
--  and it is above.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, rationale)
VALUES
  ('customers_without_a_country', 'watch',
   'Accounts falling back to the platform default country. The fallback is '
   'silent by construction and shows the customer another country''s product.')
ON CONFLICT (source) DO NOTHING;

COMMIT;
