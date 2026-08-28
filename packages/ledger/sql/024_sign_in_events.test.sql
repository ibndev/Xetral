-- ===========================================================================
--  Xetral — sign-in event invariant tests
--  packages/ledger/sql/024_sign_in_events.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p24-a@example.ng', 'active'),
  ('p24-b@example.ng', 'active');

DO $$
DECLARE v_a BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    INSERT INTO sign_in_events (user_id, identifier_hash, ip, country, platform, outcome)
    VALUES (v_a, repeat('a', 64), '102.89.1.1', 'NG', 'android', 'succeeded');
END $$;

\echo '=== 1. A sign-in event cannot be REWRITTEN, at any age ==='
-- The edit this table exists to prevent. A record of where a session was
-- opened from is worth what its immutability is worth: one somebody with
-- access can re-point tells you what that person wanted you to believe.
DO $$
BEGIN
    UPDATE sign_in_events SET ip = '10.0.0.1' WHERE identifier_hash = repeat('a', 64);
    RAISE EXCEPTION 'TEST FAILED: a sign-in event was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a sign-in event cannot be rewritten';
END $$;

\echo '=== 2. A RECENT one cannot be deleted ==='
DO $$
BEGIN
    DELETE FROM sign_in_events WHERE identifier_hash = repeat('a', 64);
    RAISE EXCEPTION 'TEST FAILED: a recent sign-in event was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a recent sign-in event cannot be deleted';
END $$;

\echo '=== 3. One PAST THE RETENTION WINDOW can be, and only that far past ==='
-- The relaxation 019 established for spent TOTP steps, for the same reason:
-- a flat refusal would make the retention sweep fail on a table holding
-- personal data with a bounded life. The boundary is the setting the sweep
-- itself reads, so the two cannot disagree about which rows are still
-- evidence.
DO $$
DECLARE v_days INT; v_a BIGINT; v_old BIGINT; v_recent BIGINT;
BEGIN
    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_sign_in_events_days';
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';

    INSERT INTO sign_in_events (user_id, identifier_hash, ip, outcome, created_at)
    VALUES (v_a, repeat('b', 64), '102.89.1.2', 'succeeded',
            now() - make_interval(days => v_days + 1))
    RETURNING id INTO v_old;

    INSERT INTO sign_in_events (user_id, identifier_hash, ip, outcome, created_at)
    VALUES (v_a, repeat('c', 64), '102.89.1.3', 'succeeded',
            now() - make_interval(days => v_days - 1))
    RETURNING id INTO v_recent;

    DELETE FROM sign_in_events WHERE id = v_old;

    BEGIN
        DELETE FROM sign_in_events WHERE id = v_recent;
        RAISE EXCEPTION 'TEST FAILED: a row inside the window was deleted';
    EXCEPTION WHEN restrict_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS: only rows past the retention window may be deleted';
END $$;

\echo '=== 4. FAMILIARITY is read from successes only ==='
-- Counting the failures would make one guess from an address enough to make
-- that address familiar — which is the exact opposite of what this is for.
DO $$
DECLARE v_b BIGINT; v_ip BOOLEAN; v_country BOOLEAN;
BEGIN
    SELECT id INTO v_b FROM users WHERE email = 'p24-b@example.ng';

    INSERT INTO sign_in_events (user_id, identifier_hash, ip, country, outcome)
    VALUES (v_b, repeat('d', 64), '203.0.113.9', 'RU', 'bad_credentials');

    SELECT ip_seen_before, country_seen_before INTO v_ip, v_country
      FROM sign_in_is_familiar(v_b, '203.0.113.9'::inet, 'RU');

    IF v_ip THEN
        RAISE EXCEPTION 'TEST FAILED: a FAILED sign-in made an address familiar';
    END IF;
    IF v_country THEN
        RAISE EXCEPTION 'TEST FAILED: a FAILED sign-in made a country familiar';
    END IF;

    -- And a success does.
    INSERT INTO sign_in_events (user_id, identifier_hash, ip, country, outcome)
    VALUES (v_b, repeat('d', 64), '203.0.113.9', 'RU', 'succeeded');

    SELECT ip_seen_before, country_seen_before INTO v_ip, v_country
      FROM sign_in_is_familiar(v_b, '203.0.113.9'::inet, 'RU');
    IF NOT v_ip OR NOT v_country THEN
        RAISE EXCEPTION 'TEST FAILED: a successful sign-in did not make the place familiar';
    END IF;

    RAISE NOTICE 'PASS: only a successful sign-in makes a place familiar';
END $$;

\echo '=== 5. FAMILIARITY IS PER ACCOUNT ==='
-- One customer signing in from Lagos must not make Lagos familiar to a
-- different customer's account. A shared answer would silence the alert for
-- every account behind any address anyone has ever used.
DO $$
DECLARE v_a BIGINT; v_ip BOOLEAN;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    SELECT ip_seen_before INTO v_ip FROM sign_in_is_familiar(v_a, '203.0.113.9'::inet, 'NG');
    IF v_ip THEN
        RAISE EXCEPTION 'TEST FAILED: another account made this address familiar';
    END IF;
    RAISE NOTICE 'PASS: familiarity is a fact about one account';
END $$;

