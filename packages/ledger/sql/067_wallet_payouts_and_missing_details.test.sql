-- 067 invariants. Every block prints PASS or raises TEST FAILED.
--
-- Run against a freshly migrated database. Not idempotent: the fixtures below
-- insert rows and the file is written to be read in order.

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. A PAYOUT WITH NO BENEFICIARY NAME IS ACCEPTED
--
--    This is the whole of the Ghana and Kenya fix, at the layer that refused
--    it. `account_name` was NOT NULL, a mobile money wallet has no name
--    enquiry on any network, and so the row could not be written — which meant
--    the service refused the payout before the rail was ever asked.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who    BIGINT;
    wallet BIGINT;
    pend   BIGINT;
    flt    BIGINT;
    entry  BIGINT;
    ok     BOOLEAN;
BEGIN
    INSERT INTO users (email, status, full_name, country)
    VALUES ('067-wallet@example.test', 'active', 'Ama Mensah', 'GH')
    RETURNING id INTO who;

    INSERT INTO accounts (kind, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', who, 'GHS', 'credit') RETURNING id INTO wallet;
    INSERT INTO accounts (kind, owner_id, currency, normal_balance)
    VALUES ('customer_pending', who, 'GHS', 'credit') RETURNING id INTO pend;

    SELECT id INTO flt FROM accounts
     WHERE kind = 'provider_float' AND currency = 'GHS' AND owner_id IS NULL;
    IF flt IS NULL THEN
        INSERT INTO accounts (kind, owner_id, currency, normal_balance)
        VALUES ('provider_float', NULL, 'GHS', 'debit') RETURNING id INTO flt;
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('067:fund', 'wallet_funding', '067 fixture', now()) RETURNING id INTO entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (entry, flt, -100000, 'GHS'), (entry, wallet, 100000, 'GHS');

    INSERT INTO journal_entries (idempotency_key, kind, description, occurred_at)
    VALUES ('067:reserve', 'wallet_withdrawal', '067 reserve', now()) RETURNING id INTO entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (entry, wallet, -500, 'GHS'), (entry, pend, 500, 'GHS');

    CREATE TEMP TABLE p67 (user_id BIGINT, reserve_entry BIGINT);
    INSERT INTO p67 VALUES (who, entry);

    INSERT INTO bank_payouts
        (user_id, reference, idempotency_key, country, bank_code, bank_name,
         account_number, account_name, narration, currency, amount_minor,
         reserve_entry_id)
    VALUES
        (who, '067:momo-1', '067-momo-1', 'GH', 'MTN', 'MTN Mobile Money',
         '233501234567', NULL, NULL, 'GHS', 500, entry);

    SELECT account_name IS NULL INTO ok
      FROM bank_payouts WHERE reference = '067:momo-1';
    IF NOT ok THEN
        RAISE EXCEPTION 'TEST FAILED: a wallet payout should hold no beneficiary name';
    END IF;
    RAISE NOTICE 'PASS 1: a mobile money payout is recorded with no beneficiary name';
END $$;

-- ---------------------------------------------------------------------------
-- 2. A NAME THAT IS PRESENT STILL HAS TO BE A NAME
--
--    Nullable is not "anything goes". "We have no name" and "we have a blank
--    name" must not be the same row, or the absence stops meaning anything.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
BEGIN
    SELECT id INTO who FROM users WHERE email = '067-wallet@example.test';
    BEGIN
        INSERT INTO bank_payouts
            (user_id, reference, idempotency_key, country, bank_code, bank_name,
             account_number, account_name, currency, amount_minor, reserve_entry_id)
        VALUES
            (who, '067:blank-1', '067-blank-1', 'GH', 'MTN', 'MTN Mobile Money',
             '233501234567', '   ', 'GHS', 500,
             (SELECT reserve_entry FROM p67));
        RAISE EXCEPTION 'TEST FAILED: a blank beneficiary name was accepted';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'PASS 2: a present beneficiary name must not be blank';
    END;
END $$;

-- ---------------------------------------------------------------------------
-- 3. A BANK PAYOUT STILL RECORDS THE NAME THE BANK RETURNED
--
--    Relaxing the column must not quietly relax the RULE. 043's argument is
--    unchanged where a rail can answer: the name is the bank's, it is stored,
--    and it is what is sent.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who BIGINT;
    nm  TEXT;
BEGIN
    SELECT id INTO who FROM users WHERE email = '067-wallet@example.test';

    INSERT INTO bank_payouts
        (user_id, reference, idempotency_key, country, bank_code, bank_name,
         account_number, account_name, currency, amount_minor, reserve_entry_id)
    VALUES
        (who, '067:bank-1', '067-bank-1', 'NG', '058', 'GTBank',
         '0123456789', 'OLAWALE ADEYEMI', 'NGN', 500000,
         (SELECT reserve_entry FROM p67));

    SELECT account_name INTO nm FROM bank_payouts WHERE reference = '067:bank-1';
    IF nm IS DISTINCT FROM 'OLAWALE ADEYEMI' THEN
        RAISE EXCEPTION 'TEST FAILED: a bank payout lost the name the bank returned';
    END IF;
    RAISE NOTICE 'PASS 3: a bank payout still carries the rail''s own name';
END $$;

-- ---------------------------------------------------------------------------
-- 4. A CUSTOMER WITH NO NUMBER IS COUNTED, AND NOT NAMED
--
--    The failure is silent by construction: the customer sees no error, their
--    Request payment panel is simply empty, and every sender is told there is
--    no such customer. Nothing counted it. The view carries a COUNT and no
--    address, the shape `customers_without_a_country` follows.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    before_count BIGINT;
    after_count  BIGINT;
    cols         INT;
BEGIN
    SELECT customers INTO before_count FROM customers_without_a_phone;

    INSERT INTO users (email, status, country)
    VALUES ('067-nophone@example.test', 'active', 'NG');

    SELECT customers INTO after_count FROM customers_without_a_phone;
    IF after_count <> before_count + 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a customer with no phone was not counted (% -> %)',
            before_count, after_count;
    END IF;

    SELECT count(*) INTO cols
      FROM information_schema.columns
     WHERE table_name = 'customers_without_a_phone'
       AND column_name IN ('email', 'phone', 'full_name', 'uuid');
    IF cols <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the view names customers rather than counting them';
    END IF;
    RAISE NOTICE 'PASS 4: a customer with no number is counted and not named';
END $$;

-- ---------------------------------------------------------------------------
-- 5. THE BACKFILL NEVER OVERWRITES WHAT A CUSTOMER SET
--
--    061's rule: repair, do not assert. A customer who typed their own name
--    keeps it even when an approved submission says something else — that is
--    the whole reason 040 keeps the two columns apart.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who   BIGINT;
    named TEXT;
BEGIN
    INSERT INTO users (email, status, full_name, country, phone)
    VALUES ('067-own@example.test', 'active', 'Wale', 'NG', '+2348030000067')
    RETURNING id INTO who;

    INSERT INTO kyc_submissions
        (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4,
         bvn_fingerprint, address, status, reviewed_by, reviewed_at)
    VALUES
        (who, 'OLAWALE ADEYEMI OF LAGOS', DATE '1990-01-01', '08030000067',
         'v1:sealed', '1234', 'v1:' || repeat('a', 64), '1 Test Street', 'approved',
         (SELECT id FROM users WHERE email = '067-wallet@example.test'), now());

    -- The same statement the migration runs.
    UPDATE users u
       SET full_name = btrim(k.full_name)
      FROM kyc_submissions k
     WHERE k.user_id = u.id AND k.status = 'approved' AND u.full_name IS NULL;

    SELECT full_name INTO named FROM users WHERE id = who;
    IF named IS DISTINCT FROM 'Wale' THEN
        RAISE EXCEPTION 'TEST FAILED: the backfill overwrote a name the customer set (%)', named;
    END IF;
    RAISE NOTICE 'PASS 5: a name the customer set survives the backfill';
END $$;

-- ---------------------------------------------------------------------------
-- 6. A CHECKOUT REFUSAL IS RECORDED WITH ITS RAIL AND WITHOUT THE PAYER
--
--    "Payment error" had its only explanation in a log line written at the
--    moment a stranger pressed a button. The row is where it becomes
--    answerable — and the view carries no payer email, because who the
--    stranger was is not part of diagnosing a credential.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    who  BIGINT;
    link BIGINT;
    seen TEXT;
    cols INT;
BEGIN
    SELECT id INTO who FROM users WHERE email = '067-wallet@example.test';
    SELECT id INTO link FROM payment_links WHERE user_id = who;

    INSERT INTO link_payments
        (reference, link_id, user_id, amount_minor, currency, payer_email, provider,
         refusal_reason)
    VALUES
        ('067-refused-1', link, who, 2500, 'GHS', 'payer@example.test', 'flutterwave',
         'no Flutterwave secret key is configured');

    SELECT refusal_reason INTO seen FROM checkout_refusals WHERE reference = '067-refused-1';
    IF seen IS DISTINCT FROM 'no Flutterwave secret key is configured' THEN
        RAISE EXCEPTION 'TEST FAILED: the rail''s own sentence was not recorded';
    END IF;

    SELECT count(*) INTO cols
      FROM information_schema.columns
     WHERE table_name = 'checkout_refusals'
       AND column_name IN ('payer_email', 'payer_name', 'user_id');
    IF cols <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the refusals view carries the payer';
    END IF;
    RAISE NOTICE 'PASS 6: a checkout refusal records the rail''s reason and not the payer';
END $$;

-- ---------------------------------------------------------------------------
-- 7. BOTH NEW VIEWS ARE CLASSIFIED
--
--    036's guarantee: the queue nobody thought of is the one that silently
--    fills, so an unclassified view fails the build.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing INT;
BEGIN
    SELECT count(*) INTO missing
      FROM (VALUES ('customers_without_a_phone'), ('checkout_refusals')) AS v(name)
     WHERE NOT EXISTS (SELECT 1 FROM attention_sources a WHERE a.source = v.name);
    IF missing > 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % of 067''s views are unclassified', missing;
    END IF;
    RAISE NOTICE 'PASS 7: every view 067 adds is classified';
END $$;
