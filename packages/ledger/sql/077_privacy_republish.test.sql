-- ============================================================================
--  077 invariants — the privacy notice moved forward, and only forward
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The 2026-09-23 privacy notice exists, and nothing older than it is live.
--
--    PROPERTIES RATHER THAN "the live version is 2026-09-23", for the reason
--    074's suite records: this database is shared, `033_consent.test.sql`
--    runs first and deliberately republishes to prove the mechanism, and a
--    suite asserting an exact live version is asserting that no other suite
--    exercised it.
--
--    What 077 promises is that the row it publishes exists and that the two
--    versions it supersedes are not live — absent on a fresh database,
--    retired on an upgraded one, live on neither.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    published  INT;
    stale_live INT;
    duplicates INT;
BEGIN
    SELECT count(*) INTO published
      FROM consent_documents WHERE kind = 'privacy' AND version = '2026-09-23';

    IF published <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: 077 did not publish the privacy notice';
    END IF;

    SELECT count(*) INTO stale_live
      FROM consent_documents
     WHERE kind = 'privacy'
       AND version IN ('2026-08-28', '2026-09-19', '2026-09-20')
       AND retired_at IS NULL;

    IF stale_live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % privacy notice(s) 077 supersedes are still live',
            stale_live;
    END IF;

    SELECT count(*) INTO duplicates
      FROM (SELECT kind FROM consent_documents
             WHERE retired_at IS NULL GROUP BY kind HAVING count(*) > 1) AS d;

    IF duplicates <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % kind(s) have more than one live document', duplicates;
    END IF;

    RAISE NOTICE 'PASS: the 2026-09-23 privacy notice is published and supersedes cleanly';
END $$;

-- ---------------------------------------------------------------------------
-- 2. EVERY KIND STILL HAS A LIVE DOCUMENT.
--
--    075's lesson, held again one version on: on a fresh database the seed
--    publishes the CURRENT notice before 074, 075 and 077 run, and each of
--    them must leave it live. Nothing reports a missing one —
--    `consent_outstanding` joins to a current document, so with none it
--    lists nobody, which looks exactly like a queue with nothing in it.
--
--    A COUNT OF ZERO IS THE FAILURE, which is why this is asserted per kind
--    rather than as "some documents are live".
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
-- 3. A republish that is BEHIND what is live does nothing.
--
--    The guard, stated directly. Applying 075 after 077 is not something a
--    deployment does on purpose — but a fresh database does exactly that,
--    because the seed publishes the newest document before any migration
--    runs, and that is the case which was broken.
--
--    INSIDE A TRANSACTION THAT ROLLS BACK, because this file shares its
--    database with every other one and a check that leaves the consent tables
--    different from how it found them breaks a later suite.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    live_before TEXT;
    live_after  TEXT;
    rows_before INT;
    rows_after  INT;
BEGIN
    SELECT version INTO live_before
      FROM consent_documents WHERE kind = 'privacy' AND retired_at IS NULL;
    SELECT count(*) INTO rows_before FROM consent_documents;

    -- 075's statements, verbatim, run against a database 077 has moved past.
    UPDATE consent_documents SET retired_at = now()
     WHERE kind = 'privacy' AND retired_at IS NULL AND version < '2026-09-20';

    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    SELECT 'privacy', '2026-09-20',
           'eb6c32bfbc357c5a8dd85bc3bbe04d3c9f23da7d7bdaf0be6ad3202a3baf6ece', 'x'
     WHERE NOT EXISTS (SELECT 1 FROM consent_documents
                        WHERE kind = 'privacy' AND retired_at IS NULL
                          AND version > '2026-09-20')
    ON CONFLICT (kind, version) DO NOTHING;

    SELECT version INTO live_after
      FROM consent_documents WHERE kind = 'privacy' AND retired_at IS NULL;
    SELECT count(*) INTO rows_after FROM consent_documents;

    IF live_after IS DISTINCT FROM live_before THEN
        RAISE EXCEPTION 'TEST FAILED: an older republish moved the live notice from % to %',
            live_before, live_after;
    END IF;

    IF rows_after <> rows_before THEN
        RAISE EXCEPTION 'TEST FAILED: an older republish added % row(s)',
            rows_after - rows_before;
    END IF;

    RAISE NOTICE 'PASS: a republish behind what is live is a no-op (% stayed live)', live_before;
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- 4. The terms were NOT republished.
--
--    077 changed the privacy notice and nothing else, and retiring a version
--    puts every customer on `consent_outstanding`. Asking somebody to agree
--    again to words that did not change is how that queue stops meaning
--    anything — the same argument 074 makes about the marketing opt-in.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    terms_at_77 INT;
BEGIN
    SELECT count(*) INTO terms_at_77
      FROM consent_documents WHERE kind = 'terms' AND version = '2026-09-23';

    IF terms_at_77 <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: 077 republished the terms, which did not change';
    END IF;

    RAISE NOTICE 'PASS: the terms were left where they were';
END $$;
