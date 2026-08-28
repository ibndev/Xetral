-- ===========================================================================
--  Xetral — error capture
--  packages/ledger/sql/015_error_events.sql
--
--  WHAT THIS IS FOR.
--
--  Every failure in this system currently goes to stdout and then to whatever
--  the container runtime keeps. That is adequate for reading one incident
--  after somebody reports it, and useless for the question that actually
--  matters: is something failing RIGHT NOW that nobody has told us about?
--
--  The audit found five failures that were invisible to the compiler, the unit
--  suites and the e2e suites, and appeared only when the built bundle was
--  started and probed. Each of them would have thrown on a real request. With
--  this table, the FIRST one of those in production is a row, a count and an
--  alert rather than a line nobody read.
--
--  WHY A TABLE RATHER THAN A THIRD-PARTY SERVICE.
--
--  Not a rejection of one — `errors_alert_due` below is the seam a Sentry DSN
--  would plug into. The reason to start here is that an error payload from a
--  fintech contains whatever was in scope when it threw: an account number, a
--  BVN, a customer's balance, sometimes a token. Shipping that to a third
--  party is a decision with a data-protection answer attached, and it should
--  not be made implicitly by adding a dependency. Recording it in our own
--  database, redacted, is the version that needs no such answer.
--
--  WHAT IS DELIBERATELY NOT HERE: a stack trace column. A trace names our file
--  paths and, through variable names in some runtimes, our data. The
--  fingerprint carries the shape and the message carries the sentence, and
--  between them an engineer can find the line — from a log they already have
--  access to, rather than from a table a support tool can read.
-- ===========================================================================

-- Outside the transaction, because Postgres refuses to let a value added by
-- `ALTER TYPE ... ADD VALUE` be USED in the same transaction.
--
-- The alert below is the first notification NOT addressed to a customer, and
-- adding the TypeScript union member without this was a real bug caught by a
-- real insert: `NotificationRequest` is a literal union and `notification_kind`
-- is a Postgres enum, and nothing but a write proves they still agree. That is
-- the same finding Phase 3 recorded about `EntryKind` and `AccountRef`.
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'operations_alert';

BEGIN;

CREATE TYPE error_severity AS ENUM (
    -- A request failed. One is a bug; a hundred an hour is an incident.
    'error',
    -- Something a person must look at even though nothing threw: an
    -- unattributed deposit, a purchase held past the escalation window.
    'critical'
);

CREATE TABLE error_events (
    id            BIGSERIAL PRIMARY KEY,

    -- The GROUPING key, and the reason this table is readable at all.
    --
    -- Errors carry ids: "user 8814 not found", "purchase 5521 timed out". Left
    -- as-is, a thousand occurrences of one bug are a thousand distinct rows
    -- and the table is a log with extra steps. The fingerprint is computed
    -- from the message with those parts REMOVED, so one bug is one row with a
    -- count on it — which is what makes "this is new" and "this is spiking"
    -- answerable at a glance.
    fingerprint   TEXT NOT NULL UNIQUE CHECK (fingerprint ~ '^[0-9a-f]{16}$'),

    severity      error_severity NOT NULL DEFAULT 'error',

    -- One representative message, redacted. Not every message: a thousand
    -- near-identical sentences is what the fingerprint exists to collapse.
    message       TEXT NOT NULL,
    -- The route pattern, never the resolved path — `/v1/admin/users/:id` and
    -- not `/v1/admin/users/8814`, which would put a customer id in a row that
    -- exists to be read by everyone on call.
    route         TEXT,
    status_code   INTEGER,

    occurrences   BIGINT NOT NULL DEFAULT 1 CHECK (occurrences > 0),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- When somebody was last told. NULL means nobody has been.
    alerted_at    TIMESTAMPTZ,
    -- The count at the moment of that alert, so the next decision is "has this
    -- got materially worse since?" rather than "has it happened again?".
    alerted_count BIGINT,

    -- Cleared by a person who has dealt with it. A resolved fingerprint that
    -- recurs is re-opened by the recorder, because a bug that comes back is
    -- news again.
    resolved_at   TIMESTAMPTZ,

    CONSTRAINT error_seen_in_order CHECK (last_seen_at >= first_seen_at)
);

CREATE INDEX errors_recent ON error_events (last_seen_at DESC);
CREATE INDEX errors_unresolved ON error_events (last_seen_at DESC) WHERE resolved_at IS NULL;

-- ---------------------------------------------------------------------------
-- 1. RECORDING ONE
--
-- A FUNCTION, and it has to be, for a reason that is not about tidiness.
--
-- Recording an error must never be able to fail the request that produced it.
-- A read-then-insert-or-update in service code is two statements and a race:
-- two instances hitting the same new bug at the same moment both find no row
-- and both insert, one of them raises a unique violation, and the error
-- recorder has now thrown its own error inside an exception handler.
--
-- `ON CONFLICT DO UPDATE` makes it one statement that cannot lose that race.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION record_error(
    p_fingerprint TEXT,
    p_severity    error_severity,
    p_message     TEXT,
    p_route       TEXT,
    p_status      INTEGER
) RETURNS BIGINT AS $$
DECLARE
    v_id BIGINT;
BEGIN
    INSERT INTO error_events (fingerprint, severity, message, route, status_code)
    VALUES (p_fingerprint, p_severity, p_message, p_route, p_status)
    ON CONFLICT (fingerprint) DO UPDATE
       SET occurrences  = error_events.occurrences + 1,
           last_seen_at = now(),
           -- A recurrence REOPENS a resolved fingerprint. A bug somebody
           -- closed and which has come back is news again, and leaving it
           -- resolved would hide the recurrence behind the fix that did not
           -- work.
           resolved_at  = NULL,
           -- The message is refreshed so the representative sentence is the
           -- most recent one; the severity is raised but never lowered, so a
           -- flow that is sometimes critical is always reported as such.
           message      = EXCLUDED.message,
           severity     = GREATEST(error_events.severity, EXCLUDED.severity)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2. WHAT IS WORTH WAKING SOMEBODY FOR
--
-- Two cases, and only two, because an alerting rule nobody trusts is one
-- everybody mutes:
--
--   - a fingerprint NOBODY HAS BEEN TOLD ABOUT. A new failure shape is the
--     highest-signal event this table produces: it is, by definition,
--     something that has never happened before.
--   - one that has got an ORDER OF MAGNITUDE worse since the last alert. Not
--     "happened again" — every open bug happens again, and alerting on that
--     is how a channel becomes noise.
--
-- Deliberately NOT a rate threshold. "More than N per minute" needs a window,
-- a clock and a decision about what N is for a platform whose traffic nobody
-- has measured yet; ten times worse than when we last said anything is a
-- statement that holds at any volume.
-- ---------------------------------------------------------------------------
CREATE VIEW errors_alert_due AS
SELECT id, fingerprint, severity, message, route, status_code,
       occurrences, first_seen_at, last_seen_at, alerted_at, alerted_count
  FROM error_events
 WHERE resolved_at IS NULL
   AND (
        alerted_at IS NULL
        OR occurrences >= coalesce(alerted_count, 0) * 10
       )
 ORDER BY severity DESC, last_seen_at DESC;

-- What the operations dashboard reads.
CREATE VIEW errors_open AS
SELECT id, fingerprint, severity, message, route, status_code,
       occurrences, first_seen_at, last_seen_at, alerted_at
  FROM error_events
 WHERE resolved_at IS NULL
 ORDER BY last_seen_at DESC;

COMMIT;
