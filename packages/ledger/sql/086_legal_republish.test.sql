-- ============================================================================
--  086 invariants — both documents moved forward, and only forward
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. Both 2026-09-28 documents exist, and nothing older is live.
--
--    AT OR AFTER, from the start — the lesson every earlier republish suite
--    learned when a later one moved past it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    k          consent_kind;
    published  INT;
    stale_live INT;
BEGIN
    FOREACH k IN ARRAY ARRAY['terms', 'privacy']::consent_kind[]
    LOOP
        SELECT count(*) INTO published
          FROM consent_documents WHERE kind = k AND version >= '2026-09-28';
        IF published < 1 THEN
            RAISE EXCEPTION 'TEST FAILED: 086 did not publish %', k;
        END IF;

        -- NOT FOR THE TERMS. `033_consent.test.sql` runs first on this shared
        -- database and deliberately retires the live terms to publish its own
        -- '2026-09-01', proving a republish puts every customer back on
        -- `consent_outstanding` — so an older terms version being live here is
        -- another suite exercising the mechanism, not 086 failing. 074's suite
        -- records the same. "Exactly one live" below still holds for both.
        SELECT count(*) INTO stale_live
          FROM consent_documents
         WHERE kind = k AND k = 'privacy' AND version < '2026-09-28' AND retired_at IS NULL;
        IF stale_live <> 0 THEN
            RAISE EXCEPTION 'TEST FAILED: % % document(s) older than 086 still live', stale_live, k;
        END IF;
    END LOOP;

    RAISE NOTICE 'PASS: the 2026-09-28 terms and privacy notice are published and supersede cleanly';
END $$;

-- ---------------------------------------------------------------------------
-- 2. EVERY KIND STILL HAS EXACTLY ONE LIVE DOCUMENT.
--
--    A count of zero is the failure nothing else reports: `consent_outstanding`
--    joins to a current document, so with none it lists nobody.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    k       consent_kind;
    n       INT;
    missing TEXT := '';
BEGIN
    FOREACH k IN ARRAY ARRAY['terms', 'privacy', 'marketing_email']::consent_kind[]
    LOOP
        SELECT count(*) INTO n
          FROM consent_documents WHERE kind = k AND retired_at IS NULL;
        IF n <> 1 THEN
            missing := missing || format('%s has %s live; ', k, n);
        END IF;
    END LOOP;

    IF missing <> '' THEN
        RAISE EXCEPTION 'TEST FAILED: %', missing;
    END IF;

    RAISE NOTICE 'PASS: every kind has exactly one live document';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Re-applying 086 is a no-op.
--
--    Inside a transaction that rolls back, because this file shares its
--    database with every other suite.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    rows_before INT;
    rows_after  INT;
BEGIN
    SELECT count(*) INTO rows_before FROM consent_documents;

    -- THE PRIVACY HALF, NOT THE TERMS. `033_consent.test.sql` runs first and
    -- leaves its own '2026-09-01' terms live, so re-applying the terms half
    -- here measured that suite's fixture rather than 086 — it passed only
    -- while the seed happened to carry exactly 086's terms, and went red the
    -- day 094 legitimately moved them on. No other suite moves the privacy
    -- notice, so it is the half that tests 086's own guards.
    UPDATE consent_documents SET retired_at = now()
     WHERE kind = 'privacy' AND retired_at IS NULL AND version < '2026-09-28';

    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    SELECT 'privacy', '2026-09-28',
           '77d0bf612f99ee4ba3f84416ec58492716e726aa4dd640d031debdf7489aec59', 'x'
     WHERE NOT EXISTS (SELECT 1 FROM consent_documents
                        WHERE kind = 'privacy' AND retired_at IS NULL
                          AND version > '2026-09-28')
    ON CONFLICT (kind, version) DO NOTHING;

    SELECT count(*) INTO rows_after FROM consent_documents;

    IF rows_after <> rows_before THEN
        RAISE EXCEPTION 'TEST FAILED: re-applying 086 added % row(s)', rows_after - rows_before;
    END IF;

    RAISE NOTICE 'PASS: re-applying 086 changes nothing';
END $$;

ROLLBACK;