\echo '=== 6. An UNKNOWN place counts as familiar ==='
-- A missing address must not be able to manufacture a security alert on every
-- sign-in from a client we simply cannot place. An alert that fires always is
-- an alert nobody reads.
DO $$
DECLARE v_a BIGINT; v_ip BOOLEAN; v_country BOOLEAN;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    SELECT ip_seen_before, country_seen_before INTO v_ip, v_country
      FROM sign_in_is_familiar(v_a, NULL, NULL);
    IF NOT v_ip OR NOT v_country THEN
        RAISE EXCEPTION 'TEST FAILED: an unknown place read as unfamiliar';
    END IF;
    RAISE NOTICE 'PASS: an unplaceable sign-in raises nothing';
END $$;

\echo '=== 7. CREDENTIAL STUFFING is counted on distinct identifiers ==='
-- Not on attempts. The login limiter already caps attempts per identifier,
-- which is exactly what makes an attacker spread ACROSS identifiers — so the
-- spread is the thing worth counting, and one address hammering one account
-- is a different problem the limiter already has.
DO $$
DECLARE v_row RECORD; i INT;
BEGIN
    -- One address, one identifier, many attempts: the limiter's problem.
    FOR i IN 1..40 LOOP
        INSERT INTO sign_in_events (identifier_hash, ip, outcome)
        VALUES (repeat('e', 64), '198.51.100.7', 'bad_credentials');
    END LOOP;

    SELECT * INTO v_row FROM credential_stuffing_sources WHERE ip = '198.51.100.7';
    IF FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: 40 attempts on ONE identifier read as stuffing';
    END IF;

    -- One address, six identifiers, one attempt each: the spread.
    FOR i IN 1..6 LOOP
        INSERT INTO sign_in_events (identifier_hash, ip, outcome)
        VALUES (lpad(i::text, 64, '0'), '198.51.100.8', 'unknown_identifier');
    END LOOP;

    SELECT * INTO v_row FROM credential_stuffing_sources WHERE ip = '198.51.100.8';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: six identifiers from one address was not reported';
    END IF;
    IF v_row.identifiers_tried <> 6 THEN
        RAISE EXCEPTION 'TEST FAILED: identifiers_tried was %', v_row.identifiers_tried;
    END IF;

    RAISE NOTICE 'PASS: stuffing is a spread across identifiers, not a burst at one';
END $$;

\echo '=== 8. Accounts sharing an address are REPORTED, never acted on ==='
-- A Nigerian carrier puts whole subscriber pools behind a handful of
-- addresses — the same fact that made the request limiter count per customer
-- rather than per address. So this is a lead for a reviewer who already has a
-- reason to look, and the view returns the accounts rather than a verdict.
DO $$
DECLARE v_a BIGINT; v_b BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    SELECT id INTO v_b FROM users WHERE email = 'p24-b@example.ng';

    INSERT INTO sign_in_events (user_id, identifier_hash, ip, outcome) VALUES
      (v_a, repeat('f', 64), '105.112.5.5', 'succeeded'),
      (v_b, repeat('f', 64), '105.112.5.5', 'succeeded');

    SELECT * INTO v_row FROM accounts_sharing_an_address WHERE ip = '105.112.5.5';
    IF NOT FOUND OR v_row.accounts <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: two accounts on one address were not reported';
    END IF;
    IF NOT (v_a = ANY(v_row.user_ids) AND v_b = ANY(v_row.user_ids)) THEN
        RAISE EXCEPTION 'TEST FAILED: the view does not name both accounts';
    END IF;
    RAISE NOTICE 'PASS: shared addresses are reported with the accounts named';
END $$;

\echo '=== 9. Accounts sharing a DEVICE are reported ==='
-- A much stronger claim than a shared address: one handset enrolled on
-- several accounts. Still reported rather than refused — a family sharing a
-- phone is real — but this is what a mule farm looks like.
DO $$
DECLARE v_a BIGINT; v_b BIGINT; v_row RECORD; v_fp TEXT := repeat('9', 64);
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    SELECT id INTO v_b FROM users WHERE email = 'p24-b@example.ng';

    INSERT INTO devices (user_id, fingerprint_hash, platform) VALUES
      (v_a, v_fp, 'android'), (v_b, v_fp, 'android');

    SELECT * INTO v_row FROM accounts_sharing_a_device WHERE fingerprint_hash = v_fp;
    IF NOT FOUND OR v_row.accounts <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: one device on two accounts was not reported';
    END IF;
    RAISE NOTICE 'PASS: one device on several accounts is reported';
END $$;

\echo '=== 10. A COUNTRY that is not a country code cannot be stored ==='
-- The value arrives in a request header. A request that did not reach us
-- through the edge carries whatever its sender typed, and this is where that
-- stops being storable.
DO $$
DECLARE v_a BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'p24-a@example.ng';
    INSERT INTO sign_in_events (user_id, identifier_hash, country, outcome)
    VALUES (v_a, repeat('7', 64), 'Nigeria', 'succeeded');
    RAISE EXCEPTION 'TEST FAILED: an arbitrary string was stored as a country';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a two-character country code can be stored';
END $$;

\echo '=== 11. The IDENTIFIER is stored as a HASH, never in the clear ==='
-- A failed sign-in against an address that matched no account is somebody
-- else's email, put here by whoever guessed it. In the clear, this table would
-- be a list of the addresses currently under attack.
DO $$
BEGIN
    INSERT INTO sign_in_events (identifier_hash, outcome)
    VALUES ('victim@example.ng', 'unknown_identifier');
    RAISE EXCEPTION 'TEST FAILED: a raw identifier was stored';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only a hashed identifier can reach a row';
END $$;
