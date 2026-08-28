-- ===========================================================================
--  Xetral — consent invariants
--  packages/ledger/sql/033_consent.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p33-alice@example.ng', 'active'),
  ('p33-bob@example.ng', 'active');

-- Agreement to the documents currently published, the way registration
-- records it.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    INSERT INTO consent_records (user_id, document_id, kind, granted, source, ip)
    SELECT v_u, d.id, d.kind, TRUE, 'registration', '102.89.1.1'::inet
      FROM consent_documents d
     WHERE d.retired_at IS NULL AND d.kind <> 'marketing_email';
END $$;

\echo '=== 1. A WITHDRAWAL IS A NEW ROW, never an edit ==='
-- The whole design. If granting could be erased, "had they consented on the
-- day we mailed them?" becomes a claim about the present rather than about
-- history — and that is exactly the question asked after the fact.
DO $$
DECLARE v_u BIGINT; v_doc BIGINT; v_rows INT; v_granted BOOLEAN;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'marketing_email' AND retired_at IS NULL;

    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'marketing_email', TRUE, 'settings');
    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'marketing_email', FALSE, 'settings');

    SELECT count(*) INTO v_rows FROM consent_records
     WHERE user_id = v_u AND kind = 'marketing_email';
    IF v_rows <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: withdrawing left % row(s), not both', v_rows;
    END IF;

    SELECT granted INTO v_granted FROM customer_consents
     WHERE user_id = v_u AND kind = 'marketing_email';
    IF v_granted THEN
        RAISE EXCEPTION 'TEST FAILED: the view still reports a live grant';
    END IF;
    RAISE NOTICE 'PASS: the grant is still on record and no longer in force';
END $$;

\echo '=== 2. A record cannot be REWRITTEN ==='
DO $$
BEGIN
    UPDATE consent_records SET granted = TRUE
     WHERE user_id = (SELECT id FROM users WHERE email = 'p33-alice@example.ng');
    RAISE EXCEPTION 'TEST FAILED: a consent record was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: what somebody answered is immutable';
END $$;

\echo '=== 3. A record cannot be DELETED ==='
-- A trail a query can prune is a trail an intruder can prune, and this one is
-- the evidence that processing had a basis at all.
DO $$
BEGIN
    DELETE FROM consent_records
     WHERE user_id = (SELECT id FROM users WHERE email = 'p33-alice@example.ng');
    RAISE EXCEPTION 'TEST FAILED: a consent record was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a consent cannot be made to disappear';
END $$;

\echo '=== 4. MARKETING CANNOT BE BUNDLED INTO SIGNING UP ==='
-- Consent must be specific and freely given, so one "I agree" covering the
-- terms and a mailing list is not consent to the mailing list. A CHECK, not
-- an endpoint that remembers.
DO $$
DECLARE v_u BIGINT; v_doc BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-bob@example.ng';
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'marketing_email' AND retired_at IS NULL;

    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'marketing_email', TRUE, 'registration');
    RAISE EXCEPTION 'TEST FAILED: a mailing list was bundled into registration';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: opting in is its own act';
END $$;

\echo '=== 5. Only MARKETING can be withdrawn ==='
-- The asymmetry is a statement rather than an omission: withdrawing the terms
-- means closing the account, which moves money and has its own path.
-- Recording it here would leave a customer holding a balance under terms they
-- are recorded as having refused.
DO $$
DECLARE v_u BIGINT; v_doc BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'terms' AND retired_at IS NULL;

    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'terms', FALSE, 'settings');
    RAISE EXCEPTION 'TEST FAILED: the terms were withdrawn and the account kept';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: refusing the terms is not something this table can say';
END $$;

\echo '=== 6. A record cannot name a document of another KIND ==='
-- One mistyped id would otherwise record somebody as having agreed to the
-- privacy notice by reading the terms.
DO $$
DECLARE v_u BIGINT; v_doc BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-bob@example.ng';
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'terms' AND retired_at IS NULL;

    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'privacy', TRUE, 'settings');
    RAISE EXCEPTION 'TEST FAILED: a privacy consent named the terms';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: a record names the document it is about';
END $$;

\echo '=== 7. A published document is IMMUTABLE ==='
-- Editing one in place silently rewrites what every past customer is recorded
-- as having agreed to — the gift card rate card lesson, applied to something
-- a court would read.
DO $$
BEGIN
    UPDATE consent_documents SET body_sha256 = repeat('a', 64) WHERE kind = 'terms';
    RAISE EXCEPTION 'TEST FAILED: the words somebody agreed to were changed under them';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: retire and republish, never edit';
END $$;

\echo '=== 8. ONE live document per kind ==='
-- A second makes "the current terms" ambiguous, and every consent recorded
-- against it unanswerable.
DO $$
BEGIN
    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    VALUES ('terms', '2026-09-01', repeat('b', 64), 'a second live copy');
    RAISE EXCEPTION 'TEST FAILED: two terms documents are live at once';
EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'PASS: there is exactly one current version';
END $$;

