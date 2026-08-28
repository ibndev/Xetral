-- ===========================================================================
--  Xetral — data rights invariants
--  packages/ledger/sql/034_data_rights.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p34-asker@example.ng', 'active'),
  ('p34-rich@example.ng', 'active'),
  ('p34-watched@example.ng', 'active'),
  ('p34-staff@example.ng', 'active');

\echo '=== 1. The DEADLINE is the database'"'"'s, and cannot be supplied ==='
-- The rule 018 applies to a dispute and 028 to a reporting window. A process
-- that can push its own deadline out has no deadline, and this one is
-- statutory rather than a courtesy.
DO $$
DECLARE v_u BIGINT; v_deadline TIMESTAMPTZ;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-asker@example.ng';

    INSERT INTO data_requests (user_id, kind, deadline_at)
    VALUES (v_u, 'export', now() + interval '10 years')
    RETURNING deadline_at INTO v_deadline;

    IF v_deadline > now() + interval '31 days' THEN
        RAISE EXCEPTION 'TEST FAILED: a caller set its own deadline (%)', v_deadline;
    END IF;
    RAISE NOTICE 'PASS: the window is ours to keep, not theirs to move';
END $$;

\echo '=== 2. And it cannot be moved afterwards ==='
DO $$
BEGIN
    UPDATE data_requests SET deadline_at = now() + interval '1 year'
     WHERE user_id = (SELECT id FROM users WHERE email = 'p34-asker@example.ng');
    RAISE EXCEPTION 'TEST FAILED: a deadline was pushed out';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: the clock does not restart';
END $$;

\echo '=== 3. The setting CANNOT be loosened past what the law allows ==='
-- A deadline an operator can extend is not a deadline. The bound is one-way
-- on purpose: this can only be used to answer faster.
DO $$
BEGIN
    UPDATE platform_settings SET value = '90' WHERE key = 'data_request_response_days';
    RAISE EXCEPTION 'TEST FAILED: the statutory window was extended to 90 days';
EXCEPTION WHEN check_violation OR raise_exception THEN
    RAISE NOTICE 'PASS: the window can be tightened and not relaxed';
END $$;

\echo '=== 4. ONE open request of each kind per customer ==='
-- A second is not a second right; it is the same right asked about twice, and
-- answering them separately produces a record claiming two reviews happened.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-asker@example.ng';
    INSERT INTO data_requests (user_id, kind, deadline_at) VALUES (v_u, 'export', now());
    RAISE EXCEPTION 'TEST FAILED: one customer has two open export requests';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one request, one answer';
END $$;

\echo '=== 5. But the OTHER kind is a different request ==='
-- Asking for a copy and asking for erasure are different rights with
-- different answers, and refusing the second because the first is open would
-- deny one on the strength of the other.
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-asker@example.ng';
    INSERT INTO data_requests (user_id, kind, deadline_at) VALUES (v_u, 'erasure', now());
    SELECT count(*) INTO v_n FROM data_requests WHERE user_id = v_u AND status = 'open';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected an export and an erasure open, found %', v_n;
    END IF;
    RAISE NOTICE 'PASS: two rights, two requests';
END $$;

\echo '=== 6. A resolution must be EXPLAINED ==='
-- For an erasure this is where "we deleted X and must keep Y until Z" is
-- written down, and it is the only part of the answer a regulator can
-- inspect. A queue cleared with one-word outcomes is indistinguishable from
-- one nobody worked.
DO $$
BEGIN
    UPDATE data_requests SET status = 'completed', completed_at = now(), outcome = 'done'
     WHERE user_id = (SELECT id FROM users WHERE email = 'p34-asker@example.ng')
       AND kind = 'export';
    RAISE EXCEPTION 'TEST FAILED: a request was closed with one word';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: an answer has to say what was answered';
END $$;

\echo '=== 7. An outcome is FINAL ==='
-- Reopening a completed erasure describes a second review of a decision
-- already acted on — and the acting half deleted data, so there is nothing
-- left to review.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-asker@example.ng';
    UPDATE data_requests
       SET status = 'completed', completed_at = now(),
           outcome = 'A copy of everything held was sent to the address on file.'
     WHERE user_id = v_u AND kind = 'export';

    UPDATE data_requests SET status = 'open', completed_at = NULL
     WHERE user_id = v_u AND kind = 'export';
    RAISE EXCEPTION 'TEST FAILED: an answered request was reopened';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a new question is a new request';
END $$;

\echo '=== 8. A request cannot be DELETED ==='
-- An erasure request is the one record erasure itself must not remove: the
-- evidence of having complied has to outlive the compliance.
DO $$
BEGIN
    DELETE FROM data_requests
     WHERE user_id = (SELECT id FROM users WHERE email = 'p34-asker@example.ng');
    RAISE EXCEPTION 'TEST FAILED: the evidence of answering was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: that a right was exercised is itself a record';
