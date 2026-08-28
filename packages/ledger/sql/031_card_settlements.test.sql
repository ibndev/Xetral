-- ===========================================================================
--  Xetral — card hold invariants
--  packages/ledger/sql/031_card_settlements.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('p31-owner@example.ng', 'active');

-- A card, two authorizations, and the entries they posted. Real postings,
-- because `card_holds_stuck` joins to the ledger and a fixture that skipped it
-- would be testing a view that could never return a row in production.
DO $$
DECLARE
    v_u BIGINT; v_card BIGINT; v_cardacct BIGINT; v_pending BIGINT;
    v_entry BIGINT; v_i INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p31-owner@example.ng';

    INSERT INTO cards (user_id, provider_card_id, last4, status)
    VALUES (v_u, 'p31-card', '4242', 'active') RETURNING id INTO v_card;

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_card', 'user', v_u, 'USD', 'credit') RETURNING id INTO v_cardacct;
    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_pending', 'user', v_u, 'USD', 'credit') RETURNING id INTO v_pending;

    -- Fund the card so the authorizations below do not overdraw it.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p31:fund', 'card_funding', now(), 'seed') RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_cardacct, 100000, 'USD'),
           (v_entry, (SELECT id FROM accounts
                       WHERE kind = 'provider_float' AND currency = 'USD'
                         AND owner_id IS NULL LIMIT 1), -100000, 'USD');

    FOR v_i IN 1..2 LOOP
        INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
        VALUES ('p31:auth-' || v_i, 'card_authorization',
                now() - make_interval(days => v_i * 20), 'a hold')
        RETURNING id INTO v_entry;

        INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
        VALUES (v_entry, v_cardacct, -2500, 'USD'), (v_entry, v_pending, 2500, 'USD');

        INSERT INTO card_authorizations
          (card_id, provider_txn_id, merchant_label, amount_minor, currency,
           entry_id, occurred_at)
        VALUES (v_card, 'p31-txn-' || v_i, 'A Merchant', 2500, 'USD', v_entry,
                now() - make_interval(days => v_i * 20));
    END LOOP;
END $$;

\echo '=== 1. A hold with NO OUTCOME past the window is reported ==='
-- The failure nothing else can see: the money sits in `customer_pending`, the
-- customer cannot spend it, the ledger balances perfectly, and `ledger_drift`
-- reports nothing.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM card_holds_stuck WHERE last4 = '4242';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected two stuck holds, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: a hold nobody resolved is visible';
END $$;

\echo '=== 2. A RECENT hold is NOT reported ==='
-- Bitnob settles up to 7-14 BUSINESS days out, so a hold flagged before their
-- own window closes is a false alarm every fortnight — and an alert people
-- learn to ignore is worse than none.
DO $$
DECLARE v_card BIGINT; v_entry BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p31-card';
    SELECT entry_id INTO v_entry FROM card_authorizations
     WHERE card_id = v_card ORDER BY id LIMIT 1;

    INSERT INTO card_authorizations
      (card_id, provider_txn_id, merchant_label, amount_minor, currency,
       entry_id, occurred_at)
    VALUES (v_card, 'p31-txn-fresh', 'A Merchant', 2500, 'USD', v_entry, now());

    SELECT count(*) INTO v_n FROM card_holds_stuck
     WHERE provider_txn_id = 'p31-txn-fresh';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a hold made today was reported as stuck';
    END IF;
    RAISE NOTICE 'PASS: a young hold is left alone';
END $$;

\echo '=== 3. SETTLING one takes it off the list ==='
DO $$
DECLARE v_card BIGINT; v_auth BIGINT; v_entry BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p31-card';
    SELECT id, entry_id INTO v_auth, v_entry FROM card_authorizations
     WHERE card_id = v_card AND provider_txn_id = 'p31-txn-1';

    INSERT INTO card_settlements
      (authorization_id, outcome, entry_id, amount_minor, currency, occurred_at)
    VALUES (v_auth, 'settled', v_entry, 2500, 'USD', now());

    SELECT count(*) INTO v_n FROM card_holds_stuck WHERE provider_txn_id = 'p31-txn-1';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a settled hold is still reported as stuck';
    END IF;
    RAISE NOTICE 'PASS: a resolved hold leaves the queue';
END $$;

\echo '=== 4. A hold resolves ONCE ==='
-- A hold cannot both settle and expire, and a redelivered webhook must not
-- become a second outcome. The ledger's idempotency key already makes the
-- posting a replay; this makes the record agree.
DO $$
DECLARE v_card BIGINT; v_auth BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p31-card';
    SELECT id, entry_id INTO v_auth, v_entry FROM card_authorizations
     WHERE card_id = v_card AND provider_txn_id = 'p31-txn-1';

    INSERT INTO card_settlements
      (authorization_id, outcome, entry_id, amount_minor, currency, occurred_at)
    VALUES (v_auth, 'expired', v_entry, 2500, 'USD', now());
    RAISE EXCEPTION 'TEST FAILED: one hold both settled and expired';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: a hold has one outcome';
END $$;

\echo '=== 5. An outcome cannot be REWRITTEN ==='
-- A customer's statement rests on this, and the gap between an authorised and
-- a settled amount is exactly the field somebody would want to tidy away.
DO $$
BEGIN
    UPDATE card_settlements SET amount_minor = 1;
    RAISE EXCEPTION 'TEST FAILED: a settled amount was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: how a hold resolved is immutable';
END $$;

\echo '=== 6. A settlement that DIFFERS from its authorization is reported ==='
-- A tip added after the card was presented is a few percent; a settlement many
-- times the authorisation is a merchant error or a compromised terminal, and
-- nothing anywhere compared the two before.
DO $$
DECLARE v_card BIGINT; v_auth BIGINT; v_entry BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p31-card';
    SELECT id, entry_id INTO v_auth, v_entry FROM card_authorizations
     WHERE card_id = v_card AND provider_txn_id = 'p31-txn-2';

    -- Authorised $25.00, settled $400.00.
    INSERT INTO card_settlements
      (authorization_id, outcome, entry_id, amount_minor, currency, occurred_at)
    VALUES (v_auth, 'settled', v_entry, 40000, 'USD', now());

    SELECT * INTO v_row FROM card_settlement_differences WHERE card_id =
      (SELECT uuid FROM cards WHERE id = v_card);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: a settlement sixteen times its authorization '
                        'was not reported';
    END IF;
    IF v_row.authorised_minor <> 2500 OR v_row.settled_minor <> 40000 THEN
        RAISE EXCEPTION 'TEST FAILED: the view reports % against %',
            v_row.settled_minor, v_row.authorised_minor;
    END IF;
    RAISE NOTICE 'PASS: a settlement that does not match what was authorised is visible';
END $$;

\echo '=== 7. A matching settlement is NOT reported as a difference ==='
-- The ordinary case, which is nearly all of them. A view that listed every
-- settlement would be a view nobody reads.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM card_settlement_differences d
      JOIN card_authorizations a ON a.id = (
        SELECT authorization_id FROM card_settlements WHERE id = d.id)
     WHERE a.provider_txn_id = 'p31-txn-1';
    IF v_n <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a settlement equal to its authorization was reported';
    END IF;
    RAISE NOTICE 'PASS: only a mismatch is reported';
END $$;
