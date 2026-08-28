-- ===========================================================================
--  Xetral — card lifecycle invariants
--  packages/ledger/sql/030_card_lifecycle.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p30-owner@example.ng',  'active'),
  ('p30-other@example.ng',  'active'),
  ('p30-staff@example.ng',  'active');

DO $$
DECLARE v_o BIGINT; v_x BIGINT;
BEGIN
    SELECT id INTO v_o FROM users WHERE email = 'p30-owner@example.ng';
    SELECT id INTO v_x FROM users WHERE email = 'p30-other@example.ng';

    INSERT INTO cards (user_id, provider_card_id, last4, status)
    VALUES (v_o, 'p30-card-a', '4242', 'active'),
           (v_x, 'p30-card-z', '9999', 'active');
END $$;

\echo '=== 1. ISSUING a card starts its history ==='
-- A card arrives at 'pending' rather than moving to it, so no status trigger
-- sees the beginning. Recorded on INSERT for the same reason every transition
-- is recorded: a history has to start somewhere.
DO $$
DECLARE v_card BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';
    SELECT * INTO v_row FROM card_events WHERE card_id = v_card AND kind = 'issued';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: issuing a card recorded no event';
    END IF;
    IF v_row.actor <> 'system' OR v_row.actor_id IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the issue event claims a human did it';
    END IF;
    RAISE NOTICE 'PASS: a card history begins when the card does';
END $$;

\echo '=== 2. EVERY status change is recorded, by trigger ==='
-- By trigger and not by the service, so no path can change a status without
-- the change being recorded — including a psql prompt, which is exactly what
-- this block is.
DO $$
DECLARE v_card BIGINT; v_kinds TEXT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';

    UPDATE cards SET status = 'frozen' WHERE id = v_card;
    UPDATE cards SET status = 'active' WHERE id = v_card;
    UPDATE cards SET status = 'frozen' WHERE id = v_card;

    SELECT string_agg(kind::text, ',' ORDER BY id) INTO v_kinds
      FROM card_events WHERE card_id = v_card;

    IF v_kinds <> 'issued,frozen,unfrozen,frozen' THEN
        RAISE EXCEPTION 'TEST FAILED: the history reads %', v_kinds;
    END IF;
    RAISE NOTICE 'PASS: freeze, unfreeze and freeze again are three events, in order';
END $$;

\echo '=== 3. Returning to ACTIVE from FROZEN is an unfreeze, not an activation ==='
-- Two different facts. "The card became usable for the first time" and
-- "somebody lifted a freeze" are the same status and different events, and a
-- dispute turns on which one happened.
DO $$
DECLARE v_card BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';
    SELECT count(*) INTO v_n FROM card_events
     WHERE card_id = v_card AND kind = 'unfrozen';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected one unfreeze, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: lifting a freeze is not the same event as activating';
END $$;

\echo '=== 4. A STAFF action must say WHY ==='
-- A support agent freezing somebody's card without a reason is the action a
-- customer will ask about and nobody can explain.
DO $$
DECLARE v_card BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_card  FROM cards WHERE provider_card_id = 'p30-card-a';
    SELECT id INTO v_staff FROM users WHERE email = 'p30-staff@example.ng';

    INSERT INTO card_events (card_id, kind, actor, actor_id)
    VALUES (v_card, 'frozen', 'staff', v_staff);
    RAISE EXCEPTION 'TEST FAILED: a staff action was recorded with no reason';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: staff say why';
END $$;

\echo '=== 5. A HUMAN actor must be named, and SYSTEM must not be ==='
DO $$
DECLARE v_card BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_card  FROM cards WHERE provider_card_id = 'p30-card-a';
    SELECT id INTO v_staff FROM users WHERE email = 'p30-staff@example.ng';

    BEGIN
        INSERT INTO card_events (card_id, kind, actor, reason)
        VALUES (v_card, 'frozen', 'staff', 'suspected compromise');
        RAISE EXCEPTION 'TEST FAILED: a staff event named nobody';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO card_events (card_id, kind, actor, actor_id)
        VALUES (v_card, 'frozen', 'system', v_staff);
        RAISE EXCEPTION 'TEST FAILED: a system event named a person';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    RAISE NOTICE 'PASS: a human action names its human and an automatic one does not';
