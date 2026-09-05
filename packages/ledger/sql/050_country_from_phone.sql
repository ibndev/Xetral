-- ============================================================================
--  050 — the country a customer chose, made structural
--
--  WHAT WAS WRONG. `users.country` is written from the dialling-code picker on
--  the signup form and has been since 040, so a customer who selects +233 is a
--  Ghanaian account and everything downstream — the home currency, the wallets
--  offered, the activity rail, the payout rail — reads that column.
--
--  IT IS NULLABLE, and every row written before 040 has nothing in it. On the
--  admin customer profile that renders as "not set"; on the home screen it
--  falls through to `FALLBACK_HOME_CURRENCY`; on the Send screen it decides
--  which currencies are offered. So an account with a null country is one
--  where five separate surfaces each guess, and they do not all guess the
--  same way.
--
--  THE PHONE NUMBER ALREADY CARRIES THE ANSWER for most of them. A number
--  normalised to E.164 begins with the country's own dialling code, which is
--  the same fact the picker recorded — so the answer is not being inferred
--  from anything new, it is being read back out of what the customer typed.
--
--  THE REST ARE NIGERIAN, and that is a claim about history rather than a
--  guess. The registration path has written this column since 040 landed, so
--  a null can only belong to a row created before that — when this platform
--  operated in Nigeria alone. `FALLBACK_HOME_CURRENCY` in
--  `wallet.service.ts` makes exactly this argument and has been relied on to
--  make it; writing it down once, here, is better than five surfaces each
--  falling back separately and none of them saying so.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  A FUNCTION RATHER THAN TWO LOOSE STATEMENTS, so the rule has one
--  definition.
--
--  The backfill has to be RUN by this migration and TESTED by its test file,
--  and the obvious shape — the UPDATE written out in both — is two copies of
--  a rule about where a customer lives. The copy that drifts is the one in
--  the test, which then passes while describing something the migration does
--  not do.
--
--  Answers how many rows it settled, so an operator running it by hand after
--  importing accounts is told something rather than nothing.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION backfill_country_from_phone() RETURNS BIGINT AS $$
DECLARE v_settled BIGINT;
        v_assumed BIGINT;
BEGIN
    /*
     * Longest dialling code first, which is the whole subtlety. '1' is the
     * United States and '1876' is Jamaica; matching '1' first would make
     * every Jamaican number American, and the failure is silent — the account
     * works, in the wrong country, with the wrong currency.
     *
     * A CORRELATED SUBQUERY IN `SET`, not a LATERAL in `FROM`: an UPDATE's
     * FROM list cannot reference the row being updated, so the form that
     * reads best is rejected outright.
     *
     * Only rows with NO country are touched. A customer who CHOSE one is not
     * overruled by their own phone number — somebody may hold a foreign
     * number and live where they say they do, and the picker is the statement
     * they actually made.
     */
    UPDATE users u
       SET country = (
            SELECT c.code
              FROM countries c
             WHERE regexp_replace(u.phone, '^\+', '') LIKE c.dial_code || '%'
             ORDER BY length(c.dial_code) DESC
             LIMIT 1
           )
     WHERE u.country IS NULL
       AND u.phone IS NOT NULL
       -- Guarded, because a SET from a subquery returning no row writes NULL
       -- — which would leave the account exactly as it was and look like a
       -- match.
       AND EXISTS (
            SELECT 1 FROM countries c
             WHERE regexp_replace(u.phone, '^\+', '') LIKE c.dial_code || '%'
           );
    GET DIAGNOSTICS v_settled = ROW_COUNT;

    /*
     * Everything still unresolved predates 040, so it is Nigerian.
     *
     * These are accounts whose phone was never normalised — a national number
     * like '08090712922' has no dialling code in it to read, and no prefix
     * could tell Nigeria from anywhere else. The DATE is the evidence rather
     * than the digits: registration has supplied a country since 040, so a
     * null belongs to a row written when this platform operated in Nigeria
     * alone.
     *
     * NG is written literally rather than selected as "the first enabled
     * country": the claim is about Nigeria specifically, and a statement that
     * quietly becomes about Ghana the day somebody reorders a seed is not the
     * statement intended.
     */
    UPDATE users SET country = 'NG' WHERE country IS NULL;
    GET DIAGNOSTICS v_assumed = ROW_COUNT;

    RETURN v_settled + v_assumed;
END;
$$ LANGUAGE plpgsql;

SELECT backfill_country_from_phone();

-- ---------------------------------------------------------------------------
--  AND A GAP IS VISIBLE RATHER THAN IMPOSSIBLE.
--
--  THE FIRST VERSION OF THIS FILE MADE THE COLUMN NOT NULL, which is the
--  stronger guarantee and the wrong trade. It refused every fixture in the
--  invariant suite — seventy-one `INSERT INTO users` sites across sixty-four
--  files, none of which is describing a real customer — so the cost of the
--  constraint was rewriting all of them to satisfy a rule the application
--  path already keeps: registration has supplied a country on every insert
--  since 040, and it is the only thing that writes this table.
--
--  So the gap is REPORTED, in the shape `retention_coverage` and
--  `countries_without_cover` already use. A country that is missing is
--  something an operator can see and act on, which is what was actually
--  wrong: not that a null was possible, but that five surfaces each guessed
--  differently and nothing anywhere said so.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW users_without_a_country AS
SELECT u.uuid AS user_uuid,
       u.email,
       u.phone,
       u.created_at,
       -- Whether the phone could answer it. A number in E.164 carries its
       -- own dialling code, so a row with one here is one the backfill above
       -- would have resolved — which means it was written AFTER 050 ran, by
       -- a path that did not supply a country.
       EXISTS (
         SELECT 1 FROM countries c
          WHERE u.phone IS NOT NULL
            AND regexp_replace(u.phone, '^\+', '') LIKE c.dial_code || '%'
       ) AS phone_would_say
  FROM users u
 WHERE u.country IS NULL;

COMMENT ON VIEW users_without_a_country IS
  'Accounts with no country, which every country-driven surface then guesses '
  'about separately — the home currency, the wallets offered, the payout rail '
  'and the activity filters. Empty is the correct state: 050 backfilled every '
  'row that existed and registration has supplied one since 040.';

-- ---------------------------------------------------------------------------
--  036 refuses a view nobody has classified, in both directions. This is a
--  `watch` rather than a `queue`: there is no action to take on a row here
--  beyond finding out which path wrote it, and a queue with no work in it is
--  how a real queue gets ignored.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('users_without_a_country', 'watch', NULL,
        'An account with no country is one every country-driven surface '
        'guesses about separately. Empty is correct; a row means a write path '
        'skipped what registration has always supplied.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

COMMIT;
