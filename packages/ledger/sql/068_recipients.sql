-- 068: ONE RECIPIENT, WHATEVER RAIL REACHES THEM.
--
-- SENDING MONEY WAS THREE PRODUCTS WEARING ONE HEADING. The Send screen asked
-- first "is this a Xetral customer, a bank account or a mobile money wallet?" —
-- which is a question about OUR PLUMBING, asked of somebody who only wants to
-- pay a person. Each answer led to a different form, a different set of fields
-- and a different endpoint, and a customer who chose wrong got a dead end
-- rather than a redirect.
--
-- Nothing about that was necessary. A recipient is a PERSON AND A DESTINATION;
-- which of `/v1/wallets/transfers`, `/v1/fx/remit` or `/v1/payouts` carries the
-- money is derivable from the destination and is not a decision a customer
-- should be asked to make. So the tabs go, and what replaces them is this
-- table: pick a person, or add one, and the rail follows from what you typed.
--
-- IT ALSO GIVES THE FIRST SCREEN SOMETHING TO SHOW. A send flow whose first
-- step is an empty field is one where every payment costs the same typing as
-- the first; a list of people already paid is the difference between a product
-- somebody uses twice and one they use weekly.

-- ---------------------------------------------------------------------------
--  1. WHAT KIND OF DESTINATION
--
--  Three, and they are RAILS rather than products. `xetral` moves between two
--  accounts here and never leaves; `bank` and `momo` both leave through
--  `bank_payouts`, and differ in what the destination string means and whether
--  the rail can name its holder.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'recipient_kind') THEN
        CREATE TYPE recipient_kind AS ENUM ('xetral', 'bank', 'momo');
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS recipients (
    id            BIGINT         GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid          UUID           NOT NULL DEFAULT gen_random_uuid(),
    user_id       BIGINT         NOT NULL REFERENCES users(id),

    kind          recipient_kind NOT NULL,

    /** Where the money lands. ISO-3166 alpha-2. */
    country       CHAR(2)        NOT NULL,
    /** What the RECIPIENT receives, which is not always what the sender holds. */
    currency      TEXT           NOT NULL,

    /**
     * The rail's own code for the destination: a bank code, or a mobile money
     * NETWORK code. NULL for a Xetral account, which has no rail.
     */
    rail_code     TEXT           NULL CHECK (
        rail_code IS NULL OR rail_code ~ '^[A-Za-z0-9_-]{1,32}$'
    ),
    /** What that code is called, so a saved recipient reads as "MTN Mobile
     *  Money" rather than as "MTN" a year later when the code has moved. */
    rail_name     TEXT           NULL CHECK (
        rail_name IS NULL OR length(btrim(rail_name)) BETWEEN 1 AND 120
    ),

    /**
     * DIGITS ONLY, and already in the form the rail accepts.
     *
     * A bank account number as typed; a wallet or a Xetral account as an
     * INTERNATIONAL number with no `+` — `233501234567`. Normalised before it
     * is written, by the same `phone.ts` the payout path uses, because a
     * unique index on text cannot see that three spellings are one wallet.
     */
    destination   TEXT           NOT NULL CHECK (destination ~ '^[0-9]{6,20}$'),

    /**
     * WHAT THE LIST SHOWS. For a Xetral account and for any rail that resolves
     * a name, this is that name. Where nothing can be resolved it is what the
     * customer called them — a label on their own address book, which is a
     * different thing from a claim about who holds an account.
     */
    display_name  TEXT           NOT NULL CHECK (
        length(btrim(display_name)) BETWEEN 1 AND 140
    ),
    /**
     * WHAT THE RAIL SAID, kept apart from the label for the reason 040 keeps
     * `users.full_name` and `kyc_submissions.full_name` apart: one is
     * somebody's own words and one is an answer from a system that has no
     * reason to flatter. Only this one may be shown as confirmation.
     *
     * NULL where the rail has no name enquiry — Kenya's M-PESA — which is a
     * fact about that product rather than about the number.
     */
    resolved_name TEXT           NULL CHECK (
        resolved_name IS NULL OR length(btrim(resolved_name)) BETWEEN 1 AND 140
    ),

    created_at    TIMESTAMPTZ    NOT NULL DEFAULT now(),
    /** Sorts the list, so the people somebody actually pays rise to the top. */
    last_used_at  TIMESTAMPTZ    NULL,
    /**
     * REMOVAL IS A COLUMN, NOT A DELETE. A payout names its destination and an
     * operator reading a complaint months later needs to see the recipient the
     * customer was looking at — a row a customer can erase is evidence a
     * customer can erase.
     */
    removed_at    TIMESTAMPTZ    NULL,

    CONSTRAINT recipients_uuid_key UNIQUE (uuid),

    /**
     * A XETRAL ACCOUNT HAS NO RAIL AND EVERY OTHER DESTINATION HAS ONE, by
     * CHECK rather than by the endpoint. Without it a `momo` row with no
     * network is writable, and the failure surfaces at the provider as an
     * unhelpful refusal about a field the customer never saw.
     */
    CONSTRAINT recipients_rail_matches_kind CHECK (
        (kind = 'xetral') = (rail_code IS NULL)
        AND (rail_code IS NULL) = (rail_name IS NULL)
    )
);

