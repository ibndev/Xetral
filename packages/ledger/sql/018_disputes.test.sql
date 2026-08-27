-- ===========================================================================
--  Xetral — dispute invariant tests
--  packages/ledger/sql/018_disputes.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('dispute-a@example.ng', 'active'),
  ('dispute-b@example.ng', 'active'),
  ('dispute-staff@example.ng', 'active');

-- Two customers with wallets, and a transfer between them to dispute.
DO $$
DECLARE
    v_a BIGINT; v_b BIGINT; v_entry BIGINT;
    v_wa BIGINT; v_wb BIGINT; v_float BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_b FROM users WHERE email = 'dispute-b@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_a, 'NGN', 'credit') RETURNING id INTO v_wa;
    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_b, 'NGN', 'credit') RETURNING id INTO v_wb;

    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('provider_float', 'NGN', 'debit') RETURNING id INTO v_float;
    END IF;

    -- Fund A.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p18:fund', 'wallet_funding', now(), 'seed') RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wa,    100000, 'NGN'),
      (v_entry, v_float, -100000, 'NGN');

    -- The expense account an upheld dispute is paid from. Created here rather
    -- than inside a test, because a DO block that raises rolls back everything
    -- it did — including an account a later block was relying on.
    INSERT INTO accounts (kind, currency, normal_balance)
    VALUES ('expense_dispute_loss', 'NGN', 'debit');

    -- The transfer A -> B that will be disputed.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p18:transfer', 'wallet_transfer', now(), 'the disputed one')
    RETURNING id INTO v_entry;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_entry, v_wa, -50000, 'NGN'),
      (v_entry, v_wb,  50000, 'NGN');
END $$;

\echo '=== 1. A customer cannot dispute an entry they have NO LEG IN ==='
-- THE SECURITY CONTROL. Without it a complaints form is a way to enumerate
-- other people's transactions — raise a dispute against an id and read the
-- answer — and it puts a stranger's entry into a queue staff will then read.
DO $$
DECLARE v_staff BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';

    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_staff, v_entry, 'not_authorised', 'not mine', now());
    RAISE EXCEPTION 'TEST FAILED: a stranger disputed somebody else''s transfer';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a dispute must name an entry the customer was part of';
END $$;

\echo ''
\echo '=== 2. The DEADLINE is the database''s, not the caller''s ==='
-- A deadline the application supplies is one a bug can push into next year,
-- and the value of this table is answering "what is late?" without trusting
-- the code that wrote the row.
DO $$
DECLARE v_a BIGINT; v_entry BIGINT; v_due TIMESTAMPTZ;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';

    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_entry, 'not_authorised', 'I did not send this',
            now() + INTERVAL '10 years')
    RETURNING due_at INTO v_due;

    IF v_due > now() + INTERVAL '73 hours' THEN
        RAISE EXCEPTION 'TEST FAILED: the caller''s deadline was kept (%)', v_due;
    END IF;
    RAISE NOTICE 'PASS: the deadline is stamped from the database clock';
END $$;

\echo ''
\echo '=== 3. ONE live dispute per customer per entry ==='
DO $$
DECLARE v_a BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';

    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_entry, 'duplicate', 'again', now());
    RAISE EXCEPTION 'TEST FAILED: a second live dispute was accepted';
EXCEPTION
    WHEN unique_violation THEN
        RAISE NOTICE 'PASS: one open dispute per entry, so the queue cannot be flooded';
END $$;

\echo ''
\echo '=== 4. ''accepted'' with NO REFUND is refused ==='
-- The failure this catches is a customer told they won and never paid.
DO $$
DECLARE v_id BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_id FROM disputes WHERE status = 'open' LIMIT 1;

    UPDATE disputes
       SET status = 'accepted', resolved_at = now(), resolved_by = v_staff,
           resolution = 'we agree'
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: an accepted dispute with no refund was accepted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: winning a dispute cannot be recorded without the money';
END $$;

\echo ''
\echo '=== 5. ''rejected'' WITH a refund is refused ==='
-- And the other direction: money out the door against a decision that went
-- the other way.
DO $$
DECLARE v_id BIGINT; v_staff BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_id FROM disputes WHERE status = 'open' LIMIT 1;
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';

    UPDATE disputes
       SET status = 'rejected', resolved_at = now(), resolved_by = v_staff,
           resolution = 'we disagree', refund_entry_id = v_entry
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a rejected dispute carried a refund';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a refund exists exactly when the customer won';
END $$;