END $$;

\echo '=== 9. Erasure REFUSES a customer we still owe money to ==='
-- Erasing the person we owe money to does not discharge the debt, it loses
-- the creditor.
--
-- The fixture is in its OWN block, and that is not tidiness: a PL/pgSQL
-- EXCEPTION handler rolls back everything its block did, so seeding and then
-- deliberately raising in one block would undo the postings block 12 checks
-- for — and block 12 would then pass by finding nothing.
DO $$
DECLARE v_u BIGINT; v_w BIGINT; v_f BIGINT; v_e BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-rich@example.ng';

    INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
    VALUES ('customer_wallet', 'user', v_u, 'NGN', 'credit') RETURNING id INTO v_w;

    SELECT id INTO v_f FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_f IS NULL THEN
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('provider_float', 'platform', NULL, 'NGN', 'debit') RETURNING id INTO v_f;
    END IF;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p34:fund', 'wallet_funding', now(), 'seed') RETURNING id INTO v_e;
    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_e, v_w, 500000, 'NGN'), (v_e, v_f, -500000, 'NGN');
END $$;

DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-rich@example.ng';
    PERFORM erase_customer_personal_data(v_u);
    RAISE EXCEPTION 'TEST FAILED: a customer holding N5,000 was erased';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: empty the account first, which is a payment';
END $$;

\echo '=== 10. And a customer under investigation, with the SAME message ==='
-- Tipping off is an offence. A distinguishable refusal is a way to learn you
-- are under review, so the two are deliberately identical.
DO $$
DECLARE v_u BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-watched@example.ng';
    SELECT id INTO v_staff FROM users WHERE email = 'p34-staff@example.ng';
    INSERT INTO risk_cases (user_id, reason, opened_by, due_at)
    VALUES (v_u, 'p34 fixture: an open case', v_staff, now());
END $$;

DO $$
DECLARE v_u BIGINT; v_message TEXT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-watched@example.ng';
    PERFORM erase_customer_personal_data(v_u);
    RAISE EXCEPTION 'TEST FAILED: a customer under investigation was erased';
EXCEPTION WHEN restrict_violation THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    IF v_message <> 'cannot erase a customer with a balance' THEN
        RAISE EXCEPTION 'TEST FAILED: the refusal says why (%), which is tipping off',
            v_message;
    END IF;
    RAISE NOTICE 'PASS: the refusal reveals nothing';
END $$;

\echo '=== 11. Erasure DOES remove how they signed in ==='
DO $$
DECLARE v_u BIGINT; v_n INT; v_erased TEXT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-asker@example.ng';

    INSERT INTO user_credentials (user_id, password_hash) VALUES (v_u, 'v1:hash');
    INSERT INTO sign_in_events (user_id, identifier_hash, outcome, ip)
    VALUES (v_u, repeat('a', 64), 'succeeded', '102.89.1.1');

    v_erased := erase_customer_personal_data(v_u);

    SELECT count(*) INTO v_n FROM user_credentials WHERE user_id = v_u;
    IF v_n <> 0 THEN RAISE EXCEPTION 'TEST FAILED: the password survived erasure'; END IF;

    IF v_erased NOT LIKE '%sign-in credentials%' THEN
        RAISE EXCEPTION 'TEST FAILED: what was erased is not reported back (%)', v_erased;
    END IF;
    RAISE NOTICE 'PASS: what can go, goes — and says so';
END $$;

\echo '=== 11b. But NOT the sign-in history, which ages out instead ==='
-- 019's trigger refuses a DELETE inside the retention window, and it is right
-- to: that table is what somebody reads to reconstruct an incident, so an
-- erasure request that emptied it could be used by the person who committed
-- the takeover to erase the evidence of it. Sign-in events are `purge` — they
-- DO go, on a period the customer can be told — which makes this a "we must
-- keep this until" rather than a refusal.
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email LIKE 'erased+%';
    SELECT count(*) INTO v_n FROM sign_in_events WHERE user_id = v_u;
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected the sign-in to survive, found % row(s)', v_n;
    END IF;

    SELECT count(*) INTO v_n FROM erasure_scope
     WHERE table_name = 'sign_in_events' AND scope = 'erasable';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: nothing says the sign-in history ever goes';
    END IF;
    RAISE NOTICE 'PASS: kept for now, on a period we can name';
END $$;

