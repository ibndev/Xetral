-- ===========================================================================
--  Xetral — invariants for 058_payment_links.sql
--  Every block prints PASS. A TEST FAILED means a control is not wired up.
-- ===========================================================================

\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. EVERY CUSTOMER GETS A LINK, WITHOUT ASKING
--
-- The failure this replaces: minting on first read meant a GET that wrote, and
-- a customer who never opened the screen had no link at all — so "your payment
-- link" was a promise the account could not keep.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    slug TEXT;
BEGIN
    INSERT INTO users (email, status) VALUES ('paylink-1@xetral.test', 'active')
    RETURNING id INTO uid;

    SELECT p.slug INTO slug FROM payment_links p WHERE p.user_id = uid;
    IF slug IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED 1: a new customer has no payment link';
    END IF;
    IF slug !~ '^[a-z0-9]{8,32}$' THEN
        RAISE EXCEPTION 'TEST FAILED 1: the slug % is not the shape the CHECK allows', slug;
    END IF;

    RAISE NOTICE 'PASS 1: every customer is minted a payment link on insert';
END $$;

-- ---------------------------------------------------------------------------
-- 2. A SLUG IS NOT A PHONE NUMBER OR AN ADDRESS
--
-- The CHECK is what makes that structural. A link is forwarded and cannot be
-- recalled, so a well-meaning INSERT putting an identifier in this column
-- publishes it to whoever the link reaches, for ever.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
BEGIN
    SELECT id INTO uid FROM users WHERE email = 'paylink-1@xetral.test';

    BEGIN
        UPDATE payment_links SET slug = '+2348031234567' WHERE user_id = uid;
        RAISE EXCEPTION 'TEST FAILED 2: a phone number was accepted as a slug';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE payment_links SET slug = 'ayinde@example.ng' WHERE user_id = uid;
        RAISE EXCEPTION 'TEST FAILED 2: an email address was accepted as a slug';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 2: a slug can only be a slug';
END $$;

-- ---------------------------------------------------------------------------
-- 3. TWO CUSTOMERS NEVER SHARE A LINK
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    mine TEXT;
    other BIGINT;
BEGIN
    SELECT p.slug INTO mine FROM payment_links p
      JOIN users u ON u.id = p.user_id WHERE u.email = 'paylink-1@xetral.test';

    INSERT INTO users (email, status) VALUES ('paylink-2@xetral.test', 'active')
    RETURNING id INTO other;

    BEGIN
        UPDATE payment_links SET slug = mine WHERE user_id = other;
        RAISE EXCEPTION 'TEST FAILED 3: two customers hold one payment link';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 3: a payment link belongs to exactly one customer';
END $$;

-- ---------------------------------------------------------------------------
-- 4. THE PUBLIC VIEW SAYS WHO, AND NOTHING ELSE
--
-- `payable_handles` makes the same decision for the same reason: a resolver
-- that answers more than "this link is real and it pays this person" is a
-- harvester with a nice URL.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    cols TEXT;
BEGIN
    SELECT string_agg(column_name, ',' ORDER BY column_name) INTO cols
      FROM information_schema.columns WHERE table_name = 'payable_links';

    IF cols ~ '(^|,)(email|phone|bvn)' THEN
        RAISE EXCEPTION 'TEST FAILED 4: the public link view carries contact detail (%)', cols;
    END IF;

    RAISE NOTICE 'PASS 4: the public view carries a name and a currency and no way to reach anybody';
END $$;

-- ---------------------------------------------------------------------------
-- 5. A CLOSED ACCOUNT'S LINK STOPS WORKING
--
-- Rather than taking money we would then have to send back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    theirs TEXT;
    found INT;