\echo ''
\echo '=== 6. A resolution must name a REASON and a PERSON ==='
DO $$
DECLARE v_id BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_id FROM disputes WHERE status = 'open' LIMIT 1;

    UPDATE disputes SET status = 'rejected', resolved_at = now(), resolved_by = v_staff
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a dispute was closed with no stated reason';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: an outcome nobody explained cannot be recorded';
END $$;

\echo ''
\echo '=== 7. The refund must CREDIT THE DISPUTING CUSTOMER ==='
-- The CHECK only knows the column is set. A stale or mistyped entry id would
-- otherwise mark a dispute paid against somebody else's money.
DO $$
DECLARE
    v_id BIGINT; v_staff BIGINT; v_b BIGINT; v_wb BIGINT;
    v_loss BIGINT; v_refund BIGINT; v_charge BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_b     FROM users WHERE email = 'dispute-b@example.ng';
    SELECT id INTO v_wb    FROM accounts
     WHERE owner_type = 'user' AND owner_id = v_b AND kind = 'customer_wallet';
    SELECT id, entry_id INTO v_id, v_charge
      FROM disputes WHERE status = 'open' LIMIT 1;

    SELECT id INTO v_loss FROM accounts
     WHERE kind = 'expense_dispute_loss' AND currency = 'NGN';

    -- A real dispute_refund entry, naming the right charge and crediting the
    -- WRONG customer. The target is set deliberately: since 023 an unattached
    -- dispute refund is refused by a CHECK, and a block that tripped over
    -- THAT would report PASS while never reaching the trigger it exists for.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p18:wrong-refund', 'dispute_refund', now(), 'to the wrong person', v_charge)
    RETURNING id INTO v_refund;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_refund, v_wb,    50000, 'NGN'),
      (v_refund, v_loss, -50000, 'NGN');

    UPDATE disputes
       SET status = 'accepted', resolved_at = now(), resolved_by = v_staff,
           resolution = 'we agree', refund_entry_id = v_refund
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a refund to another customer settled this dispute';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: the refund must credit the customer who complained';
END $$;

\echo ''
\echo '=== 8. Accepting POSTS THE REFUND and the entry balances ==='
DO $$
DECLARE
    v_id BIGINT; v_staff BIGINT; v_a BIGINT; v_wa BIGINT;
    v_loss BIGINT; v_refund BIGINT; v_sum BIGINT; v_charge BIGINT; v_status TEXT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'dispute-staff@example.ng';
    SELECT id INTO v_a     FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_wa    FROM accounts
     WHERE owner_type = 'user' AND owner_id = v_a AND kind = 'customer_wallet';
    SELECT id INTO v_loss  FROM accounts WHERE kind = 'expense_dispute_loss' AND currency = 'NGN';
    SELECT id, entry_id INTO v_id, v_charge
      FROM disputes WHERE status = 'open' LIMIT 1;

    -- The refund NAMES THE CHARGE. Before 023 it could not, and the credit
    -- landed in the wallet with nothing in the books saying what it answered.
    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description, reverses_id)
    VALUES ('p18:refund', 'dispute_refund', now(), 'dispute upheld', v_charge)
    RETURNING id INTO v_refund;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_refund, v_wa,    50000, 'NGN'),
      (v_refund, v_loss, -50000, 'NGN');

    UPDATE disputes
       SET status = 'accepted', resolved_at = now(), resolved_by = v_staff,
           resolution = 'CCTV shows the customer was elsewhere',
           refund_entry_id = v_refund
     WHERE id = v_id;

    SET CONSTRAINTS ALL IMMEDIATE;

    SELECT SUM(amount_minor) INTO v_sum FROM postings WHERE journal_entry_id = v_refund;
    IF v_sum <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the refund entry does not balance (%)', v_sum;
    END IF;
    -- And the disputed charge now READS as refunded, which is the whole point
    -- of linking it: a customer seeing a debit and an unexplained credit
    -- cannot tell they are the same event.
    SELECT status INTO v_status FROM entry_status WHERE id = v_charge;
    IF v_status <> 'refunded' THEN
        RAISE EXCEPTION 'TEST FAILED: the refunded charge reads %', v_status;
    END IF;

    RAISE NOTICE 'PASS: an upheld dispute is an APPENDED entry, and it balances';
END $$;

