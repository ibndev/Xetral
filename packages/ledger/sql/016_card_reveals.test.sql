-- ===========================================================================
--  Xetral — card reveal invariant tests
--  packages/ledger/sql/016_card_reveals.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('reveal-owner@example.ng', 'active');
INSERT INTO users (email, status) VALUES ('reveal-stranger@example.ng', 'active');

INSERT INTO cards (user_id, provider, provider_card_id, last4, expiry_month, expiry_year, status)
SELECT id, 'bitnob', 'bnc-reveal-live', '4242', 11, 2030, 'active'
  FROM users WHERE email = 'reveal-owner@example.ng';

INSERT INTO cards (user_id, provider, provider_card_id, last4, expiry_month, expiry_year, status)
SELECT id, 'bitnob', 'bnc-reveal-frozen', '4243', 11, 2030, 'frozen'
  FROM users WHERE email = 'reveal-owner@example.ng';

INSERT INTO cards (user_id, provider, provider_card_id, last4, expiry_month, expiry_year,
                   status, terminated_at)
SELECT id, 'bitnob', 'bnc-reveal-dead', '4244', 11, 2030, 'terminated', now()
  FROM users WHERE email = 'reveal-owner@example.ng';

\echo '=== 1. This table holds no card numbers ==='
-- Structural, not customary. The reveal is a pass-through, and the way to make
-- "never stored" true is for there to be nowhere to store it.
DO $$
DECLARE v_suspect TEXT;
BEGIN
    SELECT string_agg(column_name, ', ') INTO v_suspect
      FROM information_schema.columns
     WHERE table_name = 'card_reveals'
       AND column_name ~* 'pan|number|cvv|cvc|secret|sealed';

    IF v_suspect IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: card_reveals has columns that could hold a PAN: %', v_suspect;
    END IF;
    RAISE NOTICE 'PASS: there is nowhere here to put a card number';
END $$;

\echo ''
\echo '=== 2. Revealing an active card is recorded ==='
DO $$
DECLARE v_user BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reveal-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-live';

    INSERT INTO card_reveals (card_id, user_id, ip_address)
    VALUES (v_card, v_user, '102.89.1.1');
    RAISE NOTICE 'PASS: a reveal leaves a record';
END $$;

\echo ''
\echo '=== 3. A FROZEN card can still be revealed ==='
-- Freezing stops spending, not looking. A customer who froze their card while
-- travelling still has a legitimate reason to read the number off it, and
-- refusing would push them to unfreeze it just to look — which is the opposite
-- of what the freeze was for.
DO $$
DECLARE v_user BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reveal-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-frozen';

    INSERT INTO card_reveals (card_id, user_id) VALUES (v_card, v_user);
    RAISE NOTICE 'PASS: a frozen card is still readable';
END $$;

\echo ''
\echo '=== 4. A TERMINATED card cannot ==='
-- Its number is dead at the provider, so the reveal would either fail or
-- return something that no longer works — and a customer would spend an
-- afternoon trying to use it.
DO $$
DECLARE v_user BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reveal-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-dead';

    INSERT INTO card_reveals (card_id, user_id) VALUES (v_card, v_user);
    RAISE EXCEPTION 'TEST FAILED: a terminated card was revealed';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a terminated card has nothing to reveal';
END $$;

\echo ''
\echo '=== 5. A reveal cannot be attributed to the wrong customer ==='
-- Worse than no record: a record that points an investigation at somebody who
-- did nothing.
DO $$
DECLARE v_stranger BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_stranger FROM users WHERE email = 'reveal-stranger@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-live';

    INSERT INTO card_reveals (card_id, user_id) VALUES (v_card, v_stranger);
    RAISE EXCEPTION 'TEST FAILED: a reveal was recorded against a stranger';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a reveal belongs to the card''s owner';
END $$;

\echo ''
\echo '=== 6. A reveal record cannot be edited ==='
DO $$
BEGIN
    UPDATE card_reveals SET ip_address = '10.0.0.1';
    RAISE EXCEPTION 'TEST FAILED: a reveal record was edited';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a reveal record cannot be rewritten';
END $$;

\echo ''
\echo '=== 7. A reveal record cannot be deleted ==='
-- The one person motivated to remove this row is the one it names.
DO $$
BEGIN
    DELETE FROM card_reveals;
    RAISE EXCEPTION 'TEST FAILED: reveal records were deleted';
EXCEPTION
    WHEN restrict_violation THEN
        RAISE NOTICE 'PASS: a reveal record is permanent';
END $$;

\echo ''
\echo '=== 8. The count in a window is readable, which is what limits it ==='
-- The rate limit reads these rows rather than a counter in memory, because an
-- attacker''s loop outlives a pod restart and an in-process counter does not.
DO $$
DECLARE v_card BIGINT; v_recent BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-live';

    SELECT count(*) INTO v_recent FROM card_reveals
     WHERE card_id = v_card AND revealed_at > now() - interval '1 hour';

    IF v_recent < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected at least one recent reveal, got %', v_recent;
    END IF;
    RAISE NOTICE 'PASS: recent reveals are countable, so they are limitable';
END $$;

\echo ''
\echo '=== 9. The activity view surfaces repeated reveals ==='
-- A legitimate customer reads their number once when they save it somewhere.
-- Repeated reveals are somebody testing a session or copying a number.
DO $$
DECLARE v_user BIGINT; v_card BIGINT; v_reveals BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'reveal-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'bnc-reveal-live';

    INSERT INTO card_reveals (card_id, user_id, ip_address) VALUES (v_card, v_user, '102.89.1.2');
    INSERT INTO card_reveals (card_id, user_id, ip_address) VALUES (v_card, v_user, '102.89.1.3');

    SELECT reveals INTO v_reveals FROM card_reveal_activity
     WHERE card_uuid = (SELECT uuid FROM cards WHERE id = v_card);

    IF v_reveals < 3 THEN
        RAISE EXCEPTION 'TEST FAILED: expected at least 3 reveals in the view, got %', v_reveals;
    END IF;
    RAISE NOTICE 'PASS: the view counts reveals and the addresses they came from';
END $$;

\echo ''
\echo 'card reveals: all blocks passed'
