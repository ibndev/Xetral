-- ===========================================================================
--  Xetral — entry status invariant tests
--  packages/ledger/sql/023_entry_status.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('p23-a@example.ng', 'active');

DO $$
DECLARE
    v_u BIGINT; v_w BIGINT; v_float BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p23-a@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_u, 'NGN', 'credit') RETURNING id INTO v_w;

    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('provider_float', 'NGN', 'debit') RETURNING id INTO v_float;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM accounts
                    WHERE kind = 'expense_dispute_loss' AND currency = 'NGN') THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('expense_dispute_loss', 'NGN', 'debit');
    END IF;

    -- Four charges to put into four different states.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p23:settled',  'wallet_funding', now(), 'left alone'),
           ('p23:reversed', 'wallet_funding', now(), 'to be reversed'),
           ('p23:refunded', 'wallet_funding', now(), 'to be refunded'),
           ('p23:disputed', 'wallet_funding', now(), 'to be disputed'),
           -- A separate target for block 4, which needs SOMETHING valid to
           -- point at. Pointing it at 'p23:settled' made that entry read
           -- 'refunded' two blocks later and failed the settled case — a
           -- fixture one test quietly mutates for another.
           ('p23:card-target', 'wallet_funding', now(), 'block 4 points here');

    FOR v_entry IN
        SELECT id FROM journal_entries
         WHERE idempotency_key IN
               ('p23:settled', 'p23:reversed', 'p23:refunded', 'p23:disputed',
                'p23:card-target')
    LOOP
        INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
        VALUES (v_entry, v_w, 100000, 'NGN'), (v_entry, v_float, -100000, 'NGN');
    END LOOP;
END $$;

\echo '=== 1. A REVERSAL still cannot be written without naming its target ==='
-- The point of 023 is that a refund MAY name an entry. It must not have
-- loosened the rule that a reversal MUST — an unattached reversal is money
-- vanishing with nothing saying what it undid.
DO $$
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p23:orphan-reversal', 'reversal', now(), 'names nothing');
    RAISE EXCEPTION 'TEST FAILED: a reversal with no target was accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a reversal must name the entry it reverses';
END $$;

\echo '=== 2. A DISPUTE REFUND must name the charge it answers ==='
-- Before 023 it COULD NOT name one, so every dispute refund was a floating
-- credit. The fix would be worth little if it merely made the link optional
-- where the information is always in hand: `disputes.entry_id` is a foreign
-- key, so a dispute refund that names nothing is a bug, not a limitation.
DO $$
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p23:orphan-refund', 'dispute_refund', now(), 'names nothing');
    RAISE EXCEPTION 'TEST FAILED: a dispute refund with no target was accepted';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a dispute refund must name the charge it refunds';
END $$;

\echo '=== 3. An ORDINARY entry still cannot name one ==='
DO $$
DECLARE v_target BIGINT;
BEGIN
    SELECT id INTO v_target FROM journal_entries WHERE idempotency_key = 'p23:card-target';
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p23:bad-transfer', 'wallet_transfer', now(), 'not an answer', v_target);
    RAISE EXCEPTION 'TEST FAILED: a wallet_transfer was allowed to name a target';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: only answering kinds may name an entry';
END $$;

\echo '=== 4. A CARD REFUND may name one, or not ==='
-- The one asymmetry, and it is deliberate. A merchant refund arrives through a
-- provider payload we do not control; refusing it for a missing link would
-- turn worse reporting into money the customer is owed and does not get.
DO $$
DECLARE v_target BIGINT; v_entry BIGINT; v_card BIGINT; v_float BIGINT; v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p23-a@example.ng';
    SELECT id INTO v_target FROM journal_entries WHERE idempotency_key = 'p23:card-target';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_card', 'user', v_u, 'USD', 'credit') RETURNING id INTO v_card;
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'USD' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('provider_float', 'USD', 'debit') RETURNING id INTO v_float;
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p23:card-refund-unlinked', 'card_refund', now(), 'merchant said nothing')
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_card, 500, 'USD'), (v_entry, v_float, -500, 'USD');

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p23:card-refund-linked', 'card_refund', now(), 'merchant named it', v_target)
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_card, 500, 'USD'), (v_entry, v_float, -500, 'USD');

    RAISE NOTICE 'PASS: a card refund is accepted with and without a target';
END $$;

