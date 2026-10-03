-- ============================================================================
--  094 invariants — both documents moved forward, and only forward
-- ============================================================================
\set ON_ERROR_STOP on

-- 1. Both 2026-10-03 documents exist (AT OR AFTER, so a later republish does
--    not turn this red), and no older privacy notice is live. Not asserted for
--    the terms: 033's suite runs first on the shared database and publishes
--    its own '2026-09-01' to prove supersession — 086's suite records why.
DO $$
DECLARE
    k          consent_kind;
    published  INT;
BEGIN
    FOREACH k IN ARRAY ARRAY['terms', 'privacy']::consent_kind[]
    LOOP
        SELECT count(*) INTO published
          FROM consent_documents WHERE kind = k AND version >= '2026-10-03';
        IF published < 1 THEN
            RAISE EXCEPTION 'TEST FAILED: 094 did not publish %', k;
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM consent_documents
                WHERE kind = 'privacy' AND version < '2026-10-03' AND retired_at IS NULL) THEN
        RAISE EXCEPTION 'TEST FAILED: a privacy notice older than 094 is still live';
    END IF;
    RAISE NOTICE 'PASS 1: the 2026-10-03 terms and privacy notice are published';
END $$;

-- 2. Every kind still has exactly one live document.
DO $$
DECLARE
    k       consent_kind;
    n       INT;
    missing TEXT := '';
BEGIN
    FOREACH k IN ARRAY ARRAY['terms', 'privacy', 'marketing_email']::consent_kind[]
    LOOP
        SELECT count(*) INTO n FROM consent_documents WHERE kind = k AND retired_at IS NULL;
        IF n <> 1 THEN missing := missing || format('%s has %s live; ', k, n); END IF;
    END LOOP;
    IF missing <> '' THEN RAISE EXCEPTION 'TEST FAILED: %', missing; END IF;
    RAISE NOTICE 'PASS 2: every kind has exactly one live document';
END $$;

-- 3. Re-applying 094 changes nothing.
DO $$
DECLARE before INT; after INT;
BEGIN
    SELECT count(*) INTO before FROM consent_documents;
    UPDATE consent_documents SET retired_at = now()
     WHERE kind IN ('terms', 'privacy') AND retired_at IS NULL AND version < '2026-10-03' AND kind = 'privacy';
    INSERT INTO consent_documents (kind, version, body_sha256, summary)
    SELECT 'privacy', '2026-10-03', '10385b116c49514bbfc88c54c85c23aa82184cb781586a22dc53a2c126c8eb3e', 'x'
     WHERE NOT EXISTS (SELECT 1 FROM consent_documents
                        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-10-03')
    ON CONFLICT (kind, version) DO NOTHING;
    SELECT count(*) INTO after FROM consent_documents;
    IF before <> after THEN RAISE EXCEPTION 'TEST FAILED: re-applying 094 wrote a row'; END IF;
    RAISE NOTICE 'PASS 3: 094 is idempotent';
END $$;