\echo '=== 9. Republishing puts everyone back on the OUTSTANDING list ==='
-- A change nobody was asked about is a change nobody agreed to. Without this
-- view the only evidence would be an absence nobody thinks to query.
DO $$
DECLARE v_u BIGINT; v_before INT; v_after INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';

    SELECT count(*) INTO v_before FROM consent_outstanding
     WHERE user_id = v_u AND kind = 'terms';
    IF v_before <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: a customer who agreed is listed as outstanding';
    END IF;

    UPDATE consent_documents SET retired_at = now()
     WHERE kind = 'terms' AND retired_at IS NULL;
    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    VALUES ('terms', '2026-09-01', repeat('c', 64), 'the September terms');

    SELECT count(*) INTO v_after FROM consent_outstanding
     WHERE user_id = v_u AND kind = 'terms';
    IF v_after <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: republishing asked nobody again';
    END IF;
    RAISE NOTICE 'PASS: new words need a new answer';
END $$;

\echo '=== 10. And their old consent still says what it said ==='
-- `covers_current` is the honest reading: they agreed, but to different
-- words. Collapsing that into "agreed" is how a superseded consent gets
-- treated as a current one.
DO $$
DECLARE v_u BIGINT; v_covers BOOLEAN; v_version TEXT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    SELECT covers_current, version INTO v_covers, v_version
      FROM customer_consents WHERE user_id = v_u AND kind = 'terms';

    IF v_covers THEN
        RAISE EXCEPTION 'TEST FAILED: a superseded consent reads as current';
    END IF;
    IF v_version <> '2026-08-25' THEN
        RAISE EXCEPTION 'TEST FAILED: the record names % rather than what they read', v_version;
    END IF;
    RAISE NOTICE 'PASS: the record says which words, not just yes';
END $$;

\echo '=== 11. A retired document cannot be brought BACK ==='
DO $$
BEGIN
    UPDATE consent_documents SET retired_at = NULL
     WHERE kind = 'terms' AND version = '2026-08-25';
    RAISE EXCEPTION 'TEST FAILED: a superseded document was made current again';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: retirement is final';
END $$;

\echo '=== 12. Marketing mail is REFUSED without a live grant ==='
-- A consent that gates nothing is a checkbox. By TRIGGER on the outbox, so no
-- flow can skip it by forgetting -- the reason `crypto_enabled` was a row
-- nothing read.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    -- Alice granted and then withdrew in block 1.
    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (v_u, 'transfer_sent', 'marketing', 'p33-alice@example.ng',
            'v1:sealed', 'p33:marketing-1');
    RAISE EXCEPTION 'TEST FAILED: marketing was queued to somebody who opted out';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: opting out stops the email';
END $$;

\echo '=== 13. And it is ALLOWED with one ==='
-- The other half. A gate that refuses everything is not a gate, and only
-- proving the refusal would leave that indistinguishable.
DO $$
DECLARE v_u BIGINT; v_doc BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-bob@example.ng';
    SELECT id INTO v_doc FROM consent_documents
     WHERE kind = 'marketing_email' AND retired_at IS NULL;

    INSERT INTO consent_records (user_id, document_id, kind, granted, source)
    VALUES (v_u, v_doc, 'marketing_email', TRUE, 'settings');

    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (v_u, 'transfer_sent', 'marketing', 'p33-bob@example.ng',
            'v1:sealed', 'p33:marketing-2');

    SELECT count(*) INTO v_n FROM notification_outbox
     WHERE idempotency_key = 'p33:marketing-2';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a consented customer was refused';
    END IF;
    RAISE NOTICE 'PASS: consent lets the message through';
END $$;

\echo '=== 14. Security mail reaches somebody who opted out of everything ==='
-- A password reset is not marketing. Gating it on a mailing-list preference
-- would lock a customer out of their own money for unsubscribing.
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p33-alice@example.ng';
    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (v_u, 'password_reset', 'security', 'p33-alice@example.ng',
            'v1:sealed', 'p33:security-1');

    SELECT count(*) INTO v_n FROM notification_outbox
     WHERE idempotency_key = 'p33:security-1';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a reset link was withheld over a mailing list';
    END IF;
    RAISE NOTICE 'PASS: unsubscribing does not lock you out';
END $$;

\echo '=== 15. Marketing to NOBODY is refused ==='
-- The outbox permits a null user because a reset for an unknown address must
-- still be recorded. There is no equivalent case for marketing, and a null
-- there would slip straight past a consent check that reads a user id.
DO $$
BEGIN
    INSERT INTO notification_outbox
      (user_id, kind, class, recipient, payload_sealed, idempotency_key)
    VALUES (NULL, 'transfer_sent', 'marketing', 'stranger@example.ng',
            'v1:sealed', 'p33:marketing-3');
    RAISE EXCEPTION 'TEST FAILED: marketing was queued to an unidentified address';
EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS: there is nobody to have consented';
END $$;

\echo '=== 16. Both tables have a retention DECISION ==='
-- 019 fails the build on an UNDECIDED table. Evidence that processing had a
-- basis has to outlive the processing, so a consent deleted on a schedule is
-- a consent that cannot be demonstrated exactly when somebody asks.
DO $$
DECLARE v_n INT;
BEGIN
    SELECT count(*) INTO v_n FROM retention_decisions
     WHERE table_name IN ('consent_records', 'consent_documents') AND decision = 'keep';
    IF v_n <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: consent evidence can be deleted on a schedule';
    END IF;
    RAISE NOTICE 'PASS: the evidence is kept, deliberately';
END $$;