END $$;

\echo '=== 6. The history is APPEND-ONLY ==='
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';
    DELETE FROM card_events WHERE card_id = v_card;
    RAISE EXCEPTION 'TEST FAILED: a card event was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: who froze a card cannot be removed from the record';
END $$;

\echo '=== 7. A replacement cannot be issued for a LIVE card ==='
-- Otherwise a customer holds two live cards, one described as the successor
-- of the other — which leaves the leaked number spendable while the record
-- says it was replaced.
DO $$
DECLARE v_o BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_o    FROM users WHERE email = 'p30-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';

    INSERT INTO cards (user_id, provider_card_id, last4, status, replaces_card_id)
    VALUES (v_o, 'p30-card-b', '5555', 'active', v_card);
    RAISE EXCEPTION 'TEST FAILED: a live card was replaced while still live';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: terminate a card before replacing it';
END $$;

\echo '=== 8. A replacement must belong to the SAME customer ==='
-- Without this a mistyped id makes one customer's new card the stated
-- continuation of another customer's, and the balance that moved between them
-- reads as a transfer nobody made.
-- Terminated in a block of its OWN, which does not raise.
--
-- A PL/pgSQL EXCEPTION handler rolls back everything its block did, so a
-- termination performed in the same block as a deliberate failure is a
-- termination that never happened — and the next block then fails on a card it
-- believes is dead. That is the trap `028_risk_cases.test.sql` records, met
-- again here.
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';
    UPDATE cards SET status = 'terminated', terminated_at = now() WHERE id = v_card;
END $$;

DO $$
DECLARE v_x BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';
    SELECT id INTO v_x FROM users WHERE email = 'p30-other@example.ng';
    INSERT INTO cards (user_id, provider_card_id, last4, status, replaces_card_id)
    VALUES (v_x, 'p30-card-c', '6666', 'active', v_card);
    RAISE EXCEPTION 'TEST FAILED: a card replaced another customer''s card';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a replacement stays within one customer';
END $$;

\echo '=== 9. A terminated card CAN be replaced, once ==='
DO $$
DECLARE v_o BIGINT; v_card BIGINT;
BEGIN
    SELECT id INTO v_o    FROM users WHERE email = 'p30-owner@example.ng';
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-a';

    INSERT INTO cards (user_id, provider_card_id, last4, status, replaces_card_id)
    VALUES (v_o, 'p30-card-b', '5555', 'active', v_card);

    BEGIN
        INSERT INTO cards (user_id, provider_card_id, last4, status, replaces_card_id)
        VALUES (v_o, 'p30-card-c', '6666', 'active', v_card);
        RAISE EXCEPTION 'TEST FAILED: two cards both replaced the same card';
    EXCEPTION WHEN unique_violation THEN NULL;
    END;

    RAISE NOTICE 'PASS: a card is replaced once, so the chain reads in both directions';
END $$;

\echo '=== 10. A card cannot replace ITSELF ==='
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p30-card-b';
    UPDATE cards SET replaces_card_id = v_card WHERE id = v_card;
    RAISE EXCEPTION 'TEST FAILED: a card replaced itself';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a card cannot be its own predecessor';
END $$;

\echo '=== 11. The history view LINKS the pair, and carries no PAN ==='
DO $$
DECLARE v_row RECORD; v_col TEXT;
BEGIN
    SELECT * INTO v_row FROM card_history WHERE last4 = '5555';
    IF v_row.replaces_card_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the replacement does not name what it replaced';
    END IF;

    SELECT * INTO v_row FROM card_history WHERE last4 = '4242';
    IF v_row.replaced_by_card_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the old card does not name its replacement';
    END IF;

    FOR v_col IN
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'card_history'
    LOOP
        IF v_col ILIKE '%pan%' OR v_col ILIKE '%number%' OR v_col ILIKE '%cvv%' THEN
            RAISE EXCEPTION 'TEST FAILED: the support view exposes %', v_col;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: the pair reads in both directions, with four digits and no more';
END $$;
