-- ============================================================================
--  058 — a payment link somebody without an account can pay
--
--  WHAT WAS WRONG. The "payment link" was `app.xetral.com/pay/<number>`, and
--  all it did was hand the identifier to the SEND screen — which is behind a
--  sign-in. So the link a customer was told to share "to accept payment
--  globally" was only usable by somebody who already had a Xetral account and
--  already had money in it. For everybody else it was a sign-in page.
--
--  A LINK THAT REQUIRES THE PAYER TO BE A CUSTOMER IS NOT A PAYMENT LINK. It
--  is a shortcut for existing customers, which is a real thing and not the
--  thing that was promised on the screen.
--
--  SO THE LINK IS A CHECKOUT. The payer opens it, types an amount, and pays by
--  whatever Paystack offers them — mobile money, a bank transfer, a card. The
--  money lands in the wallet of the customer whose link it is.
--
--  THE SLUG IS NOT THE PHONE NUMBER, and that is the second decision. A phone
--  number in a public URL is a phone number published to whoever the link is
--  forwarded to, for ever, on a page that anybody can open — and it cannot be
--  changed after the fact, because the link is already in the world. A random
--  slug can be rotated; a number cannot.
--
--  AND IT IS MINTED FOR EVERY CUSTOMER, by trigger rather than on first ask.
--  A link somebody has to go and create is a link most customers do not have,
--  and 039's minting-on-first-read had a GET that wrote. Here the row is
--  written when the account is, so `GET /v1/auth/profile` is a pure read for
--  every customer including the ones that predate this migration.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS payment_links (
    id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id    BIGINT      NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,

    -- PUBLIC, AND THEREFORE NOT DERIVED FROM ANYTHING. Twelve lowercase
    -- base32-ish characters from a CSPRNG: enough that a link cannot be
    -- guessed by walking, and short enough to read down a phone line. The
    -- CHECK is what stops a well-meaning INSERT putting an email address or a
    -- phone number in a column whose whole point is that it carries neither.
    slug       TEXT        NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]{8,32}$'),

    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE payment_links IS
  'The public identifier a payment page is served under. Deliberately not the '
  'phone number: a link is forwarded and cannot be recalled, and a slug can be '
  'rotated where a number cannot.';

-- ---------------------------------------------------------------------------
--  1. EVERY CUSTOMER HAS ONE, AND NOBODY HAD TO ASK
--
--  By trigger, so a registration path that forgets is not a customer without
--  a link — and it runs on the registration's OWN transaction, which is 033's
--  argument about consent: apart, a crash in the gap leaves an account whose
--  link does not exist and whose screen says so.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION mint_payment_link() RETURNS TRIGGER AS $$
DECLARE
    candidate TEXT;
BEGIN
    FOR attempt IN 1..8 LOOP
        /*
         * `gen_random_uuid()` IS THE CSPRNG HERE, and pgcrypto's
         * `gen_random_bytes` deliberately is not: it needs an extension this
         * database does not install, and a migration that fails on a missing
         * extension fails at the worst possible moment. A v4 UUID is 122
         * random bits from the same source; twelve of its hex characters are
         * 48 bits, which is not guessable by walking.
         *
         * A slug is PUBLIC and PERMANENT, so a predictable one would let
         * somebody work out the next customer's link and collect payments
         * meant for them.
         */
        candidate := substr(replace(gen_random_uuid()::text, '-', ''), 1, 12);
        BEGIN
            INSERT INTO payment_links (user_id, slug) VALUES (NEW.id, candidate);
            RETURN NEW;
        EXCEPTION WHEN unique_violation THEN
            -- Either the slug collided — one in 16^12 — or this customer
            -- already has one, which is the ordinary case on a re-run.
            IF EXISTS (SELECT 1 FROM payment_links WHERE user_id = NEW.id) THEN
                RETURN NEW;
            END IF;
        END;
    END LOOP;

    -- EIGHT ATTEMPTS AND THEN NOTHING, rather than raising: this trigger runs
    -- on the registration transaction, and a customer who cannot sign up
    -- because a random string collided eight times is a worse outcome than a
    -- customer whose link is minted by the service on its next read.
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS users_payment_link ON users;
CREATE TRIGGER users_payment_link
    AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION mint_payment_link();