BEGIN
    SELECT u.id, p.slug INTO uid, theirs FROM users u
      JOIN payment_links p ON p.user_id = u.id
     WHERE u.email = 'paylink-2@xetral.test';

    UPDATE users SET status = 'closed' WHERE id = uid;

    SELECT count(*) INTO found FROM payable_links WHERE slug = theirs;
    IF found <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED 5: a closed account is still collecting payments';
    END IF;

    RAISE NOTICE 'PASS 5: a closed account''s link resolves to nobody';
END $$;

-- ---------------------------------------------------------------------------
-- 6. A PAID PAYMENT NAMES ITS ENTRY, AND IS FINAL
--
-- The CHECK is what stops "paid" and "credited" being two different answers to
-- one question; the trigger is what stops a credited payment being credited
-- again.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    lid BIGINT;
    eid BIGINT;
BEGIN
    SELECT u.id, p.id INTO uid, lid FROM users u
      JOIN payment_links p ON p.user_id = u.id
     WHERE u.email = 'paylink-1@xetral.test';

    INSERT INTO link_payments (reference, link_id, user_id, amount_minor, currency)
    VALUES ('xetpay:test-1', lid, uid, 500000, 'NGN');

    -- Paid with no entry is refused: the two must not be able to disagree.
    BEGIN
        UPDATE link_payments SET status = 'paid' WHERE reference = 'xetpay:test-1';
        RAISE EXCEPTION 'TEST FAILED 6: a payment was marked paid with no entry';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    INSERT INTO journal_entries (kind, idempotency_key, description, occurred_at)
    VALUES ('wallet_funding', 'test:058-link-payment', 'link payment', now())
    RETURNING id INTO eid;

    UPDATE link_payments SET status = 'paid', entry_id = eid, paid_at = now()
     WHERE reference = 'xetpay:test-1';

    -- And it is final. A second credit is the whole failure this rail has to
    -- not have.
    BEGIN
        UPDATE link_payments SET status = 'abandoned' WHERE reference = 'xetpay:test-1';
        RAISE EXCEPTION 'TEST FAILED 6: a paid payment was reopened';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 6: a paid payment names its entry and cannot be reopened';
END $$;

-- ---------------------------------------------------------------------------
-- 7. THE AMOUNT CANNOT MOVE AFTER THE PAYER HAS SEEN IT
--
-- The row is written BEFORE the payer is sent to Paystack. If the amount could
-- change between then and the credit, the number they agreed to and the number
-- we post would be different numbers.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    lid BIGINT;
BEGIN
    SELECT u.id, p.id INTO uid, lid FROM users u
      JOIN payment_links p ON p.user_id = u.id
     WHERE u.email = 'paylink-1@xetral.test';

    INSERT INTO link_payments (reference, link_id, user_id, amount_minor, currency)
    VALUES ('xetpay:test-2', lid, uid, 100000, 'NGN');

    BEGIN
        UPDATE link_payments SET amount_minor = 900000 WHERE reference = 'xetpay:test-2';
        RAISE EXCEPTION 'TEST FAILED 7: the amount of a pending payment was changed';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    BEGIN
        UPDATE link_payments SET user_id = uid + 1 WHERE reference = 'xetpay:test-2';
        RAISE EXCEPTION 'TEST FAILED 7: a payment was pointed at another customer';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 7: the amount and the payee of a payment are immutable';
END $$;

-- ---------------------------------------------------------------------------
-- 8. A ZERO OR NEGATIVE PAYMENT IS NOT A PAYMENT
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    uid BIGINT;
    lid BIGINT;
BEGIN
    SELECT u.id, p.id INTO uid, lid FROM users u
      JOIN payment_links p ON p.user_id = u.id
     WHERE u.email = 'paylink-1@xetral.test';

    BEGIN
        INSERT INTO link_payments (reference, link_id, user_id, amount_minor, currency)
        VALUES ('xetpay:test-3', lid, uid, 0, 'NGN');
        RAISE EXCEPTION 'TEST FAILED 8: a zero payment was accepted';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS 8: a payment is for a positive amount or it is not a payment';
END $$;
