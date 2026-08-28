-- ===========================================================================
--  Xetral — the notification outbox
--  packages/identity/sql/012_notifications.sql
--
--  WHY A TABLE AND NOT A FUNCTION CALL.
--
--  The obvious implementation of "email the customer their reset link" is to
--  call the provider from the request handler. It fails in two directions and
--  both of them matter here.
--
--  Sending INSIDE the transaction means an email goes out for a transaction
--  that then rolls back — a receipt for money that never moved, or a reset
--  link for a token the database never kept. Sending AFTER the commit means a
--  process that dies in the gap loses the message with nothing recording that
--  it was ever owed. And either way the request now waits on a third party:
--  Resend having a slow afternoon becomes Xetral having a slow afternoon, on
--  the login path.
--
--  A row written in the SAME transaction as the thing it describes has neither
--  problem. If the transaction rolls back there is no row and no message. If
--  it commits, the message is owed and will be sent, by a worker, later, and
--  retried until it is. This is the transactional outbox, and it is the same
--  shape as `purchases` holding a reservation before the provider is asked.
--
--  WHY THE BODY IS SEALED.
--
--  A rendered password reset email CONTAINS A BEARER TOKEN. Store it in the
--  clear and this table is a list of live account-takeover links, readable by
--  anything with SELECT on it — a support tool, a backup, a stray `SELECT *`
--  in a log line. That is precisely the reasoning that put a `^v[0-9]+:` CHECK
--  on `purchases.delivery_sealed` for electricity tokens, and a reset link is
--  a bearer instrument in exactly the same way.
--
--  So the body is sealed with the encryption keyring, the CHECK makes that
--  structural rather than customary, and a SENT message has its body ERASED —
--  the ciphertext is not needed once delivered, and the safest place for a
--  secret is nowhere.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. WHAT WE SEND, AND HOW HARD WE TRY
--
-- The class is not a formatting concern, it is a delivery policy. Security
-- mail is what a customer needs in order to keep control of their account, so
-- it is retried longer and its failure is escalated. A receipt that never
-- arrives is a support ticket; a reset link that never arrives is a customer
-- locked out of their own money.
-- ---------------------------------------------------------------------------
CREATE TYPE notification_class AS ENUM ('security', 'transactional');

CREATE TYPE notification_kind AS ENUM (
    -- security
    'password_reset',
    'password_changed',
    'new_device',
    'devices_revoked',
    -- transactional
    'deposit_credited',
    'transfer_sent',
    'crypto_withdrawal_sent',
    'card_frozen'
);

CREATE TYPE notification_status AS ENUM (
    'pending',
    'sent',
    -- Tried until the attempt ceiling and never accepted. NOT a synonym for
    -- failed: a single failure leaves the row `pending` with a later
    -- `next_attempt_at`. Reaching `abandoned` means nobody got the message.
    'abandoned'
);

CREATE TABLE notification_outbox (
    id              BIGSERIAL PRIMARY KEY,

    -- Nullable: a reset requested for an address with no account still has to
    -- be RATE LIMITED and audited, and forcing a user id here would mean the
    -- only way to record that is to reveal whether the account exists.
    user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,

    kind            notification_kind  NOT NULL,
    class           notification_class NOT NULL,

    -- The address AS IT WAS when the message was owed. Reading it from the
    -- user row at send time would mail a change-of-address confirmation to the
    -- NEW address — telling whoever just changed it that they succeeded, and
    -- telling the real owner nothing.
    recipient       TEXT NOT NULL CHECK (recipient <> ''),

    -- Sealed: subject, text and html together. See the header.
    payload_sealed  TEXT CHECK (payload_sealed ~ '^v[0-9]+:'),

    -- Ours, and the reason enqueueing is safe to retry. Two requests racing to
    -- send the same customer the same alert produce one row.
    idempotency_key TEXT NOT NULL UNIQUE,

    status          notification_status NOT NULL DEFAULT 'pending',
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    -- Backoff. A worker only ever claims rows whose time has come, so a
    -- provider outage backs off instead of hammering.
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error      TEXT,

    provider            TEXT,
    provider_message_id TEXT,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at         TIMESTAMPTZ,

    -- A sent message has a time and a provider id, and no body left.
    CONSTRAINT notification_sent_is_recorded CHECK (
        (status <> 'sent')
        OR (sent_at IS NOT NULL AND provider_message_id IS NOT NULL AND payload_sealed IS NULL)
    ),
    -- And an unsent one still has its body, or there is nothing to send.
    CONSTRAINT notification_pending_has_a_body CHECK (
        status <> 'pending' OR payload_sealed IS NOT NULL
    )
);

-- The worker's claim query. Partial, because `sent` rows are the overwhelming
-- majority within a day of launch and none of them is ever due again.
CREATE INDEX notifications_due
    ON notification_outbox (next_attempt_at, id)
    WHERE status = 'pending';

CREATE INDEX notifications_by_user
    ON notification_outbox (user_id, created_at DESC)
    WHERE user_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. A SENT MESSAGE IS FINAL
--
-- Same rule as a purchase outcome and for the same reason: reopening one would
-- let a delivered message be re-delivered. For a password reset that means
-- re-mailing a link, which is the one thing the single-use token was designed
-- to make impossible.
--
-- `abandoned` is final too. A worker that could resurrect an abandoned row
-- would retry for ever, which is what the attempt ceiling exists to stop.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_notification_transition() RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'notification % is already %; an outcome is final',
            OLD.id, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    -- Identity is fixed. Redirecting a pending security email to another
    -- address is the whole attack this prevents: the row is written inside the
    -- transaction that owed it, and what it says and where it goes cannot be
    -- edited afterwards.
    IF NEW.recipient IS DISTINCT FROM OLD.recipient
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key THEN
        RAISE EXCEPTION 'notification % cannot be re-addressed or re-purposed', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    -- The body may only ever be ERASED, never rewritten. Rewriting it would
    -- let a pending message be swapped for a different one after the
    -- transaction that authorised it had committed.
    IF OLD.payload_sealed IS NOT NULL
       AND NEW.payload_sealed IS NOT NULL
       AND NEW.payload_sealed IS DISTINCT FROM OLD.payload_sealed THEN
        RAISE EXCEPTION 'notification % body is immutable; it may be cleared, not changed', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.attempts < OLD.attempts THEN
        RAISE EXCEPTION 'notification % attempt count cannot go backwards', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notification_transition
    BEFORE UPDATE ON notification_outbox
    FOR EACH ROW EXECUTE FUNCTION assert_notification_transition();

-- ---------------------------------------------------------------------------
-- 3. WHAT OPERATIONS NEEDS TO SEE
--
-- Undelivered SECURITY mail is the alert that matters. A backlog of receipts
-- is an annoyance; a backlog of password resets means customers are locked out
-- right now and nobody has been told.
-- ---------------------------------------------------------------------------
CREATE VIEW notification_backlog AS
SELECT class,
       kind,
       count(*)            AS waiting,
       min(created_at)     AS oldest,
       max(attempts)       AS worst_attempts
  FROM notification_outbox
 WHERE status = 'pending'
 GROUP BY class, kind;

CREATE VIEW notifications_abandoned AS
SELECT id, user_id, kind, class, recipient, attempts, last_error, created_at
  FROM notification_outbox
 WHERE status = 'abandoned'
 ORDER BY created_at DESC;

COMMIT;
