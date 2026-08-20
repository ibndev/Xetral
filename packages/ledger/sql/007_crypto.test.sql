-- ===========================================================================
--  Xetral — Phase 9 crypto invariant tests
--  packages/ledger/sql/007_crypto.test.sql
--
--  Two things cannot be undone here and neither has a provider to appeal to:
--  a deposit credited before it was final, and a withdrawal broadcast to the
--  wrong place. Every block below is one of those.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

CREATE OR REPLACE FUNCTION cx_account(
    p_kind account_kind, p_owner BIGINT, p_currency TEXT, p_normal TEXT
) RETURNS BIGINT AS $fn$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM accounts
     WHERE kind = p_kind AND currency = p_currency
       AND owner_id IS NOT DISTINCT FROM p_owner;
    IF v_id IS NOT NULL THEN RETURN v_id; END IF;

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES (p_kind,
            CASE WHEN p_owner IS NULL THEN NULL ELSE 'user' END,
            p_owner, p_currency, p_normal)
    RETURNING id INTO v_id;
    RETURN v_id;
END;
$fn$ LANGUAGE plpgsql;

/** A balanced USDT entry: float -> pending, the shape a seen deposit takes. */
CREATE OR REPLACE FUNCTION cx_entry(p_key TEXT, p_user BIGINT, p_minor BIGINT)
RETURNS BIGINT AS $fn$
DECLARE v_entry BIGINT;
BEGIN
    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES (p_key, 'crypto_deposit', 'test crypto', now())
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, cx_account('customer_pending', p_user, 'USDT', 'credit'), p_minor, 'USDT'),
           (v_entry, cx_account('provider_float', NULL, 'USDT', 'debit'), -p_minor, 'USDT');
    RETURN v_entry;
END;
$fn$ LANGUAGE plpgsql;

INSERT INTO users (email, status) VALUES
  ('cx-a@example.ng', 'active'),
  ('cx-b@example.ng', 'active');

\echo '=== 1. An address belongs to one customer, one asset, one CHAIN ==='
DO $$
DECLARE v_user BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    INSERT INTO crypto_addresses
      (user_id, provider_address_id, asset, network, address)
    VALUES (v_user, 'addr_1', 'USDT', 'tron', 'TQ2n9F4kAbcDefGhiJkLmNoPqRsTuVwXyZ')
    RETURNING id INTO v_id;

    -- The SAME address string on a DIFFERENT chain is a different address, and
    -- must be allowed: USDT on Tron and on BSC are not interchangeable, and
    -- sending to the wrong one loses the money.
    INSERT INTO crypto_addresses
      (user_id, provider_address_id, asset, network, address)
    VALUES (v_user, 'addr_2', 'USDT', 'bsc', 'TQ2n9F4kAbcDefGhiJkLmNoPqRsTuVwXyZ');

    RAISE NOTICE 'PASS: address % issued; the chain is part of its identity', v_id;
END $$;

\echo ''
\echo '=== 2. One customer per (network, address) ==='
-- A deposit naming an address must resolve to exactly one person.
DO $$
DECLARE v_other BIGINT;
BEGIN
    SELECT id INTO v_other FROM users WHERE email = 'cx-b@example.ng';
    INSERT INTO crypto_addresses
      (user_id, provider_address_id, asset, network, address)
    VALUES (v_other, 'addr_3', 'USDT', 'tron', 'TQ2n9F4kAbcDefGhiJkLmNoPqRsTuVwXyZ');
    RAISE EXCEPTION 'TEST FAILED: two customers share a deposit address';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: one deposit address, one owner';
END $$;

\echo ''
\echo '=== 3. One live address per (customer, asset, network) ==='
DO $$
DECLARE v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    INSERT INTO crypto_addresses
      (user_id, provider_address_id, asset, network, address)
    VALUES (v_user, 'addr_4', 'USDT', 'tron', 'TDifferentAddressButSameCustomer99');
    RAISE EXCEPTION 'TEST FAILED: a second live USDT/tron address was issued';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: one live address per customer, asset and chain';
END $$;

