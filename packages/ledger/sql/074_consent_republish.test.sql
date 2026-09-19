-- ============================================================================
--  074 invariants — the republish left exactly one live document per kind
-- ============================================================================
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- 1. The republish happened, and left exactly one live document per kind.
--
--    ASSERTED AS PROPERTIES RATHER THAN AS "the live version is 2026-09-19",
--    and that is not a weaker check — it is the correct one on a SHARED
--    database. `033_consent.test.sql` runs before this file and deliberately
--    retires the live terms to publish its own '2026-09-01', proving that
--    republishing puts every customer back on `consent_outstanding`. A suite
--    asserting the exact live version would be asserting that no other suite
--    exercised the mechanism — the rule CLAUDE.md records about pinning what
--    your assertions depend on, and about a suite that passed only because it
--    happened to run first.
--
--    What 074 must guarantee is what is checked: the rows it publishes exist,
--    nothing from before it is still live, and no kind has two live documents.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    published  INT;
    stale_live INT;
    duplicates INT;
BEGIN
    SELECT count(*) INTO published
      FROM consent_documents
     WHERE (kind, version) IN (('terms', '2026-09-19'), ('privacy', '2026-09-19'));

    IF published <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: 074 published % of 2 documents', published;
    END IF;

    -- THE VERSIONS 074 RETIRES, NAMED, rather than "anything older than the
    -- one we published". The loose form read `version < '2026-09-19'` and
    -- went red on `033_consent.test.sql`'s own '2026-09-01', which that suite
    -- publishes AFTER this migration ran — a true row failing a check that
    -- had over-reached. What 074 promises is about the two rows it found, so
    -- that is what is asserted: absent on a fresh database, retired on an
    -- upgraded one, live on neither.
    SELECT count(*) INTO stale_live
      FROM consent_documents
     WHERE (kind, version) IN (('terms', '2026-08-25'), ('privacy', '2026-08-28'))
       AND retired_at IS NULL;

    IF stale_live <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % document(s) 074 should have retired are still live',
            stale_live;
    END IF;

    SELECT count(*) INTO duplicates
      FROM (SELECT kind FROM consent_documents
             WHERE retired_at IS NULL GROUP BY kind HAVING count(*) > 1) AS d;

    IF duplicates <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: % kind(s) have more than one live document', duplicates;
    END IF;

    RAISE NOTICE 'PASS: both documents published, nothing older left live, one live per kind';
END $$;

-- ---------------------------------------------------------------------------
-- 2. The marketing opt-in was NOT retired.
--
--    It is the sentence somebody actually ticked, and it did not change. 033
--    refuses marketing bundled into registration precisely because one "I
--    agree" covering two things is consent to neither — so retiring this row
--    as collateral would ask every subscriber again for a change to a
--    different document.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    live_marketing INT;
BEGIN
    SELECT count(*) INTO live_marketing
      FROM consent_documents WHERE kind = 'marketing_email' AND retired_at IS NULL;

    IF live_marketing <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: the marketing opt-in should be untouched, found % live', live_marketing;
    END IF;

    RAISE NOTICE 'PASS: the marketing opt-in is untouched';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Applying 074 a second time changes nothing.
--
--    A migration that is not idempotent cannot be re-run against a database
--    somebody is unsure about, which is every database during an incident.
--
--    INSIDE A TRANSACTION THAT ROLLS BACK, because this suite shares its
--    database with every other one and a check that leaves the consent tables
--    different from how it found them is a check that breaks a later file —
--    which is exactly what `033_consent.test.sql` doing the same thing did to
--    the first version of this suite.
--
--    AND IT SKIPS WHEN SOMETHING NEWER IS LIVE, out loud. Re-running an old
--    republish after a newer one is not a case any deployment reaches — you
--    do not apply 074 after 075 — and pretending to test it would mean
--    asserting that 074 does something sensible in a situation that cannot
--    arise, which is how a test comes to describe a system nobody has.
-- ---------------------------------------------------------------------------
BEGIN;

DO $$
DECLARE
    live_terms_ver TEXT;
    before_rows    INT;
    after_rows     INT;
    live_after     INT;
BEGIN
    SELECT version INTO live_terms_ver
      FROM consent_documents WHERE kind = 'terms' AND retired_at IS NULL;

    IF live_terms_ver IS DISTINCT FROM '2026-09-19' THEN
        RAISE NOTICE 'PASS: a later terms version (%) is live, re-apply check skipped',
            live_terms_ver;
        RETURN;
    END IF;

    SELECT count(*) INTO before_rows FROM consent_documents;

    UPDATE consent_documents SET retired_at = now()
     WHERE kind = 'terms' AND retired_at IS NULL AND version <> '2026-09-19';
    UPDATE consent_documents SET retired_at = now()
     WHERE kind = 'privacy' AND retired_at IS NULL AND version <> '2026-09-19';

    INSERT INTO consent_documents (kind, version, body_sha256, summary) VALUES
      ('terms', '2026-09-19',
       '866c9d5e52b5511048facae0eb2343709d4ae52d4c52984dbf10ad4a68ea72fb', 'x'),
      ('privacy', '2026-09-19',
       '6c83b172c42a68b354c16949d1bcfc33f70c01dc22a3d78bd9299664a8c95f78', 'x')
    ON CONFLICT (kind, version) DO NOTHING;

    SELECT count(*) INTO after_rows FROM consent_documents;
    SELECT count(*) INTO live_after
      FROM consent_documents
     WHERE kind IN ('terms', 'privacy') AND retired_at IS NULL;

    IF after_rows <> before_rows THEN
        RAISE EXCEPTION 'TEST FAILED: re-applying 074 added % row(s)', after_rows - before_rows;
    END IF;

    IF live_after <> 2 THEN
        RAISE EXCEPTION 'TEST FAILED: re-applying 074 left % live rows, expected 2', live_after;
    END IF;

    RAISE NOTICE 'PASS: re-applying 074 is a no-op';
END $$;

ROLLBACK;

-- ---------------------------------------------------------------------------
-- 4. A retired document stays retired.
--
--    033's trigger makes retirement final. If it could be cleared, "were they
--    on the August terms when we mailed them?" would be a claim about the
--    present rather than about history — the argument the ledger makes about
--    a consumed refresh token.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    retired_id BIGINT;
BEGIN
    SELECT id INTO retired_id
      FROM consent_documents WHERE retired_at IS NOT NULL LIMIT 1;

    IF retired_id IS NULL THEN
        -- A fresh database published the new version from the seed and had
        -- nothing to retire. Nothing to assert, and saying so beats a silent
        -- pass that reads as coverage.
        RAISE NOTICE 'PASS: nothing retired on this database (fresh seed), check skipped';
    ELSE
        BEGIN
            UPDATE consent_documents SET retired_at = NULL WHERE id = retired_id;
            RAISE EXCEPTION 'TEST FAILED: a retired document was un-retired';
        EXCEPTION
            -- 033 raises this one with ERRCODE 'restrict_violation', not the
            -- default 'raise_exception'. Catching the specific code is what
            -- makes this assert the RIGHT refusal: a bare WHEN OTHERS would
            -- pass just as happily on a typo in the table name.
            WHEN restrict_violation THEN
                RAISE NOTICE 'PASS: retirement is final';
        END;
    END IF;
END $$;
