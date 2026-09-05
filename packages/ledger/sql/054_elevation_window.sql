-- ============================================================================
--  054 — the staff second factor, measured from IDLENESS rather than from age
--
--  WHAT WAS WRONG. `totp_verified_at` records when a code was entered, and
--  elevation lasts ten minutes from that instant. It is not a session timeout,
--  it is an egg timer: an operator who enters a code and then works is asked
--  again ten minutes later regardless of what they were doing, mid-form, on a
--  screen they had been using continuously.
--
--  014's reasoning was right and its unit was wrong. The argument against a
--  code per action is that codes are single-use and change every thirty
--  seconds, so demanding one per action refuses a reviewer on their second
--  approval and the end of that is a shared authenticator on a desk. A
--  ten-minute egg timer is a slower version of the same problem — and the
--  observed behaviour was "it asks every time", because ten minutes is about
--  how long one real piece of work takes.
--
--  SO THE WINDOW SLIDES. Every elevated action refreshes it, which makes it a
--  measure of INACTIVITY: step away for ten minutes and the next action asks
--  for a code, keep working and it does not.
--
--  AND IT IS CAPPED, which is why this migration exists rather than a one-line
--  service change. A window that only ever slides is one a tab left open can
--  hold for ever, so `totp_first_verified_at` records when the CURRENT run of
--  elevation began and the absolute ceiling is measured from it. Two columns
--  because they answer two questions — when did this stop being idle, and how
--  long has it been going — and deriving either from the other is impossible.
--
--  THE PIN IS UNCHANGED and is still required on every acting request. This
--  is the second factor's window, not an authorisation.
-- ============================================================================

BEGIN;

ALTER TABLE auth_sessions
    ADD COLUMN IF NOT EXISTS totp_first_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN auth_sessions.totp_first_verified_at IS
  'When the current run of elevation began. `totp_verified_at` slides with '
  'every elevated action and measures idleness; this one does not move and is '
  'what the absolute ceiling is measured from, so a tab left open cannot hold '
  'elevation indefinitely by polling.';

-- ---------------------------------------------------------------------------
--  Existing elevated sessions get the value they already had.
--
--  Without this, every session elevated at the moment of deployment has a NULL
--  start and would be treated as having begun at the epoch — so the ceiling
--  would refuse them all and every operator would be asked for a code at once,
--  which is precisely the interruption this file exists to remove.
-- ---------------------------------------------------------------------------
UPDATE auth_sessions
   SET totp_first_verified_at = totp_verified_at
 WHERE totp_verified_at IS NOT NULL AND totp_first_verified_at IS NULL;

COMMIT;