\echo ''
\echo '=== 4. An issued address is IMMUTABLE ==='
-- Senders paste addresses they saved months ago. Reassigning one credits a new
-- owner with deposits the old owner is still receiving.
DO $$
DECLARE v_id BIGINT; v_other BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_addresses WHERE provider_address_id = 'addr_1';
    SELECT id INTO v_other FROM users WHERE email = 'cx-b@example.ng';
    UPDATE crypto_addresses SET user_id = v_other WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a deposit address was reassigned';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an address that has been given out never changes hands';
END $$;

\echo ''
\echo '=== 5. A deposit starts SEEN, not spendable ==='
DO $$
DECLARE v_user BIGINT; v_addr BIGINT; v_entry BIGINT; v_id BIGINT;
        v_status crypto_deposit_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    SELECT id INTO v_addr FROM crypto_addresses WHERE provider_address_id = 'addr_1';
    v_entry := cx_entry('bitnob:cxd_1', v_user, 100000000);

    INSERT INTO crypto_deposits
      (provider_reference, user_id, address_id, tx_hash, asset, network,
       amount_minor, required_confirmations, seen_entry_id)
    VALUES ('cxd_1', v_user, v_addr, '0xaaa', 'USDT', 'tron', 100000000, 20, v_entry)
    RETURNING id INTO v_id;

    SELECT status INTO v_status FROM crypto_deposits WHERE id = v_id;
    IF v_status <> 'seen' THEN
        RAISE EXCEPTION 'TEST FAILED: a deposit was not held pending confirmation';
    END IF;
    RAISE NOTICE 'PASS: deposit % is visible and not yet spendable', v_id;
END $$;

\echo ''
\echo '=== 6. A deposit cannot be CONFIRMED below its threshold ==='
-- The one protection against a chain reorganisation, checked in the database
-- so a service with a stale config cannot lower it.
DO $$
DECLARE v_id BIGINT; v_entry BIGINT; v_user BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    SELECT id INTO v_id FROM crypto_deposits WHERE provider_reference = 'cxd_1';
    v_entry := cx_entry('bitnob:cxd_1_conf_early', v_user, 1);

    UPDATE crypto_deposits
       SET status = 'confirmed', confirmations = 3, confirmed_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a deposit was credited with 3 of 20 confirmations';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the confirmation threshold is enforced by the database';
END $$;

\echo ''
\echo '=== 7. Confirmations never go backwards ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_deposits WHERE provider_reference = 'cxd_1';
    UPDATE crypto_deposits SET confirmations = 10 WHERE id = v_id;
    UPDATE crypto_deposits SET confirmations = 4 WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a deposit lost confirmations';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a provider reporting fewer confirmations is not a fact about us';
END $$;

\echo ''
\echo '=== 8. The same on-chain payment cannot be credited twice ==='
-- Belt and braces: the provider reference AND the chain identity.
DO $$
DECLARE v_user BIGINT; v_addr BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    SELECT id INTO v_addr FROM crypto_addresses WHERE provider_address_id = 'addr_1';
    v_entry := cx_entry('bitnob:cxd_dup', v_user, 100000000);

    INSERT INTO crypto_deposits
      (provider_reference, user_id, address_id, tx_hash, asset, network,
       amount_minor, required_confirmations, seen_entry_id)
    VALUES ('cxd_different_id', v_user, v_addr, '0xaaa', 'USDT', 'tron',
            100000000, 20, v_entry);
    RAISE EXCEPTION 'TEST FAILED: one on-chain payment was credited twice';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: (chain, tx, output) identifies one payment';
END $$;

\echo ''
\echo '=== 8a. But two outputs in ONE transaction are two payments ==='
DO $$
DECLARE v_user BIGINT; v_addr BIGINT; v_entry BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    SELECT id INTO v_addr FROM crypto_addresses WHERE provider_address_id = 'addr_1';
    v_entry := cx_entry('bitnob:cxd_out1', v_user, 5000000);

    INSERT INTO crypto_deposits
      (provider_reference, user_id, address_id, tx_hash, output_index, asset,
       network, amount_minor, required_confirmations, seen_entry_id)
    VALUES ('cxd_out1', v_user, v_addr, '0xaaa', 1, 'USDT', 'tron',
            5000000, 20, v_entry)
    RETURNING id INTO v_id;

    RAISE NOTICE 'PASS: a second output of the same transaction is real money too';
END $$;

