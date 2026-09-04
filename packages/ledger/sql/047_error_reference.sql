-- ---------------------------------------------------------------------------
--  047 — Tying the reference on somebody's screen to the failure in the table
--
--  THE GAP THIS CLOSES, and it is a gap in DIAGNOSIS rather than in any flow.
--
--  Every 5xx has been recorded since 015: fingerprinted, counted, with the
--  exception's own sentence in `message`. And the only thing a person ever saw
--  was "Something went wrong. Please try again." — a sentence that is true of
--  every 500 there has ever been. So a report ("Activate Account fails") and
--  the row that explains it were both present, and nothing connected them:
--  the reporter could not say which failure they had hit, and whoever opened
--  the table could not say which row the reporter meant.
--
--  The exception filter now mints a reference for every 5xx — six hex
--  characters, in the body and in the log line. This is the third place it
--  goes, so the number read off a screen finds the row that explains it.
--
--  WHY IT IS `last_reference` AND NOT A HISTORY. `error_events` is
--  FINGERPRINTED: one row per bug, with a count, deliberately, because a row
--  per occurrence is the log 015 exists to avoid. So this column answers
--  "which row is 602a13?" for the most recent occurrence, which is the
--  question somebody actually asks — and never becomes a second, unbounded
--  table of every failure that has ever happened.
--
--  NULLABLE, because rows already exist and a migration that refused to apply
--  over them would be worse than a column that is empty until the next
--  occurrence. The same reasoning 035 records about `created_by` on a price.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE error_events ADD COLUMN IF NOT EXISTS last_reference TEXT;

-- Six lowercase hex characters, and nothing else can be written here. Without
-- the shape check this is a free text column on a table read by everybody on
-- call, and the first person in a hurry puts a sentence in it.
ALTER TABLE error_events DROP CONSTRAINT IF EXISTS error_events_reference_shape;
ALTER TABLE error_events ADD CONSTRAINT error_events_reference_shape
    CHECK (last_reference IS NULL OR last_reference ~ '^[0-9a-f]{6}$');

-- ---------------------------------------------------------------------------
--  The recorder, taking one more argument.
--
--  DEFAULTED, so this migration does not break a running instance mid-deploy:
--  the old two-statement call site keeps working while the new bundle rolls
--  out. An unreferenced occurrence is a real state — it is what every row
--  written before this migration is — so NULL has to be accepted rather than
--  refused.
-- ---------------------------------------------------------------------------
-- THE OLD FIVE-ARGUMENT FUNCTION IS DROPPED, and that is not tidying.
--
-- `CREATE OR REPLACE FUNCTION` replaces a function of the SAME signature and
-- otherwise creates an OVERLOAD. So adding a defaulted sixth parameter leaves
-- BOTH functions in the database, and the previous bundle's five-argument call
-- then matches both — Postgres refuses it with "function record_error(...) is
-- not unique". That is an error inside the error recorder, raised on every
-- 500, during a rolling deploy: the one moment nothing can afford to be
-- reporting nothing.
--
-- Dropped first, so exactly one function exists; the DEFAULT is what keeps the
-- old call site working against it until the new bundle has finished rolling
-- out. Found by a test asserting the five-argument form still works.
DROP FUNCTION IF EXISTS record_error(TEXT, error_severity, TEXT, TEXT, INTEGER);

CREATE OR REPLACE FUNCTION record_error(
    p_fingerprint TEXT,
    p_severity    error_severity,
    p_message     TEXT,
    p_route       TEXT,
    p_status      INTEGER,
    p_reference   TEXT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO error_events (fingerprint, severity, message, route, status_code,
                              last_reference)
    VALUES (p_fingerprint, p_severity, p_message, p_route, p_status, p_reference)
    ON CONFLICT (fingerprint) DO UPDATE
       SET occurrences  = error_events.occurrences + 1,
           last_seen_at = now(),
           resolved_at  = NULL,
           message      = EXCLUDED.message,
           severity     = GREATEST(error_events.severity, EXCLUDED.severity),
           -- COALESCE, so an occurrence that carried no reference does not
           -- erase the one somebody is holding on a screenshot. The reference
           -- is only ever replaced by a newer real one.
           last_reference = COALESCE(EXCLUDED.last_reference, error_events.last_reference)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- `errors_open` is what the dashboard reads, so the reference has to reach it
-- or the column is one more thing only psql can see — which is the whole
-- failure this migration is about.
-- CREATE OR REPLACE on a view may only APPEND columns, and may not reorder
-- or retype the ones already there — so this repeats 015's list verbatim and
-- adds one. Getting that wrong raises "cannot change name of view column",
-- which reads as a corrupt migration rather than as a rule about views.
CREATE OR REPLACE VIEW errors_open AS
SELECT id, fingerprint, severity, message, route, status_code,
       occurrences, first_seen_at, last_seen_at, alerted_at,
       last_reference
  FROM error_events
 WHERE resolved_at IS NULL
 ORDER BY last_seen_at DESC;

COMMIT;
