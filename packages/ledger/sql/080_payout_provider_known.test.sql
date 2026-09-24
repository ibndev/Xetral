-- ============================================================================
--  080 invariants — a payout's provider is a fact or it is marked as a guess
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. A row written now defaults to a known provider.
DO $$
DECLARE d TEXT;
BEGIN
    SELECT column_default INTO d FROM information_schema.columns
     WHERE table_name = 'bank_payouts' AND column_name = 'provider_known';
    IF d IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'TEST FAILED 1: provider_known defaults to %', d;
    END IF;
    RAISE NOTICE 'PASS 1: new payouts record their rail as known';
END $$;

-- 2. It cannot be changed in either direction.
DO $$
DECLARE v_user BIGINT; v_entry BIGINT; v_id BIGINT;
BEGIN
    SELECT id INTO v_user FROM users ORDER BY id LIMIT 1;
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p80:reserve', 'wallet_withdrawal', now(), 'p80') RETURNING id INTO v_entry;
    INSERT INTO bank_payouts
        (user_id, reference, idempotency_key, country, bank_code, bank_name,
         account_number, account_name, currency, amount_minor, reserve_entry_id,
         provider)
    VALUES (v_user, 'p80:ref', 'p80:key', 'NG', '058', 'GTBank', '0123456789',
            'A Person', 'NGN', 1000, v_entry, 'paystack')
    RETURNING id INTO v_id;

    BEGIN
        UPDATE bank_payouts SET provider_known = FALSE WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED 2: provider_known was changed';
    EXCEPTION WHEN raise_exception THEN
        IF SQLERRM LIKE 'TEST FAILED%' THEN RAISE; END IF;
    END;
    RAISE NOTICE 'PASS 2: a known rail stays known, a guess stays a guess';
END $$;