\echo ''
\echo '=== 9. An OUTCOME IS FINAL ==='
-- Reopening an accepted dispute would let the refund be paid twice; reopening
-- a rejected one in place would erase the fact that it was ever refused. A
-- customer with new evidence raises a NEW dispute, and the two rows then tell
-- the whole story rather than the last edit of it.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM disputes WHERE status = 'accepted' LIMIT 1;
    UPDATE disputes SET status = 'open', resolved_at = NULL, resolved_by = NULL,
                        resolution = NULL, refund_entry_id = NULL
     WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a resolved dispute was reopened';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a resolved dispute cannot be reopened in place';
END $$;

\echo ''
\echo '=== 10. A dispute''s IDENTITY is immutable ==='
DO $$
DECLARE v_id BIGINT; v_a BIGINT; v_other BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_other FROM journal_entries WHERE idempotency_key = 'p18:fund';

    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_other, 'wrong_amount', 'this funding is short', now())
    RETURNING id INTO v_id;

    UPDATE disputes SET entry_id = (
        SELECT id FROM journal_entries WHERE idempotency_key = 'p18:transfer'
    ) WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a dispute was re-pointed at a different entry';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: every note written about a dispute stays about the same event';
END $$;

\echo ''
\echo '=== 11. A DEADLINE CANNOT BE MOVED ==='
-- A process that can push its own deadline out has no deadline.
DO $$
DECLARE v_id BIGINT; v_a BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';

    -- Raised here rather than found, and THAT IS THE POINT. Written as a
    -- SELECT for an open dispute, this block passed while updating zero rows —
    -- an earlier block had resolved the only one — so it reported the deadline
    -- as immutable without ever attempting to move one. A test that passes
    -- when the thing it guards is missing is worth less than no test.
    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_entry, 'wrong_amount', 'the amount is wrong', now())
    RETURNING id INTO v_id;

    UPDATE disputes SET due_at = now() + INTERVAL '30 days' WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a dispute deadline was extended';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a late dispute stays late';
END $$;

\echo ''
\echo '=== 12. A dispute is NEVER DELETED ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM disputes LIMIT 1;
    IF v_id IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: no dispute to attempt a delete against';
    END IF;
    DELETE FROM disputes WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a dispute was deleted';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a complaints record nobody can remove is one that can be trusted';
END $$;

\echo ''
\echo '=== 13. An entry OLDER THAN THE WINDOW cannot be disputed ==='
DO $$
DECLARE v_a BIGINT; v_wa BIGINT; v_float BIGINT; v_old BIGINT;
BEGIN
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_wa FROM accounts
     WHERE owner_type = 'user' AND owner_id = v_a AND kind = 'customer_wallet';
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p18:ancient', 'wallet_funding', now() - INTERVAL '400 days', 'long ago')
    RETURNING id INTO v_old;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency) VALUES
      (v_old, v_wa,    1000, 'NGN'),
      (v_old, v_float, -1000, 'NGN');

    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_old, 'not_authorised', 'I never saw this', now());
    RAISE EXCEPTION 'TEST FAILED: a 400-day-old entry was disputed';
EXCEPTION
    WHEN check_violation THEN
        RAISE NOTICE 'PASS: a claim too old for any provider to investigate is refused';
END $$;

\echo ''
\echo '=== 14. The QUEUE shows what is overdue, from the database clock ==='
DO $$
DECLARE v_open INT; v_a BIGINT; v_entry BIGINT;
BEGIN
    -- Its own open row, because every block above that raises rolls its own
    -- back. A queue test that depends on another test's leftovers asserts on
    -- whatever ran last.
    SELECT id INTO v_a FROM users WHERE email = 'dispute-a@example.ng';
    SELECT id INTO v_entry FROM journal_entries WHERE idempotency_key = 'p18:transfer';
    INSERT INTO disputes (user_id, entry_id, reason, detail, due_at)
    VALUES (v_a, v_entry, 'not_received', 'still waiting', now());

    SELECT count(*) INTO v_open FROM disputes_open;
    IF v_open = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: nothing in the open queue to order';
    END IF;
    -- The column exists and is computed, not stored: a row cannot be late in
    -- the table and on time on the screen.
    PERFORM overdue, seconds_remaining FROM disputes_open LIMIT 1;
    RAISE NOTICE 'PASS: the queue reports lateness from now(), not from a stored flag';
END $$;
