-- ============================================================================
--  063 — the mobile money number a customer links to their wallet
--
--  WHAT WAS WRONG. Add Money in Accra and Nairobi showed an AMOUNT FIELD —
--  "Top up from mobile money in Ghana / Amount (GHS)" — which asks for a
--  one-off charge and leaves nothing behind. Money goes out on the Send screen
--  by typing a wallet number in again, every time, and nothing on the account
--  records which number belongs to this customer at all.
--
--  What the product needs is the opposite shape: a number LINKED ONCE that
--  both funds the wallet and receives from it. That is how a mobile money
--  account works everywhere it is used, and it is what makes a withdrawal a
--  confirmation rather than a re-entry.
--
--  AND THE OTHER HALF WAS THE ACTIVATE BUTTON. `countries.funding_methods` has
--  said `{mobile_money}` for GH and KE since 051, while the screen offered a
--  dedicated account number anyway — which Flutterwave issues in NGN only, so
--  every press failed with a sentence inviting the customer to try again
--  shortly for something that can never work. A linked number is what belongs
--  on that screen instead.
--
--  NIGERIA IS UNTOUCHED. `{virtual_account}` there is correct, works, and this
--  migration neither reads nor changes it.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  WHY VERIFICATION IS A STATE AND NOT A CALL.
--
--  There is no way to ask who owns a mobile money wallet. 043 already records
--  that a beneficiary name enquiry does not exist on this rail — it is
--  `name_unavailable`, its own refusal — and the one thing an adapter must
--  never do is echo back the number the customer typed, which confirms
--  nothing while looking exactly like a confirmation.
--
--  So a number is CLAIMED when it is linked and becomes VERIFIED when money
--  actually arrives from it. That is a fact rather than an assertion: the
--  charge settled, so the person holding that wallet authorised it. Until
--  then the link is real enough to fund with and deliberately NOT enough to
--  pay out to, which is the asymmetry that matters — money arriving from an
--  unverified number costs nobody anything, and money leaving to one is
--  unrecoverable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS momo_accounts (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid        UUID        NOT NULL DEFAULT gen_random_uuid(),

    user_id     BIGINT      NOT NULL REFERENCES users(id),

    /** The network's own code — 'MTN', 'VOD', 'ATL', 'MPS'. What the payout
     *  adapter sends, so it must be one of theirs and not a display name. */
    network     TEXT        NOT NULL CHECK (network ~ '^[A-Z0-9]{2,10}$'),

    /**
     * E.164, THE ONE SHAPE THIS PLATFORM STORES A NUMBER IN.
     *
     * 040's argument exactly: a plain unique index on text cannot see that
     * `+233244123456`, `233244123456` and `0244123456` are one wallet, and
     * every per-customer control assumes one person cannot become several.
     * Normalised server-side from the country's dial code, never trusted from
     * a client.
     */
    msisdn      TEXT        NOT NULL CHECK (msisdn ~ '^\+[1-9][0-9]{7,14}$'),

    /** What money moving on this wallet is denominated in. A statement about
     *  the rail, so it is stored rather than derived at read time. */
    currency    TEXT        NOT NULL,

    /**
     * claimed  — linked, may FUND. Cannot receive a payout.
     * verified — money has arrived from it, so the wallet's holder authorised
     *            the link. May now receive.
     * removed  — the customer unlinked it. Final; linking again is a new row.
     */
    status      TEXT        NOT NULL DEFAULT 'claimed'
                CHECK (status IN ('claimed', 'verified', 'removed')),

    verified_at TIMESTAMPTZ NULL,
    removed_at  TIMESTAMPTZ NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT momo_accounts_uuid_key UNIQUE (uuid),

    /*
     * THE TIMESTAMP AND THE STATUS CANNOT DISAGREE — but only in the two
     * directions that are actually claims.
     *
     * Verified must carry its moment: a row saying so with nothing attached is
     * one nothing can date. Claimed must NOT carry one, or "verified" stops
     * being readable off the timestamp.
     *
     * A REMOVED ROW KEEPS WHATEVER IT HAD, and the first version of this
     * refused that — a biconditional on `verified` meant unlinking a verified
     * number was rejected by a CHECK, which is the schema erasing the fact
     * that money once arrived from that wallet in order to record that the
     * customer unlinked it. Both are true and both are history.
     */
    CONSTRAINT momo_verified_has_a_moment
        CHECK (status <> 'verified' OR verified_at IS NOT NULL),
    CONSTRAINT momo_claimed_has_no_moment
        CHECK (status <> 'claimed' OR verified_at IS NULL),
    CONSTRAINT momo_removed_has_a_moment
        CHECK ((status = 'removed') = (removed_at IS NOT NULL))
);

