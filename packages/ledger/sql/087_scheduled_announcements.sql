-- ============================================================================
--  087 — an announcement that goes out LATER, and one that can be called back
--
--  AN OPERATOR COULD ONLY SAY "NOW". Maintenance tonight at eleven had to be
--  announced by somebody awake at eleven, or announced at four in the
--  afternoon and read by customers as happening at four. `send_at` is when a
--  broadcast is due: the bell feed shows nothing before it and the worker
--  pushes nothing before it.
--
--  A SCHEDULE WITHOUT A CANCEL IS A TRAP. The words are immutable (065), so a
--  typo found an hour before the send could only be sent. `cancelled_at` may be
--  set ONCE, and only while nothing has been sent and the time has not come —
--  after that the announcement is in customers' feeds and on their phones, and
--  "cancelling" it would be a record claiming something did not happen that
--  did. A cancelled broadcast can never be sent.
--
--  EXISTING ROWS WERE DUE WHEN THEY WERE WRITTEN, so `send_at` is backfilled
--  from `created_at` — the feed a customer already reads does not change.
--
--  AND THE TEST ROWS 082's SUITE WRITES ARE REMOVED. Its fixtures reached
--  production — `/admin/diagnostics` listed "test:082 customer validation
--  required" beside Paystack's real refusal — which only happens when a
--  `.test.sql` file is run against a live database. Those rows carry no
--  customer and exist only in that suite, so removing them loses nothing.
-- ============================================================================

BEGIN;

ALTER TABLE push_broadcasts ADD COLUMN IF NOT EXISTS send_at TIMESTAMPTZ;
ALTER TABLE push_broadcasts ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- The append-only trigger refuses an UPDATE of a sent row, and backfilling a
-- column is not what that rule is about. Disabled for exactly this statement.
ALTER TABLE push_broadcasts DISABLE TRIGGER push_broadcasts_append_only;
UPDATE push_broadcasts SET send_at = created_at WHERE send_at IS NULL;
ALTER TABLE push_broadcasts ENABLE TRIGGER push_broadcasts_append_only;

ALTER TABLE push_broadcasts ALTER COLUMN send_at SET DEFAULT now();
ALTER TABLE push_broadcasts ALTER COLUMN send_at SET NOT NULL;

DO $$
BEGIN
    -- Not backdated: a broadcast "due" before it was written would appear in
    -- a feed out of order and read as something customers had missed. A
    -- minute's grace covers two clocks that disagree.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_broadcasts_not_backdated') THEN
        ALTER TABLE push_broadcasts ADD CONSTRAINT push_broadcasts_not_backdated
            CHECK (send_at >= created_at - interval '1 minute');
    END IF;
    -- A month is the horizon. Further out is a note to self, not an
    -- announcement, and a scheduled row nobody remembers is a surprise.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_broadcasts_horizon') THEN
        ALTER TABLE push_broadcasts ADD CONSTRAINT push_broadcasts_horizon
            CHECK (send_at <= created_at + interval '31 days');
    END IF;
    -- Cancelled and sent cannot both be true.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_broadcasts_cancelled_or_sent') THEN
        ALTER TABLE push_broadcasts ADD CONSTRAINT push_broadcasts_cancelled_or_sent
            CHECK (cancelled_at IS NULL OR sent_at IS NULL);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS push_broadcasts_due
    ON push_broadcasts (send_at) WHERE sent_at IS NULL AND cancelled_at IS NULL;

CREATE OR REPLACE FUNCTION push_broadcasts_are_append_only()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'push_broadcasts is append-only: a broadcast that was '
                        'sent cannot be unsent, and deleting the record does '
                        'not reach the handsets';
    END IF;

    IF NEW.title IS DISTINCT FROM OLD.title
       OR NEW.body IS DISTINCT FROM OLD.body
       OR NEW.country IS DISTINCT FROM OLD.country
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.send_at IS DISTINCT FROM OLD.send_at THEN
        RAISE EXCEPTION 'a broadcast''s words, audience and time are immutable: '
                        'cancel it and write another';
    END IF;

    IF OLD.sent_at IS NOT NULL THEN
        RAISE EXCEPTION 'this broadcast has already been sent: sending it '
                        'again would announce the same thing twice to every '
                        'customer it reached';
    END IF;

    IF OLD.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'this broadcast was cancelled and can be neither sent '
                        'nor cancelled again';
    END IF;

    IF NEW.cancelled_at IS NOT NULL AND OLD.send_at <= now() THEN
        RAISE EXCEPTION 'this broadcast is already due and customers can read '
                        'it: it cannot be cancelled';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Stuck means DUE and not sent. A broadcast scheduled for tomorrow is waiting,
-- and counting it would put a permanent entry on a watch nobody then reads.
CREATE OR REPLACE VIEW push_broadcasts_stuck AS
SELECT count(*)                        AS waiting,
       min(send_at)                    AS oldest_at,
       max(now() - send_at)            AS oldest_age
  FROM push_broadcasts
 WHERE sent_at IS NULL
   AND cancelled_at IS NULL
   AND send_at <= now();

DELETE FROM account_refusals
 WHERE reason LIKE 'test:082%'
    OR provider_code IN ('p82', 'p82-long');

COMMIT;
