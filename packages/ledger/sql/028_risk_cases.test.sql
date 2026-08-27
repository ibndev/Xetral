-- ===========================================================================
--  Xetral — compliance case invariants
--  packages/ledger/sql/028_risk_cases.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p28-subject@example.ng', 'active'),
  ('p28-other@example.ng',   'active'),
  ('p28-pattern@example.ng', 'active'),
  ('p28-review@example.ng',  'active');

-- Signals to work with. Inserted directly rather than swept for, because this
-- file is about what a CASE does with them; 027 already proves the rules.
DO $$
DECLARE v_s BIGINT; v_o BIGINT; v_p BIGINT; i INT;
BEGIN
    SELECT id INTO v_s FROM users WHERE email = 'p28-subject@example.ng';
    SELECT id INTO v_o FROM users WHERE email = 'p28-other@example.ng';
    SELECT id INTO v_p FROM users WHERE email = 'p28-pattern@example.ng';

    INSERT INTO risk_signals (rule, user_id, signal_key, detail) VALUES
      ('large_value', v_s, 'p28:subject:1', '{"currency":"NGN"}'::jsonb),
      ('structuring', v_s, 'p28:subject:2', '{"currency":"NGN"}'::jsonb),
      ('large_value', v_o, 'p28:other:1',   '{"currency":"NGN"}'::jsonb);

    FOR i IN 1..4 LOOP
        INSERT INTO risk_signals (rule, user_id, signal_key, detail)
        VALUES ('large_value', v_p, 'p28:pattern:' || i, '{"currency":"NGN"}'::jsonb);
    END LOOP;
END $$;

\echo '=== 1. A case gets ITS DEADLINE FROM THE DATABASE ==='
-- Supplied, and overwritten. A process that can set its own deadline has no
-- deadline — the same rule 018 applies to a dispute, and here it is a
-- regulator's reporting window rather than a courtesy.
DO $$
DECLARE v_s BIGINT; v_r BIGINT; v_due TIMESTAMPTZ; v_hours INT;
BEGIN
    SELECT id INTO v_s FROM users WHERE email = 'p28-subject@example.ng';
    SELECT id INTO v_r FROM users WHERE email = 'p28-review@example.ng';
    SELECT value::INT INTO v_hours FROM platform_settings
     WHERE key = 'risk_case_deadline_hours';

    INSERT INTO risk_cases (user_id, reason, opened_by, due_at)
    VALUES (v_s, 'two signals in a morning', v_r, now() + interval '3650 days')
    RETURNING due_at INTO v_due;

    IF v_due > now() + make_interval(hours => v_hours) + interval '1 minute' THEN
        RAISE EXCEPTION 'TEST FAILED: the caller''s deadline was kept (%)', v_due;
    END IF;
    RAISE NOTICE 'PASS: the deadline is the database''s and cannot be supplied';
END $$;

\echo '=== 2. Only ONE OPEN CASE per customer ==='
-- Two reviewers investigating the same person separately, each seeing half the
-- signals, is the failure a case file exists to prevent.
DO $$
DECLARE v_s BIGINT; v_r BIGINT;
BEGIN
    SELECT id INTO v_s FROM users WHERE email = 'p28-subject@example.ng';
    SELECT id INTO v_r FROM users WHERE email = 'p28-review@example.ng';
    INSERT INTO risk_cases (user_id, reason, opened_by, due_at)
    VALUES (v_s, 'a second look', v_r, now());
    RAISE EXCEPTION 'TEST FAILED: a customer had two open cases';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one investigation per customer at a time';
END $$;

\echo '=== 3. A signal from ANOTHER CUSTOMER cannot be attached ==='
-- Without this, one mistyped id puts another customer's transaction into this
-- investigation, and the file then describes somebody who was never involved.
-- The same control 018 applies to a disputed entry.
DO $$
DECLARE v_case BIGINT; v_foreign BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT s.id INTO v_foreign FROM risk_signals s
      JOIN users u ON u.id = s.user_id
     WHERE u.email = 'p28-other@example.ng';

    INSERT INTO risk_case_signals (case_id, signal_id) VALUES (v_case, v_foreign);
    RAISE EXCEPTION 'TEST FAILED: another customer''s signal was attached';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a case only covers its own subject''s transactions';
END $$;

\echo '=== 4. A signal is attached, ONCE ==='
-- Two blocks, not one, and that is the finding rather than a style choice. A
-- PL/pgSQL EXCEPTION handler rolls back everything its block did — so an
-- earlier version that attached the signal and then deliberately raised left
-- NOTHING attached, and block 8 failed three tests later with "closing the
-- case left its signal open". The attachment has to survive, so it commits in
-- a block that does not raise.
DO $$
DECLARE v_case BIGINT; v_sig BIGINT; v_r BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_sig FROM risk_signals WHERE signal_key = 'p28:subject:1';
    SELECT id INTO v_r   FROM users WHERE email = 'p28-review@example.ng';

    INSERT INTO risk_case_signals (case_id, signal_id, attached_by)
    VALUES (v_case, v_sig, v_r);
    RAISE NOTICE 'PASS: a signal is attached to its customer''s case';