\echo '=== 5. The four states are DERIVED correctly ==='
DO $$
DECLARE
    v_u BIGINT; v_w BIGINT; v_loss BIGINT; v_target BIGINT; v_entry BIGINT;
    v_status TEXT; v_answered UUID;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p23-a@example.ng';
    SELECT id INTO v_w FROM accounts
     WHERE kind = 'customer_wallet' AND owner_id = v_u AND currency = 'NGN';
    SELECT id INTO v_loss FROM accounts
     WHERE kind = 'expense_dispute_loss' AND currency = 'NGN';

    -- settled: nothing has happened to it.
    SELECT status INTO v_status FROM entry_status
     WHERE id = (SELECT id FROM journal_entries WHERE idempotency_key = 'p23:settled');
    IF v_status <> 'settled' THEN
        RAISE EXCEPTION 'TEST FAILED: an untouched entry reads %', v_status;
    END IF;

    -- reversed.
    SELECT id INTO v_target FROM journal_entries WHERE idempotency_key = 'p23:reversed';
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p23:the-reversal', 'reversal', now(), 'undone', v_target)
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_w, -100000, 'NGN'),
           (v_entry, (SELECT id FROM accounts
                       WHERE kind = 'provider_float' AND currency = 'NGN'
                         AND owner_id IS NULL), 100000, 'NGN');

    SELECT status, answered_by INTO v_status, v_answered
      FROM entry_status WHERE id = v_target;
    IF v_status <> 'reversed' THEN
        RAISE EXCEPTION 'TEST FAILED: a reversed entry reads %', v_status;
    END IF;
    IF v_answered IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: a reversed entry names no answering entry';
    END IF;

    -- refunded.
    SELECT id INTO v_target FROM journal_entries WHERE idempotency_key = 'p23:refunded';
    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_u, v_target, 'not_authorised', 'was not me', now() + interval '10 days');

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p23:the-refund', 'dispute_refund', now(), 'upheld', v_target)
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_w, 100000, 'NGN'), (v_entry, v_loss, -100000, 'NGN');

    UPDATE disputes SET status = 'accepted', resolved_at = now(),
                        resolution = 'upheld', resolved_by = v_u,
                        refund_entry_id = v_entry
     WHERE entry_id = v_target;

    SELECT status INTO v_status FROM entry_status WHERE id = v_target;
    IF v_status <> 'refunded' THEN
        RAISE EXCEPTION 'TEST FAILED: a refunded entry reads %', v_status;
    END IF;

    -- disputed: an OPEN claim and nothing decided.
    SELECT id INTO v_target FROM journal_entries WHERE idempotency_key = 'p23:disputed';
    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_u, v_target, 'not_authorised', 'still waiting', now() + interval '10 days');

    SELECT status INTO v_status FROM entry_status WHERE id = v_target;
    IF v_status <> 'disputed' THEN
        RAISE EXCEPTION 'TEST FAILED: an openly disputed entry reads %', v_status;
    END IF;

    RAISE NOTICE 'PASS: settled, reversed, refunded and disputed are four states';
END $$;

\echo '=== 6. REFUNDED beats DISPUTED, because it is the one that paid ==='
-- An upheld dispute makes an entry both. Reporting it as 'disputed' would tell
-- a customer their claim is still open when the money is already back, and
-- 'disputed' is the state where somebody is waiting on us.
DO $$
DECLARE v_status TEXT;
BEGIN
    SELECT status INTO v_status FROM entry_status
     WHERE id = (SELECT id FROM journal_entries WHERE idempotency_key = 'p23:refunded');
    IF v_status <> 'refunded' THEN
        RAISE EXCEPTION 'TEST FAILED: an entry both disputed and refunded reads %', v_status;
    END IF;
    RAISE NOTICE 'PASS: an accepted dispute reports as refunded, not disputed';
END $$;

\echo '=== 7. The status is a VIEW, so it cannot be written to disagree ==='
-- A stored column is a second copy of the ledger, and the copy drifts the
-- first time a flow forgets to update it. Asserted structurally: there is no
-- status column on the table, so there is nothing to drift.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'journal_entries' AND column_name = 'status'
    ) THEN
        RAISE EXCEPTION 'TEST FAILED: journal_entries has a stored status column';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.views WHERE table_name = 'entry_status'
    ) THEN
        RAISE EXCEPTION 'TEST FAILED: entry_status is not a view';
    END IF;
    RAISE NOTICE 'PASS: the status is derived, never stored';
END $$;