\echo '=== 12. And does NOT touch the ledger ==='
-- `journal_entries` and `postings` are append-only by trigger and named
-- `keep`. A function that could delete them would be one an intruder could
-- use to erase what they did.
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-rich@example.ng';
    SELECT count(*) INTO v_n FROM postings p
      JOIN accounts a ON a.id = p.account_id
     WHERE a.owner_id = v_u;
    IF v_n = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the fixture has no postings, so this proves nothing';
    END IF;
    RAISE NOTICE 'PASS: the financial record is out of reach';
END $$;

\echo '=== 13. The email becomes a TOMBSTONE, not a null ==='
-- `users.email` is how a duplicate account is refused. A null would let the
-- same address open a second one while the first is still on record.
DO $$
DECLARE v_u BIGINT; v_email TEXT; v_status TEXT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email LIKE 'erased+%';
    IF v_u IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the erased address was nulled rather than replaced';
    END IF;

    SELECT email, status::TEXT INTO v_email, v_status FROM users WHERE id = v_u;
    IF v_email LIKE '%p34-asker%' THEN
        RAISE EXCEPTION 'TEST FAILED: the address is still readable (%)', v_email;
    END IF;
    IF v_status <> 'closed' THEN
        RAISE EXCEPTION 'TEST FAILED: an erased account is still %', v_status;
    END IF;
    RAISE NOTICE 'PASS: the address is gone and the slot is not reusable';
END $$;

\echo '=== 14. `derive` is NOT erasable ==='
-- The first version of this view said it was. A derived table has no
-- independent lifetime, so its fate is its parent's — and every parent here
-- is `keep`. Reading it as erasable would have promised a customer that
-- `account_balances` could be deleted, which is the ledger restated.
DO $$
DECLARE v_scope TEXT;
BEGIN
    SELECT scope INTO v_scope FROM erasure_scope WHERE table_name = 'account_balances';
    IF v_scope IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: account_balances has no stated scope';
    END IF;
    IF v_scope = 'erasable' THEN
        RAISE EXCEPTION 'TEST FAILED: the ledger restated is offered up as erasable';
    END IF;
    RAISE NOTICE 'PASS: a derived table follows its parent';
END $$;

\echo '=== 15. What is RETAINED says why ==='
-- The rationale is what the customer is told, and it comes from the same
-- table the deletion sweep reads — so the promise and the job that keeps it
-- cannot describe different systems.
DO $$
DECLARE v_rationale TEXT;
BEGIN
    SELECT rationale INTO v_rationale FROM erasure_scope
     WHERE table_name = 'journal_entries';
    IF v_rationale IS NULL OR length(v_rationale) < 20 THEN
        RAISE EXCEPTION 'TEST FAILED: nothing explains why the ledger is kept';
    END IF;
    RAISE NOTICE 'PASS: a refusal comes with its reason';
END $$;

\echo '=== 16. An overdue request is VISIBLE ==='
-- A statutory window is one of the few deadlines here with a regulatory
-- consequence rather than an unhappy customer, so the queue is ordered by how
-- close it is rather than by when it arrived.
DO $$
DECLARE v_u BIGINT; v_overdue BOOLEAN;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p34-watched@example.ng';
    INSERT INTO data_requests (user_id, kind, deadline_at) VALUES (v_u, 'export', now());

    SELECT overdue INTO v_overdue FROM data_requests_due
     WHERE user_uuid = (SELECT uuid FROM users WHERE id = v_u) AND kind = 'export';
    IF v_overdue IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: an open request is not in the queue';
    END IF;
    IF v_overdue THEN
        RAISE EXCEPTION 'TEST FAILED: a request made now is already overdue';
    END IF;
    RAISE NOTICE 'PASS: the queue is what somebody works from';
END $$;

\echo '=== 17. data_requests has a retention DECISION ==='
DO $$
DECLARE v_decision TEXT;
BEGIN
    SELECT decision INTO v_decision FROM retention_decisions WHERE table_name = 'data_requests';
    IF v_decision <> 'keep' THEN
        RAISE EXCEPTION 'TEST FAILED: proof of having complied can be deleted';
    END IF;
    RAISE NOTICE 'PASS: that a right was answered is kept';
END $$;

\echo '=== 18. Erasing a customer must SAY WHY ==='
-- It joins 009's destructive list, which is what stands between a privileged
-- action and a log saying only that it happened. This is the one action here
-- that cannot be undone by appending, so it is the last one that should be
-- exempt.
DO $$
DECLARE v_staff BIGINT;
BEGIN
    SELECT id INTO v_staff FROM users WHERE email = 'p34-staff@example.ng';
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, detail)
    VALUES (v_staff, 'data.erase', 'data_request', 'p34', '{}'::jsonb);
    RAISE EXCEPTION 'TEST FAILED: data was erased with no reason recorded';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: the most destructive action explains itself';
END $$;