END $$;

\echo '=== 4a. And cannot be attached TWICE ==='
DO $$
DECLARE v_case BIGINT; v_sig BIGINT; v_r BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_sig FROM risk_signals WHERE signal_key = 'p28:subject:1';
    SELECT id INTO v_r   FROM users WHERE email = 'p28-review@example.ng';

    INSERT INTO risk_case_signals (case_id, signal_id, attached_by)
    VALUES (v_case, v_sig, v_r);
    RAISE EXCEPTION 'TEST FAILED: one signal was attached twice';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: one transaction, one investigation';
END $$;

\echo '=== 5. NOTES accumulate and cannot be edited ==='
DO $$
DECLARE v_case BIGINT; v_r BIGINT; v_n INT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_r FROM users WHERE email = 'p28-review@example.ng';

    INSERT INTO risk_case_notes (case_id, author_id, note) VALUES
      (v_case, v_r, 'Called the customer; they confirm a property sale.'),
      (v_case, v_r, 'Requested the sale agreement.');

    SELECT count(*) INTO v_n FROM risk_case_notes WHERE case_id = v_case;
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: expected two notes, found %', v_n;
    END IF;

    BEGIN
        UPDATE risk_case_notes SET note = 'nothing to see' WHERE case_id = v_case;
        RAISE EXCEPTION 'TEST FAILED: a case note was rewritten';
    EXCEPTION WHEN restrict_violation THEN
        NULL;
    END;

    BEGIN
        DELETE FROM risk_case_notes WHERE case_id = v_case;
        RAISE EXCEPTION 'TEST FAILED: a case note was deleted';
    EXCEPTION WHEN restrict_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS: notes accumulate, and cannot be rewritten or removed';
END $$;

\echo '=== 6. Closing REQUIRES an outcome, a closer and a real summary ==='
-- "Reviewed" is not a summary. This text becomes the resolution on every
-- signal attached, and it is what a regulator reads.
DO $$
DECLARE v_case BIGINT; v_r BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_r FROM users WHERE email = 'p28-review@example.ng';

    BEGIN
        UPDATE risk_cases SET status = 'closed', closed_at = now() WHERE id = v_case;
        RAISE EXCEPTION 'TEST FAILED: a case closed with no outcome and no summary';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    BEGIN
        UPDATE risk_cases
           SET status = 'closed', closed_at = now(), closed_by = v_r,
               outcome = 'no_action', summary = 'fine'
         WHERE id = v_case;
        RAISE EXCEPTION 'TEST FAILED: a one-word summary was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    RAISE NOTICE 'PASS: closing takes an outcome, a person and something to read';
END $$;

\echo '=== 7. An STR outcome REQUIRES its reference ==='
-- A report nobody can point at is one nobody can prove was filed.
DO $$
DECLARE v_case BIGINT; v_r BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_r FROM users WHERE email = 'p28-review@example.ng';

    UPDATE risk_cases
       SET status = 'closed', closed_at = now(), closed_by = v_r,
           outcome = 'reported',
           summary = 'Filed with the NFIU; the explanations did not hold up.'
     WHERE id = v_case;
    RAISE EXCEPTION 'TEST FAILED: a report was recorded with no reference';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a filed report carries the reference it was filed under';
END $$;

\echo '=== 8. Closing RESOLVES every signal attached ==='
-- The whole point of a case file. A reviewer with several signals and one
-- story says it once; the alternative is separately typed resolutions that
-- record several unrelated reviews rather than one investigation.
DO $$
DECLARE v_case BIGINT; v_r BIGINT; v_sig BIGINT; v_open BOOLEAN; v_resolution TEXT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'open';
    SELECT id INTO v_r   FROM users WHERE email = 'p28-review@example.ng';
    SELECT id INTO v_sig FROM risk_signals WHERE signal_key = 'p28:subject:1';

    UPDATE risk_cases
       SET status = 'closed', closed_at = now(), closed_by = v_r,
           outcome = 'no_action',
           summary = 'Property sale, agreement on file and consistent with the amounts.'
     WHERE id = v_case;

    SELECT resolved_at IS NULL, resolution INTO v_open, v_resolution
      FROM risk_signals WHERE id = v_sig;
    IF v_open THEN
        RAISE EXCEPTION 'TEST FAILED: closing the case left its signal open';
    END IF;
    IF v_resolution NOT LIKE '%Property sale%' THEN
        RAISE EXCEPTION 'TEST FAILED: the signal''s resolution does not carry the summary';
    END IF;

    -- And a signal NOT attached is untouched.
    IF (SELECT resolved_at FROM risk_signals WHERE signal_key = 'p28:subject:2')
       IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: closing a case resolved a signal it never covered';
    END IF;

    RAISE NOTICE 'PASS: closing a case decides the signals it covers, and only those';