/**
 * ONE LIVE ROW PER DESTINATION, and removed rows do not block a re-add.
 *
 * Partial on `removed_at IS NULL` for the reason 006's virtual-account index
 * is partial: the history has to stay, and a customer who removed somebody by
 * accident must be able to add them back rather than being told they already
 * exist — about a row they cannot see.
 */
CREATE UNIQUE INDEX IF NOT EXISTS recipients_one_live_per_destination
    ON recipients (user_id, kind, COALESCE(rail_code, ''), destination)
 WHERE removed_at IS NULL;

CREATE INDEX IF NOT EXISTS recipients_by_owner
    ON recipients (user_id, last_used_at DESC NULLS LAST, created_at DESC)
 WHERE removed_at IS NULL;

-- ---------------------------------------------------------------------------
--  2. WHERE IT GOES CANNOT CHANGE
--
--  043 makes a payout's destination immutable once the row exists, because the
--  reserve is already posted and an UPDATE moving the account number sends
--  authorised money to somebody never named. The same argument reaches one
--  step further back: a saved recipient is what a customer taps without
--  re-reading, so a row whose number could be edited is a way to redirect
--  every future payment to a person somebody trusts.
--
--  Renaming the LABEL is fine — it is the customer's own note. Everything that
--  decides where money lands is fixed, and changing it is removing this
--  recipient and adding another.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_recipient_destination_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id     IS DISTINCT FROM OLD.user_id
       OR NEW.kind     IS DISTINCT FROM OLD.kind
       OR NEW.country  IS DISTINCT FROM OLD.country
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.rail_code IS DISTINCT FROM OLD.rail_code
       OR NEW.destination IS DISTINCT FROM OLD.destination THEN
        RAISE EXCEPTION 'a recipient''s destination is immutable; remove it and add another'
            USING ERRCODE = 'check_violation';
    END IF;

    -- Removal is final for the same reason: an un-removable row is history,
    -- and a row that could be restored would let a destination be parked and
    -- brought back after a complaint was closed.
    IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
        RAISE EXCEPTION 'a removed recipient cannot be restored'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recipients_destination_immutable ON recipients;
CREATE TRIGGER recipients_destination_immutable
    BEFORE UPDATE ON recipients
    FOR EACH ROW EXECUTE FUNCTION assert_recipient_destination_immutable();

-- ---------------------------------------------------------------------------
--  3. WHICH BALANCE FUNDS A PAYOUT
--
--  FLUTTERWAVE IS A PREFUNDED WALLET AND NOTHING HERE EVER SAID SO. It debits
--  the balance matching the payout currency, so a cedi payout needs a cedi
--  float — and a deployment that has never collected a cedi has none. Every
--  Ghanaian transfer then fails with a message about funds, which reads as a
--  bug in the integration and is not one.
--
--  Two answers, both decisions:
--
--    hold a float   leave this empty. Cedis pay cedis and somebody tops the
--                   balance up ahead of demand — the model every remittance
--                   business runs on, and the one that keeps OUR published
--                   spread as the price.
--    name another   `GHS=NGN`. Flutterwave debits naira and converts at THEIR
--                   rate, which silently overrides the spread an operator
--                   published on `/admin/prices`.
--
--  EMPTY IS THE DEFAULT, because the second answer changes what a customer is
--  charged and 032 records what that requires: machinery that ships complete
--  and a decision that does not ship at all.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('payout_debit_currencies', '', 'text', NULL, NULL,
   'Balance that funds each payout currency',
   'Empty means each currency is paid from its own float, which is how the '
   'provider behaves by default and keeps our published spread as the price. '
   'Set GHS=NGN,KES=NGN to pay out of naira instead — the provider then '
   'converts at ITS rate, which overrides the spread on the prices screen. '
   'Comma separated, payout currency on the left.',
   'fees', TRUE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  4. WHAT THE COVERAGE GUARDS DEMAND
--
--  019 fails the build on a table with no retention decision, in both
--  directions. A saved recipient is personal data about a THIRD PARTY — the
--  person being paid never agreed to anything here — so it ages out rather
--  than being kept for ever, and the window is the sign-in one because both
--  are "we must keep this long enough to answer a question about it".
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES (
    'recipients',
    'purge',
    'A saved recipient is personal data about somebody who is NOT our customer '
    'and never agreed to anything here. Kept while it is being used and long '
    'enough afterwards to answer a question about a payment made to it, then '
    'aged out on removal date — never on creation date, which would silently '
    'empty the address book of the customers who use it most.'
)
ON CONFLICT (table_name) DO NOTHING;