-- Everybody who already existed. Idempotent, so re-applying this migration is
-- not a second link for anybody.
INSERT INTO payment_links (user_id, slug)
SELECT u.id, substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)
  FROM users u
 WHERE NOT EXISTS (SELECT 1 FROM payment_links p WHERE p.user_id = u.id)
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
--  2. ONE PAYMENT SOMEBODY MADE THROUGH A LINK
--
--  THE ROW IS WRITTEN BEFORE THE PAYER IS SENT TO PAYSTACK, and that ordering
--  is the whole security argument for this rail.
--
--  `charge.success` fires for every successful Paystack charge on the
--  integration, which is why 044 refuses to credit on the event name alone and
--  demands `channel = 'dedicated_nuban'`. A checkout charge has no dedicated
--  account and its channel is whatever the payer chose, so that test cannot be
--  the one used here. What replaces it is stronger: the reference is OURS, it
--  names a row we wrote, and that row says which customer and how much. An
--  event whose reference matches nothing here credits nobody.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS link_payments (
    id           BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    -- OURS, and globally unique. Sent to Paystack as the transaction
    -- reference and echoed back on every webhook and every verification read,
    -- so a lost webhook resolved by asking and a late redelivery produce the
    -- same key — 044's rule about `data.reference`, kept.
    reference    TEXT        NOT NULL UNIQUE CHECK (reference ~ '^[a-zA-Z0-9:_-]{8,64}$'),

    link_id      BIGINT      NOT NULL REFERENCES payment_links(id),
    -- Denormalised deliberately: this is what decides whose wallet the money
    -- lands in, and it must not change if a link is ever reassigned.
    user_id      BIGINT      NOT NULL REFERENCES users(id),

    amount_minor BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency     TEXT        NOT NULL,

    -- What the payer typed, so a receipt can name who paid. NOT required: a
    -- link is for strangers, and demanding a name to pay somebody is friction
    -- on the one action this page exists for.
    payer_name   TEXT,
    payer_email  TEXT,

    status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'paid', 'abandoned')),

    entry_id     BIGINT      REFERENCES journal_entries(id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_at      TIMESTAMPTZ,

    -- A paid payment names its entry. Without this the two could disagree,
    -- and "was this credited?" would have two answers.
    CONSTRAINT link_payment_paid_has_an_entry
        CHECK ((status = 'paid') = (entry_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS link_payments_by_user ON link_payments (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  3. A PAID PAYMENT IS FINAL
--
--  The same rule the purchase state machine follows. Reopening one would let a
--  credited payment be credited again, and the amount is what the ledger
--  posted — so it is immutable once the row exists rather than once it is
--  paid: a payment whose amount could change between initialising and paying
--  is one where the number the payer agreed to is not the number we credit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_link_payment_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reference IS DISTINCT FROM OLD.reference
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION 'a link payment''s identity and amount are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.status <> 'pending' AND NEW.status IS DISTINCT FROM OLD.status THEN
        RAISE EXCEPTION 'link payment % is already %, which is final', OLD.reference, OLD.status
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS link_payments_transition ON link_payments;
CREATE TRIGGER link_payments_transition
    BEFORE UPDATE ON link_payments
    FOR EACH ROW EXECUTE FUNCTION assert_link_payment_transition();

-- ---------------------------------------------------------------------------
--  4. WHO IS BEING PAID, WITHOUT SAYING ANYTHING ELSE ABOUT THEM
--
--  What the public page reads. A NAME and a CURRENCY and nothing more — no
--  email, no phone number, no balance. `payable_handles` makes the same
--  decision for the same reason: a resolver that answers more than "this link
--  is real and it pays this person" is a harvester with a nice URL.
--
--  A CLOSED ACCOUNT IS ABSENT, so its link stops working rather than taking
--  money we would then have to send back.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW payable_links AS
SELECT p.slug,
       u.uuid AS user_uuid,
       -- The typed name, not the verified one: 040 keeps them apart and only
       -- the verified one may inform a money decision. This is a greeting on
       -- a checkout page.
       u.full_name,
       COALESCE(c.currency, 'NGN') AS currency
  FROM payment_links p
  JOIN users u ON u.id = p.user_id
  LEFT JOIN countries c ON c.code = u.country
 WHERE u.status = 'active';

INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('payable_links', 'internal', NULL,
        'What a public checkout page reads to name who is being paid. A lookup '
        'on demand rather than a queue: nothing here is waiting on anybody.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('payment_links', 'derive',
   'The public identifier of an account. Its fate is the account''s: a link '
   'that outlived its owner would be a page collecting money for nobody.'),
  ('link_payments', 'keep',
   'Money arriving. Every credit must remain checkable against what the payer '
   'agreed to, which is the same reason deposits are kept.')
ON CONFLICT (table_name) DO UPDATE
   SET decision = EXCLUDED.decision,
       rationale = EXCLUDED.rationale;

COMMIT;
