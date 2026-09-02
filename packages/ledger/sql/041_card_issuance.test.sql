-- ===========================================================================
--  Xetral — 041: what a card costs, and what a customer may call it
--  packages/ledger/sql/041_card_issuance.test.sql
--
--  The point of these is not that a row was inserted. It is that the price is
--  BOUNDED BY THE DATABASE — so a figure typed in dollars where cents were
--  meant is refused however it arrives — and that a label is a label rather
--  than a notes field.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES ('p41-owner@example.ng', 'active');

DO $$
DECLARE v_o BIGINT;
BEGIN
    SELECT id INTO v_o FROM users WHERE email = 'p41-owner@example.ng';
    INSERT INTO cards (user_id, provider_card_id, last4, status)
    VALUES (v_o, 'p41-card-a', '4242', 'active');
END $$;

\echo '=== 1. The price exists, and it is two hundred CENTS ==='
-- Two hundred, not two. A price stored in dollars would be charged as two
-- cents by a reader that believes the name, and the name is what the ledger
-- believes: `card_issuance_fee_cents` moves USD minor units.
DO $$
DECLARE v_value TEXT; v_type TEXT;
BEGIN
    SELECT value, value_type::text INTO v_value, v_type
      FROM platform_settings WHERE key = 'card_issuance_fee_cents';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED 1a: nothing says what a card costs';
    END IF;
    IF v_value <> '200' OR v_type <> 'integer' THEN
        RAISE EXCEPTION 'TEST FAILED 1b: the card price is % (%)', v_value, v_type;
    END IF;
    RAISE NOTICE 'PASS 1: a card costs 200 cents, as an integer';
END $$;

\echo '=== 2. A price typed in DOLLARS is refused ==='
-- The failure this guards is silent and expensive in the customer's
-- direction: '200' meaning $2.00 is right, and somebody "correcting" it to
-- 20000 would charge $200 for a virtual card. The bound is the database's
-- because the endpoint is one code path and psql is another.
DO $$
BEGIN
    BEGIN
        UPDATE platform_settings SET value = '20000' WHERE key = 'card_issuance_fee_cents';
        RAISE EXCEPTION 'TEST FAILED 2: a $200 card issuance fee was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 2: a price above the ceiling is refused by the database';
    END;
END $$;

\echo '=== 3. A NEGATIVE price is refused ==='
-- Zero is a real answer — an instance that issues cards free — so the floor is
-- zero rather than one. Below it is a fee that PAYS the customer to open
-- cards, which is a fraud engine rather than a promotion.
DO $$
BEGIN
    BEGIN
        UPDATE platform_settings SET value = '-1' WHERE key = 'card_issuance_fee_cents';
        RAISE EXCEPTION 'TEST FAILED 3: a negative card issuance fee was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 3: a card cannot cost less than nothing';
    END;
END $$;

\echo '=== 4. `card_creation` is a real entry kind, and the fee balances ==='
-- It has been in `entry_kind` since 001 and nothing had ever posted one, so
-- the first thing to do so would be the first thing to find out whether it was
-- still there. The TypeScript union and the Postgres enum only agree when an
-- insert says they do — Phase 3 finding 7, in the place it now matters.
DO $$
DECLARE
    v_user BIGINT; v_wallet BIGINT; v_fees BIGINT; v_tax BIGINT; v_float BIGINT;
    v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'p41-owner@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_user, 'USD', 'credit') RETURNING id INTO v_wallet;

    -- Platform accounts are one row per currency for the whole database, so
    -- they are resolved-or-created. Inserting unconditionally aborts this file
    -- the moment an earlier suite has already made one — the collision Phase 5
    -- recorded.
    SELECT id INTO v_fees FROM accounts
     WHERE kind = 'revenue_fees' AND currency = 'USD' AND owner_id IS NULL;
    IF v_fees IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('revenue_fees', 'platform', NULL, 'USD', 'credit') RETURNING id INTO v_fees;
    END IF;

    SELECT id INTO v_tax FROM accounts
     WHERE kind = 'liability_tax_payable' AND currency = 'USD' AND owner_id IS NULL;
    IF v_tax IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('liability_tax_payable', 'platform', NULL, 'USD', 'credit')
        RETURNING id INTO v_tax;
    END IF;

    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'USD' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('provider_float', 'platform', NULL, 'USD', 'debit') RETURNING id INTO v_float;
    END IF;

    -- Funded first, or the overdraft guard refuses the fee. The guard is doing
    -- its job: a customer who cannot afford the price does not get the card.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p41:fund', 'wallet_funding', now(), 'seed') RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_float, -1000, 'USD'), (v_entry, v_wallet, 1000, 'USD');

    -- Three legs in one currency, summing to zero: the customer pays, we keep
    -- part of it and owe the rest onward. Exactly the shape a transfer fee has,
    -- and the reason the fee is split at all — VAT on it is not our money.
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('p41:card-fee', 'card_creation', 'card issuance fee', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_wallet, -200, 'USD'),
           (v_entry, v_fees,    186, 'USD'),
           (v_entry, v_tax,      14, 'USD');

    RAISE NOTICE 'PASS 4: a card_creation entry posts, and balances per currency';
END $$;

\echo '=== 5. A LABEL is a label, not a notes field ==='
-- Forty characters is "Subscriptions" or "Work travel" with room to spare, and
-- is short enough that it cannot grow into something a customer would not want
-- appearing beside a card in a screenshot.
DO $$
DECLARE v_card BIGINT;
BEGIN
    SELECT id INTO v_card FROM cards WHERE provider_card_id = 'p41-card-a';

    UPDATE cards SET label = 'Subscriptions' WHERE id = v_card;
    UPDATE cards SET label = repeat('x', 40)  WHERE id = v_card;

    BEGIN
        UPDATE cards SET label = repeat('x', 41) WHERE id = v_card;
        RAISE EXCEPTION 'TEST FAILED 5a: a 41-character card label was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    -- Whitespace is not a name. An all-spaces label renders as a blank where
    -- the last four digits used to be, which reads as a broken card rather
    -- than as an unnamed one.
    BEGIN
        UPDATE cards SET label = '   ' WHERE id = v_card;
        RAISE EXCEPTION 'TEST FAILED 5b: a blank card label was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 5: a label is between one and forty real characters';
    END;
END $$;

\echo '=== 6. Naming a card does not disturb its identity ==='
-- 003's trigger refuses any change to a card's provider, its provider id or
-- its owner, because every webhook already delivered points at that row. A
-- label is the first column a CUSTOMER may write, so it is worth proving it
-- goes through that trigger rather than around it — and that clearing one back
-- to NULL is allowed, which is how somebody un-names a card.
DO $$
DECLARE v_card BIGINT; v_label TEXT; v_owner BIGINT;
BEGIN
    SELECT id, user_id INTO v_card, v_owner FROM cards WHERE provider_card_id = 'p41-card-a';

    UPDATE cards SET label = NULL WHERE id = v_card;
    SELECT label INTO v_label FROM cards WHERE id = v_card;
    IF v_label IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED 6a: a card label cannot be cleared';
    END IF;

    BEGIN
        UPDATE cards SET label = 'Mine', user_id = v_owner + 1 WHERE id = v_card;
        RAISE EXCEPTION 'TEST FAILED 6b: a card changed hands while being renamed';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 6: a label can be set and cleared; the owner still cannot';
    END;
END $$;
