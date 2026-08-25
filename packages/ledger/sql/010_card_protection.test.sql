-- ===========================================================================
--  Xetral — card protection invariant tests
--  packages/ledger/sql/010_card_protection.test.sql
--
--  NOT idempotent. Run against a freshly created database, in migration order.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('cp-customer@example.ng', 'active');

-- A card, and the accounts a card spend touches. `provider_float` is a
-- PLATFORM account with one row per currency for the whole database, so it is
-- resolved-or-created rather than inserted — the same collision the card
-- suite hit in CI once the ledger suite had already made it.
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cp-customer@example.ng';

    INSERT INTO provider_customers (user_id, provider, provider_customer_id)
    VALUES (v_user, 'bitnob', 'cp-bitnob-1');

    INSERT INTO cards (user_id, provider_card_id, last4, status)
    VALUES (v_user, 'cp-card-1', '4242', 'active');
END $$;

-- A journal entry for the authorizations to point at. Its shape does not
-- matter to these tests; that it EXISTS does, because card_authorizations
-- carries a real foreign key to it and a protection table that could record a
-- charge with no money behind it would be a second, softer set of books.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_card BIGINT; v_float BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cp-customer@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_card', 'user', v_user, 'USD', 'credit') RETURNING id INTO v_card;

    SELECT id INTO v_float FROM accounts WHERE kind = 'provider_float' AND currency = 'USD';
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, owner_type, currency, normal_balance)
        VALUES ('provider_float', NULL, 'USD', 'debit')
        RETURNING id INTO v_float;
    END IF;

    INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at)
    VALUES ('card_authorization', 'cp:seed-entry', 'seed', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_float, -1000, 'USD'),
      (v_entry, v_card,   1000, 'USD');
END $$;

\echo '=== 1. A redelivered authorization cannot be recorded twice ==='
-- The duplicate check COUNTS rows in this table, so a webhook redelivery
-- landing twice would freeze a card over a charge that only ever happened
-- once. The ledger's own idempotency key does not help here: it guards the
-- posting, not this row.
-- The first delivery, in its OWN block. A block with an EXCEPTION clause rolls
-- back to its own start when the handler fires, so writing both deliveries in
-- one block would undo the first one too — and every later test that reads it
-- would then be testing an empty table while still printing PASS.
DO $$
DECLARE v_card BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';
    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_key, merchant_label, amount_minor, currency, entry_id, occurred_at)
    VALUES (v_card, 'cp-txn-1', 'netflix', 'NETFLIX.COM', 1599, 'USD', v_entry,
            now() - interval '40 seconds');
END $$;

DO $$
DECLARE v_card BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';

    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_key, merchant_label, amount_minor, currency, entry_id, occurred_at)
    VALUES (v_card, 'cp-txn-1', 'netflix', 'NETFLIX.COM', 1599, 'USD', v_entry, now());

    RAISE EXCEPTION 'TEST FAILED: the same provider transaction was recorded twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: a redelivered authorization is recorded once';
END $$;

\echo ''
\echo '=== 2. The same merchant, same amount, inside the window IS a duplicate ==='
DO $$
DECLARE v_card BIGINT; v_entry BIGINT; v_hits INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';

    -- The charge recorded above is 40 seconds old.
    SELECT card_duplicate_authorizations(v_card, 'netflix', 1599, now(), 90) INTO v_hits;
    IF v_hits <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected 1 prior charge inside the window, got %', v_hits;
    END IF;
    RAISE NOTICE 'PASS: a second identical charge 40s later is seen';
END $$;

\echo ''
\echo '=== 3. The same charge OUTSIDE the window is not ==='
-- Two coffees at the same shop an hour apart is not a duplicate, and a guard
-- that said it was would freeze cards on ordinary behaviour.
DO $$
DECLARE v_card BIGINT; v_hits INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT card_duplicate_authorizations(v_card, 'netflix', 1599, now() + interval '10 minutes', 90)
      INTO v_hits;
    IF v_hits <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a charge 10 minutes later counted as a duplicate';
    END IF;
    RAISE NOTICE 'PASS: the window is a window, not "ever"';
END $$;

\echo ''
\echo '=== 4. A different amount at the same merchant is not a duplicate ==='
DO $$
DECLARE v_card BIGINT; v_hits INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT card_duplicate_authorizations(v_card, 'netflix', 1600, now(), 90) INTO v_hits;
    IF v_hits <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a one-cent difference counted as a duplicate';
    END IF;
    RAISE NOTICE 'PASS: a basket of two different amounts is not a double charge';
END $$;

\echo ''
\echo '=== 5. An authorization with NO merchant can never be a duplicate ==='
-- If the provider omits the merchant, every same-amount charge on the card
-- would otherwise look like a duplicate of every other one — and freezing a
-- card because somebody topped up twice is worse than missing a duplicate.
DO $$
DECLARE v_card BIGINT; v_entry BIGINT; v_hits INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';

    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_key, amount_minor, currency, entry_id, occurred_at)
    VALUES (v_card, 'cp-txn-nomerchant', NULL, 500, 'USD', v_entry, now());

    SELECT card_duplicate_authorizations(v_card, NULL, 500, now(), 90) INTO v_hits;
    IF v_hits <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a merchantless charge matched as a duplicate';
    END IF;
    RAISE NOTICE 'PASS: no merchant means no duplicate verdict';
