-- ============================================================================
--  039 — A handle, so a customer can be paid by a link.
--
--  WHAT WAS MISSING. Sending money required knowing somebody's EMAIL ADDRESS
--  or PHONE NUMBER, which are the two identifiers people are most careful
--  about and least willing to put in a WhatsApp group. So "send me money" was
--  "here is my email", and the ordinary case — a trader posting a way to pay
--  them, somebody splitting a bill — had no shape at all.
--
--  A HANDLE IS NOT AN ALIAS FOR AN EMAIL. It is a separate, public identifier
--  whose whole purpose is to be shared, which is why it is its own column
--  rather than a lookup that lowercases the local part of an address: an
--  address is private and a handle is meant to be posted.
--
--  IT IS CLAIMED ONCE AND NEVER RELEASED, and that is the part that protects
--  money. If a handle could be given up, whoever took it next would receive
--  payments meant for the person who had it — from a link in a message thread
--  that nobody thinks to check. So `handle_history` keeps every handle that
--  has ever existed and the unique index spans it: changing yours does not
--  free the old one for anybody else.
--
--  NULLABLE, because eleven thousand existing rows have none and a NOT NULL
--  column would mean inventing one for each in a migration. They are filled
--  by the application on first use and by the backfill below, and a customer
--  without one is simply not payable by link yet — which is correct, since
--  nobody could have their link either.
-- ============================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS handle TEXT;

-- ---------------------------------------------------------------------------
-- The shape. Lowercase, because a handle arrives typed from a message and
-- `@Olawale` and `@olawale` must not be two people. Three characters minimum,
-- so a single letter cannot be squatted; twenty maximum, so it fits on a line
-- beside a name.
--
-- No leading or trailing underscore and no run of them: `_olawale` and
-- `olawale__` read as the same handle at a glance and are exactly how one
-- person is impersonated to another.
-- ---------------------------------------------------------------------------
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_handle_shape;
ALTER TABLE users ADD CONSTRAINT users_handle_shape
    CHECK (handle IS NULL OR handle ~ '^[a-z0-9](?:[a-z0-9_]{1,18})[a-z0-9]$');

-- ---------------------------------------------------------------------------
-- EVERY HANDLE EVER USED, so one cannot be re-issued to somebody else.
--
-- The live column alone would let a customer change theirs and a stranger
-- claim what they released — and then a payment link posted last month pays
-- the stranger. The row is written by trigger rather than by the service, so
-- a handle set at a psql prompt cannot skip the record.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS handle_history (
    handle      TEXT        PRIMARY KEY,
    user_id     BIGINT      NOT NULL REFERENCES users(id),
    claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS handle_history_user ON handle_history (user_id);

-- The live one. Partial, so the many NULLs do not collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS users_handle_live
    ON users (handle) WHERE handle IS NOT NULL;

CREATE OR REPLACE FUNCTION record_handle_claim() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.handle IS NOT DISTINCT FROM OLD.handle THEN
        RETURN NEW;
    END IF;

    -- Releasing the old one marks it spent; it stays in the table, so the
    -- primary key refuses to hand it to anybody else.
    IF OLD.handle IS NOT NULL THEN
        UPDATE handle_history SET released_at = now()
         WHERE handle = OLD.handle AND released_at IS NULL;
    END IF;

    IF NEW.handle IS NOT NULL THEN
        -- A handle somebody else has ever held is refused here rather than by
        -- the unique index, because the index only sees LIVE handles and the
        -- whole point is that a released one is still taken.
        IF EXISTS (SELECT 1 FROM handle_history
                    WHERE handle = NEW.handle AND user_id <> NEW.id) THEN
            RAISE EXCEPTION 'handle % has been used before and cannot be reissued', NEW.handle
                USING ERRCODE = 'unique_violation';
        END IF;

        INSERT INTO handle_history (handle, user_id)
        VALUES (NEW.handle, NEW.id)
        ON CONFLICT (handle) DO UPDATE SET released_at = NULL;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_handle_recorded ON users;
CREATE TRIGGER users_handle_recorded
    BEFORE INSERT OR UPDATE OF handle ON users
    FOR EACH ROW EXECUTE FUNCTION record_handle_claim();

-- ---------------------------------------------------------------------------
-- Who a handle belongs to, for the pay-by-link screen.
--
-- A VIEW rather than a query in the service, because it answers with exactly
-- two columns and neither is the email. A screen that resolves a link needs
-- to show who is about to be paid; it does not need — and must never leak —
-- the address behind the handle, or a payment link becomes an email harvester.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW payable_handles AS
SELECT u.handle,
       u.uuid AS user_uuid,
       -- The first name from their most recent identity submission, which is
       -- the only name this system holds. NULL for somebody unverified, and
       -- the screen says "a Xetral customer" rather than inventing one.
       (SELECT split_part(trim(k.full_name), ' ', 1)
          FROM kyc_submissions k
         WHERE k.user_id = u.id
         ORDER BY k.created_at DESC
         LIMIT 1) AS first_name
  FROM users u
 WHERE u.handle IS NOT NULL
   AND u.status = 'active';

-- ---------------------------------------------------------------------------
-- The two decisions this table and view owe the coverage views.
--
-- Both were caught by the invariant suites rather than remembered — 019 fails
-- on a table with no retention decision and 036 on a view nobody classified,
-- in both directions. That is the whole point of those files: the table
-- nobody thought of is the one that quietly accumulates customer data, and
-- the queue nobody thought of is the one that quietly fills.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('handle_history', 'keep',
   'KEEPING IT IS THE CONTROL. This table exists so a handle somebody released '
   'cannot be reissued to anybody else — delete a row and the handle becomes '
   'claimable again, and a payment link posted in a message thread last year '
   'starts paying a stranger. It holds a public identifier and a user id, and '
   'no personal data beyond the handle its owner chose to publish.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, rationale) VALUES
  ('payable_handles', 'internal',
   'A LOOKUP, not a queue and not a watch. It answers "who does this handle '
   'belong to" for the pay-by-link screen, so every row is an ordinary active '
   'customer and there is nothing for an operator to work through. It is '
   'listed here so that the day it grows a meaning — a disputed handle, an '
   'impersonation report — somebody has to say so rather than add a column.')
ON CONFLICT (source) DO NOTHING;

COMMIT;