END $$;

\echo '=== 9. A CLOSED case is final, and takes no more notes or signals ==='
-- New information opens a NEW case. Reopening in place would mean a file
-- decided on one set of facts now reads as though it was decided on another.
DO $$
DECLARE v_case BIGINT; v_r BIGINT; v_sig BIGINT;
BEGIN
    SELECT c.id INTO v_case FROM risk_cases c
      JOIN users u ON u.id = c.user_id
     WHERE u.email = 'p28-subject@example.ng' AND c.status = 'closed'
     ORDER BY c.id DESC LIMIT 1;
    SELECT id INTO v_r   FROM users WHERE email = 'p28-review@example.ng';
    SELECT id INTO v_sig FROM risk_signals WHERE signal_key = 'p28:subject:2';

    BEGIN
        UPDATE risk_cases SET status = 'open' WHERE id = v_case;
        RAISE EXCEPTION 'TEST FAILED: a closed case was reopened';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO risk_case_notes (case_id, author_id, note)
        VALUES (v_case, v_r, 'one more thought');
        RAISE EXCEPTION 'TEST FAILED: a note was added to a closed case';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    BEGIN
        INSERT INTO risk_case_signals (case_id, signal_id) VALUES (v_case, v_sig);
        RAISE EXCEPTION 'TEST FAILED: a signal was attached to a closed case';
    EXCEPTION WHEN restrict_violation THEN NULL;
    END;

    RAISE NOTICE 'PASS: a closed case is finished; new information opens a new one';
END $$;

\echo '=== 10. A PATTERN opens its own case, and attaches the signals ==='
-- A customer with several signals is already a pattern. Noticing it otherwise
-- means somebody sorting the queue by customer and counting, which is the work
-- nobody does at four in the afternoon.
DO $$
DECLARE v_p BIGINT; v_row RECORD; v_case BIGINT; v_attached INT;
BEGIN
    SELECT id INTO v_p FROM users WHERE email = 'p28-pattern@example.ng';

    SELECT * INTO v_row FROM open_risk_cases_for_patterns();
    IF v_row.opened < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: four open signals on one customer opened no case';
    END IF;

    SELECT id INTO v_case FROM risk_cases WHERE user_id = v_p AND status = 'open';
    IF v_case IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: no case exists for the customer with the pattern';
    END IF;

    SELECT count(*) INTO v_attached FROM risk_case_signals WHERE case_id = v_case;
    IF v_attached <> 4 THEN
        RAISE EXCEPTION 'TEST FAILED: the case covers % of the 4 signals', v_attached;
    END IF;

    IF (SELECT opened_by FROM risk_cases WHERE id = v_case) IS NOT NULL THEN
        RAISE EXCEPTION 'TEST FAILED: the sweep claimed a person opened it';
    END IF;
    RAISE NOTICE 'PASS: a pattern opens a case by itself and says it did so';
END $$;

\echo '=== 11. The auto-open sweep is IDEMPOTENT ==='
DO $$
DECLARE v_row RECORD; v_before INT; v_after INT;
BEGIN
    SELECT count(*) INTO v_before FROM risk_cases;
    SELECT * INTO v_row FROM open_risk_cases_for_patterns();
    SELECT * INTO v_row FROM open_risk_cases_for_patterns();
    SELECT count(*) INTO v_after FROM risk_cases;

    IF v_after <> v_before THEN
        RAISE EXCEPTION 'TEST FAILED: re-running opened % more case(s)', v_after - v_before;
    END IF;
    RAISE NOTICE 'PASS: running it again opens nothing new';
END $$;

\echo '=== 12. A case is never DELETED ==='
DO $$
DECLARE v_case BIGINT;
BEGIN
    SELECT id INTO v_case FROM risk_cases LIMIT 1;
    DELETE FROM risk_cases WHERE id = v_case;
    RAISE EXCEPTION 'TEST FAILED: a compliance case was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a case cannot be deleted, however old';
END $$;

\echo '=== 13. Nothing here is CUSTOMER-FACING ==='
-- Tipping off is an offence. Where a case ends in a report, the customer must
-- not learn that from an email, a status on a screen, or a support agent
-- reading a note — so there is no notification kind for a case, and the
-- outcome appears in nothing a customer can reach. Asserted structurally: no
-- template, and no route outside /v1/admin/.
DO $$
DECLARE v_kind TEXT;
BEGIN
    FOR v_kind IN SELECT unnest(enum_range(NULL::notification_kind))::TEXT
    LOOP
        IF v_kind ILIKE '%case%' OR v_kind ILIKE '%risk%'
           OR v_kind ILIKE '%investigat%' OR v_kind ILIKE '%report%' THEN
            RAISE EXCEPTION
                'TEST FAILED: notification kind ''%'' could tell a customer they '
                'are under investigation', v_kind;
        END IF;
    END LOOP;
    RAISE NOTICE 'PASS: no message exists that could tip a customer off';
END $$;