/*
 * ONE LIVE NUMBER PER CUSTOMER, and a PARTIAL UNIQUE INDEX rather than an
 * EXCLUDE constraint — 006's finding, which cost a release: `ON CONFLICT`
 * cannot target an EXCLUDE, so the loser of a concurrent link gets an error
 * instead of reading the winner's row, on a request a customer makes once.
 */
CREATE UNIQUE INDEX IF NOT EXISTS momo_one_live_per_customer
    ON momo_accounts (user_id) WHERE (status <> 'removed');

/*
 * AND ONE CUSTOMER PER NUMBER. Two accounts linking one wallet would let a
 * deposit from it be attributed to either — and it is the same argument 025
 * makes about one BVN and one person, applied to the identifier money
 * actually moves on here.
 */
CREATE UNIQUE INDEX IF NOT EXISTS momo_one_customer_per_number
    ON momo_accounts (msisdn) WHERE (status <> 'removed');

CREATE INDEX IF NOT EXISTS momo_by_customer ON momo_accounts (user_id, created_at DESC);

-- ---------------------------------------------------------------------------
--  THE DESTINATION IS IMMUTABLE ONCE THE ROW EXISTS, by trigger.
--
--  The same rule 043 applies to a bank payout and 006 to a virtual account: an
--  UPDATE moving the number would send authorised money to a wallet nobody
--  named, and every control that has already read this row would be describing
--  something else. Changing a number is removing one and linking another.
--
--  And verification is ONE WAY. A verified number cannot become claimed again,
--  for the reason a consumed refresh token can never be un-consumed: "this
--  wallet's holder authorised the link" is a statement about history, and one
--  UPDATE must not be able to erase the evidence of it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION assert_momo_immutable() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id  IS DISTINCT FROM OLD.user_id
       OR NEW.msisdn   IS DISTINCT FROM OLD.msisdn
       OR NEW.network  IS DISTINCT FROM OLD.network
       OR NEW.currency IS DISTINCT FROM OLD.currency THEN
        RAISE EXCEPTION
          'a linked mobile money number is immutable; remove it and link another';
    END IF;

    IF OLD.status = 'verified' AND NEW.status = 'claimed' THEN
        RAISE EXCEPTION 'a verified mobile money number cannot become unverified';
    END IF;

    IF OLD.status = 'removed' AND NEW.status <> 'removed' THEN
        RAISE EXCEPTION 'a removed mobile money number cannot be restored';
    END IF;

    RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS momo_is_immutable ON momo_accounts;
CREATE TRIGGER momo_is_immutable
    BEFORE UPDATE ON momo_accounts
    FOR EACH ROW EXECUTE FUNCTION assert_momo_immutable();

-- ---------------------------------------------------------------------------
--  What a screen reads. No email and no name — the same rule `payable_links`
--  follows: a view that could join an identifier to a person is a harvester
--  wherever it is later exposed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW linked_momo_accounts AS
SELECT m.uuid,
       m.user_id,
       m.network,
       m.msisdn,
       m.currency,
       m.status,
       m.verified_at,
       m.created_at
  FROM momo_accounts m
 WHERE m.status <> 'removed';

/*
 * 036 CLASSIFIES EVERY VIEW, in both directions, and fails the build on one
 * nobody decided about.
 *
 * `internal`: the application reads it to render one customer their own linked
 * wallet. It is not a queue anybody works and not a number an operator watches
 * — an operator looking at a customer's wallet does it from the customer
 * screen, which reads the same rows through the same service.
 */
INSERT INTO attention_sources (source, decision, rationale)
VALUES
  ('linked_momo_accounts', 'internal',
   'Read by the application to show one customer their own linked wallet. Not '
   'an operator surface: there is nothing here to work through.')
ON CONFLICT (source) DO NOTHING;

COMMENT ON VIEW linked_momo_accounts IS
  'The live linked mobile money number per customer. Carries no name and no '
  'email: it is an identifier money moves on, not a directory.';

-- ---------------------------------------------------------------------------
--  019 refuses a table with no retention decision, in both directions.
--
--  `keep`: it is part of the financial record of a relationship — the wallet
--  money arrived from and left to — which AML requires for five years after
--  that relationship ends. Erasure reaches it through the customer's own
--  deletion path, not through the sweep.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('momo_accounts', 'keep',
   'The wallet a customer funded from and was paid to. Part of the financial '
   'record of the relationship, which AML requires kept after it ends.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