\echo ''
\echo '=== 9. The full deposit lifecycle works ==='
-- Everything above asserts a refusal. A schema that rejected EVERYTHING would
-- pass all of them.
DO $$
DECLARE v_user BIGINT; v_addr BIGINT; v_seen BIGINT; v_conf BIGINT; v_id BIGINT;
        v_status crypto_deposit_status; v_open BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-b@example.ng';
    INSERT INTO crypto_addresses
      (user_id, provider_address_id, asset, network, address)
    VALUES (v_user, 'addr_happy', 'USDT', 'tron', 'THappyPathAddressForCustomerB1234')
    RETURNING id INTO v_addr;

    v_seen := cx_entry('bitnob:cxd_happy', v_user, 250000000);
    INSERT INTO crypto_deposits
      (provider_reference, user_id, address_id, tx_hash, asset, network,
       amount_minor, required_confirmations, seen_entry_id)
    VALUES ('cxd_happy', v_user, v_addr, '0xhappy', 'USDT', 'tron',
            250000000, 20, v_seen)
    RETURNING id INTO v_id;

    SELECT COUNT(*) INTO v_open FROM crypto_deposits_maturing WHERE deposit_id = v_id;
    IF v_open <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a maturing deposit is invisible';
    END IF;

    v_conf := cx_entry('bitnob:cxd_happy_conf', v_user, 250000000);
    UPDATE crypto_deposits
       SET status = 'confirmed', confirmations = 25, confirmed_entry_id = v_conf
     WHERE id = v_id;

    SELECT status INTO v_status FROM crypto_deposits WHERE id = v_id;
    IF v_status <> 'confirmed' THEN
        RAISE EXCEPTION 'TEST FAILED: a fully confirmed deposit could not be credited';
    END IF;

    SELECT COUNT(*) INTO v_open FROM crypto_deposits_maturing WHERE deposit_id = v_id;
    IF v_open <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a confirmed deposit is still maturing';
    END IF;

    RAISE NOTICE 'PASS: seen -> confirmed, and off the maturing queue';
END $$;

\echo ''
\echo '=== 10. A CONFIRMED deposit is final ==='
-- The money is spendable from that moment and may already be gone. A reorg
-- deeper than our threshold is an incident for a person, not a state change.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_deposits WHERE provider_reference = 'cxd_happy';
    UPDATE crypto_deposits SET status = 'orphaned' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a credited deposit was orphaned';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: once spendable, a deposit cannot be taken back silently';
END $$;

\echo ''
\echo '=== 11. A withdrawal starts RESERVED, with nothing broadcast ==='
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_id BIGINT; v_status crypto_withdrawal_status;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    v_entry := cx_entry('bitnob:cxw_1', v_user, 50000000);

    INSERT INTO crypto_withdrawals
      (user_id, reference, idempotency_key, asset, network, destination,
       amount_minor, fee_minor, reserve_entry_id)
    VALUES (v_user, 'cxw-ref-1', 'cxw-key-1', 'USDT', 'tron',
            'TDestinationAddressOfSomeExchange1', 50000000, 1000000, v_entry)
    RETURNING id INTO v_id;

    SELECT status INTO v_status FROM crypto_withdrawals WHERE id = v_id;
    IF v_status <> 'reserved' THEN
        RAISE EXCEPTION 'TEST FAILED: a withdrawal did not start reserved';
    END IF;
    RAISE NOTICE 'PASS: withdrawal % holds the money and has sent nothing', v_id;
END $$;

\echo ''
\echo '=== 12. A broadcast withdrawal must name its transaction ==='
-- Without one there is nothing to show a customer and nothing to reconcile,
-- and "broadcast" is just a claim.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_withdrawals WHERE reference = 'cxw-ref-1';
    UPDATE crypto_withdrawals SET status = 'broadcast' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a withdrawal was broadcast with no transaction hash';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: broadcast means there is a transaction to point at';
END $$;

\echo ''
\echo '=== 13. The DESTINATION cannot change after the request ==='
-- The single most dangerous field in the platform. A change here after the
-- customer approved it sends their money somewhere they never agreed to.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_withdrawals WHERE reference = 'cxw-ref-1';
    UPDATE crypto_withdrawals SET destination = 'TAttackerControlledAddress12345678'
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a withdrawal destination was changed';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the address a customer approved is the address it goes to';
END $$;