END $$;

\echo ''
\echo '=== 6. An authorization cannot be recorded without a journal entry ==='
-- This table is the CONTEXT around money that moved. A row here with no entry
-- behind it would be a second set of books that disagrees with the first.
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_key, amount_minor, currency, entry_id, occurred_at)
    VALUES (v_card, 'cp-txn-orphan', 'netflix', 100, 'USD', 999999999, now());
    RAISE EXCEPTION 'TEST FAILED: an authorization was recorded against no entry';
EXCEPTION
    WHEN foreign_key_violation THEN
        RAISE NOTICE 'PASS: every recorded charge points at the money that moved';
END $$;

\echo ''
\echo '=== 7. A zero-amount authorization is refused ==='
DO $$
DECLARE v_card BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';
    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_key, amount_minor, currency, entry_id, occurred_at)
    VALUES (v_card, 'cp-txn-zero', 'netflix', 0, 'USD', v_entry, now());
    RAISE EXCEPTION 'TEST FAILED: a zero-amount authorization was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a charge of nothing is not a charge';
END $$;

\echo ''
\echo '=== 8. A redelivered DECLINE cannot be counted twice ==='
-- The burst threshold counts declines. A retried webhook counting twice would
-- freeze a card at half the threshold the operator configured.
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    INSERT INTO card_declines (card_id, source, provider_txn_id, reason, occurred_at)
    VALUES (v_card, 'provider', 'cp-decline-1', 'insufficient_funds', now());
END $$;

DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    INSERT INTO card_declines (card_id, source, provider_txn_id, reason, occurred_at)
    VALUES (v_card, 'provider', 'cp-decline-1', 'insufficient_funds', now());
    RAISE EXCEPTION 'TEST FAILED: the same decline was recorded twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: a redelivered decline counts once';
END $$;

\echo ''
\echo '=== 9. A freeze cannot be deleted ==='
-- "Why is this card frozen" must stay answerable after the incident, and a
-- freeze log somebody can delete answers whatever they want it to.
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    INSERT INTO card_freezes (card_id, actor, reason, detail)
    VALUES (v_card, 'automatic', 'insufficient_funds_decline', 'first decline');
END $$;

DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    DELETE FROM card_freezes WHERE card_id = v_card;
    RAISE EXCEPTION 'TEST FAILED: a freeze record was deleted';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: a freeze cannot be deleted';
END $$;

\echo ''
\echo '=== 10. A freeze reason cannot be rewritten ==='
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    UPDATE card_freezes SET reason = 'customer_request' WHERE card_id = v_card;
    RAISE EXCEPTION 'TEST FAILED: a freeze reason was rewritten';
EXCEPTION
    WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
        RAISE NOTICE 'PASS: why a card was frozen is a fact about a past moment';
END $$;

\echo ''
\echo '=== 11. Lifting a freeze is allowed, exactly once ==='
DO $$
DECLARE v_card BIGINT; v_user BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_user FROM users WHERE email = 'cp-customer@example.ng';

    UPDATE card_freezes SET lifted_at = now(), lifted_by = v_user WHERE card_id = v_card;

    BEGIN
        UPDATE card_freezes SET lifted_at = now() + interval '1 hour' WHERE card_id = v_card;
        RAISE EXCEPTION 'TEST FAILED: a freeze was lifted twice';
    EXCEPTION
        WHEN raise_exception THEN
            IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
            RAISE NOTICE 'PASS: a freeze is lifted once and the time it happened stands';
    END;
END $$;

\echo ''
\echo '=== 12. The operations queues show what needs a person ==='
DO $$
DECLARE v_card BIGINT; v_entry BIGINT; v_frozen INT; v_flagged INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'cp:seed-entry';

    UPDATE cards SET status = 'frozen' WHERE id = v_card;
    INSERT INTO card_freezes (card_id, actor, reason, detail)
    VALUES (v_card, 'automatic', 'duplicate_charge', 'NETFLIX.COM twice in 40s');

    UPDATE card_authorizations SET flagged_reason = 'duplicate_charge'
     WHERE provider_txn_id = 'cp-txn-1';

    SELECT count(*) INTO v_frozen  FROM cards_frozen_automatically;
    SELECT count(*) INTO v_flagged FROM card_flagged_authorizations;

    IF v_frozen < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: an automatically frozen card is not in the queue';
    END IF;
    IF v_flagged < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a flagged charge is not in the queue';
    END IF;
    RAISE NOTICE 'PASS: both queues surface what a person has to act on';
END $$;

\echo ''
\echo '=== 13. A customer freeze and an automatic one are distinguishable ==='
-- They need completely different words on a customer's screen: one is "you
-- froze this", the other is "we stopped something, here is what". A single
-- `status = frozen` cannot tell them apart.
DO $$
DECLARE v_card BIGINT; v_auto INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'cp-card-1';
    SELECT count(*) INTO v_auto FROM card_freezes
     WHERE card_id = v_card AND actor = 'automatic' AND lifted_at IS NULL;
    IF v_auto <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected exactly one live automatic freeze, got %', v_auto;
    END IF;
    RAISE NOTICE 'PASS: who froze the card, and why, survives the freeze';
END $$;

\echo ''
\echo 'card protection: all blocks passed'