\echo ''
\echo '=== 14. A BROADCAST withdrawal can never return to reserved ==='
-- The bytes are on a chain. A state machine that allowed this would be lying.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM crypto_withdrawals WHERE reference = 'cxw-ref-1';
    UPDATE crypto_withdrawals SET status = 'broadcast', tx_hash = '0xsent' WHERE id = v_id;
    UPDATE crypto_withdrawals SET status = 'reserved' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a broadcast withdrawal was un-sent';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: nothing recalls a transaction that is already on a chain';
END $$;

\echo ''
\echo '=== 15. A transaction hash, once recorded, is fixed ==='
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    v_entry := cx_entry('bitnob:cxw_hash', v_user, 10000000);
    INSERT INTO crypto_withdrawals
      (user_id, reference, idempotency_key, asset, network, destination,
       amount_minor, fee_minor, reserve_entry_id)
    VALUES (v_user, 'cxw-ref-hash', 'cxw-key-hash', 'USDT', 'tron',
            'TAnotherDestinationAddress1234567', 10000000, 500000, v_entry)
    RETURNING id INTO v_id;

    UPDATE crypto_withdrawals SET status = 'broadcast', tx_hash = '0xfirst' WHERE id = v_id;
    UPDATE crypto_withdrawals SET tx_hash = '0xsecond' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a transaction hash was rewritten';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a receipt points at one transaction for ever';
END $$;

\echo ''
\echo '=== 16. A customer key is unique PER CUSTOMER ==='
DO $$
DECLARE v_user BIGINT; v_other BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_user  FROM users WHERE email = 'cx-a@example.ng';
    SELECT id INTO v_other FROM users WHERE email = 'cx-b@example.ng';

    -- The same key under a DIFFERENT customer must be accepted.
    v_entry := cx_entry('bitnob:cxw_other', v_other, 1000000);
    INSERT INTO crypto_withdrawals
      (user_id, reference, idempotency_key, asset, network, destination,
       amount_minor, fee_minor, reserve_entry_id)
    VALUES (v_other, 'cxw-ref-2', 'cxw-key-1', 'USDT', 'tron',
            'TYetAnotherDestination12345678901', 1000000, 100000, v_entry);

    BEGIN
        v_entry := cx_entry('bitnob:cxw_dup', v_user, 1000000);
        INSERT INTO crypto_withdrawals
          (user_id, reference, idempotency_key, asset, network, destination,
           amount_minor, fee_minor, reserve_entry_id)
        VALUES (v_user, 'cxw-ref-3', 'cxw-key-1', 'USDT', 'tron',
                'TYetAnotherDestination12345678902', 1000000, 100000, v_entry);
        RAISE EXCEPTION 'TEST FAILED: a customer reused their own key';
    EXCEPTION
        WHEN unique_violation THEN
            RAISE NOTICE 'PASS: one customer key, one withdrawal, nobody else blocked';
    END;
END $$;

\echo ''
\echo '=== 17. A failed withdrawal must say why ==='
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users WHERE email = 'cx-a@example.ng';
    v_entry := cx_entry('bitnob:cxw_fail', v_user, 2000000);
    INSERT INTO crypto_withdrawals
      (user_id, reference, idempotency_key, asset, network, destination,
       amount_minor, fee_minor, reserve_entry_id)
    VALUES (v_user, 'cxw-ref-fail', 'cxw-key-fail', 'USDT', 'tron',
            'TFailingDestinationAddress1234567', 2000000, 100000, v_entry)
    RETURNING id INTO v_id;

    UPDATE crypto_withdrawals SET status = 'failed' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a withdrawal failed with no reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a customer is always told why their money came back';
END $$;

\echo ''
\echo '=== 18. Withdrawals awaiting an outcome are visible ==='
DO $$
DECLARE v_open BIGINT; v_settled BIGINT;
BEGIN
    SELECT COUNT(*) INTO v_open FROM crypto_withdrawals_pending;
    IF v_open = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: withdrawals holding money are invisible';
    END IF;

    SELECT COUNT(*) INTO v_settled
      FROM crypto_withdrawals_pending p
      JOIN crypto_withdrawals w ON w.id = p.withdrawal_id
     WHERE w.status NOT IN ('reserved', 'broadcast');
    IF v_settled <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % settled withdrawals are still queued', v_settled;
    END IF;

    RAISE NOTICE 'PASS: % withdrawal(s) awaiting an outcome, and nothing else', v_open;
END $$;
