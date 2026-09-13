-- ===========================================================================
--  071 — THE WALLET RESOLVER IS A DIFFERENT ENDPOINT, AND GHANA NEEDS A
--        BRANCH CODE
--
--  FIVE ROUNDS OF "IT SAYS IT CANNOT FIND THE MOMO DETAILS", and this is the
--  round where the vendor's own specification was read rather than a search
--  result.
--
--  069 RECORDED THAT THE REFUSAL WAS NEVER WRITTEN DOWN, which was true and
--  was the reason nobody could see the cause. The cause is now visible, and
--  IT IS THAT WE WERE CALLING THE WRONG ENDPOINT. Flutterwave's own published
--  v3 specification — the one vendored in their engineers' MCP server —
--  describes `POST /v3/accounts/resolve` as:
--
--      "Resolve a BANK ACCOUNT number ... Requires account_number (10 digits)
--       and account_bank (bank code). account_bank: Bank code (3 DIGITS)."
--
--  We were sending `account_bank: "MTN"` and a twelve-digit phone number.
--  Both fields were wrong for that endpoint, and no spelling of either was
--  ever going to work: THERE IS NO MOBILE MONEY IN v3'S RESOLVER AT ALL.
--
--  A CLAIM THIS REPO MADE TWO ROUNDS AGO WAS FALSE. `CLAUDE.md` records that
--  "Flutterwave's own documentation for /v3/accounts/resolve lists GHANAIAN
--  MOBILE MONEY NUMBERS among what it accepts". It came from a search
--  snippet, not from a specification, and it replaced one wrong belief with
--  another. The lesson is Phase 3's, for the third time: a plausible constant
--  from a plausible source, agreed with by a test written from the same
--  assumption.
--
--  THE WALLET RESOLVER EXISTS IN v4: `POST /wallet-account/resolve`, taking
--  `{ account_number, mobile_network, country }` and answering `account_name`.
--  It is a separate API version with OAuth2 client credentials rather than a
--  bearer secret key, which is why it needs its own two credential slots.
--
--  v3 IS NOT DEPRECATED and money movement stays on it. What moves to v4 is
--  ONE READ that moves nothing — the smallest surface that answers the
--  question, rather than a rewrite of every payout under a deadline.
--
--  AND GHANA'S BANK TRANSFERS NEED A BRANCH CODE. Flutterwave: "When
--  transferring to Ghanaian bank accounts and mobile money wallets, you need
--  to pass the branch code of the institution or telco in your Initiate
--  Transfer request as destination_branch_code." 070 added the bank rail for
--  Ghana and it would have failed on every transfer without this.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Two more credentials, and only for the v4 read.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots
  (provider, name, label, description, env_var, in_use)
VALUES
  ('flutterwave', 'v4_client_id', 'Flutterwave v4 client ID',
   'Generated under the v4 Developer toggle on Flutterwave''s dashboard. It '
   'is NOT the secret key and does not replace it: v4 authorises with OAuth2 '
   'client credentials, and this platform uses v4 for exactly one thing — '
   'looking up the name on a mobile money wallet, which v3 has no endpoint '
   'for at all. Money still moves on v3.',
   'FLUTTERWAVE_V4_CLIENT_ID', TRUE),
  ('flutterwave', 'v4_client_secret', 'Flutterwave v4 client secret',
   'The other half of the v4 OAuth2 pair. Without BOTH, a mobile money '
   'recipient cannot be named — the send still works, and the screen asks '
   'the customer for a label instead, exactly as it does in Kenya.',
   'FLUTTERWAVE_V4_CLIENT_SECRET', TRUE)
ON CONFLICT (provider, name) DO UPDATE
   SET label       = EXCLUDED.label,
       description = EXCLUDED.description,
       env_var     = EXCLUDED.env_var,
       in_use      = EXCLUDED.in_use;

-- ---------------------------------------------------------------------------
--  Money comes IN the same ways it goes OUT.
-- ---------------------------------------------------------------------------
/*
 * 070 GAVE GHANA AND KENYA TWO WAYS OUT AND LEFT ONE WAY IN.
 *
 * `funding_methods` has said `{mobile_money}` for both since 051, so a
 * Ghanaian could be PAID to a bank account and could not PAY IN from one —
 * which is a strange product to hold in your hand: the Send screen offers a
 * choice the Add Money screen does not.
 *
 * FLUTTERWAVE OFFERS BOTH THERE. Their own announcement — "Introducing Ghana
 * Virtual Accounts: Pay With Bank Transfer Is Now Available In Ghana" — and
 * `banktransfer` is already among the `payment_options` this platform sends
 * for Kenya. GHS was the one corridor still asking for `mobilemoneyghana`
 * alone.
 *
 * `bank_transfer` RATHER THAN `virtual_account`, and the difference matters.
 * A virtual account is a permanent number issued in a customer's own name
 * (006); pay-with-bank-transfer is a checkout that shows a one-off account to
 * pay into. Calling the second one the first would make the Add Money screen
 * offer to "activate your account number" and then hand back something that
 * expires — 046's rule about offering a product the customer's money cannot
 * reach, pointed inward.
 */
ALTER TABLE countries DROP CONSTRAINT IF EXISTS countries_funding_methods_known;
ALTER TABLE countries ADD CONSTRAINT countries_funding_methods_known
    CHECK (funding_methods <@ ARRAY['virtual_account', 'mobile_money', 'bank_transfer']::TEXT[]);

UPDATE countries
   SET funding_methods = ARRAY['mobile_money', 'bank_transfer']
 WHERE code IN ('GH', 'KE')
   AND funding_methods = ARRAY['mobile_money'];

COMMENT ON COLUMN countries.funding_methods IS
  'How a customer here can put money in. `virtual_account` is a dedicated '
  'account number issued in their name; `mobile_money` is a local wallet; '
  '`bank_transfer` is a checkout that shows a one-off account to pay into. '
  'An empty set is a country nobody can fund, which countries_without_funding '
  'reports.';

-- ---------------------------------------------------------------------------
--  Which BRANCH a Ghanaian transfer named.
-- ---------------------------------------------------------------------------
/*
 * GHANA REFUSES A TRANSFER WITHOUT A BRANCH CODE, and 070 gave Ghana a bank
 * rail that would have been refused on every send.
 *
 * FLUTTERWAVE, VERBATIM: "When transferring to Ghanaian bank accounts and
 * mobile money wallets, you need to pass the branch code of the institution or
 * telco in your Initiate Transfer request as destination_branch_code."
 *
 * IT IS PART OF THE DESTINATION, so it is immutable for 043's reason: the row
 * records what the rail was GIVEN, and a branch that could be edited
 * afterwards would describe a transfer nobody made. Nullable because every
 * other corridor has none, and an empty string would be a value their API has
 * to decide what to do with.
 */
ALTER TABLE bank_payouts
    ADD COLUMN IF NOT EXISTS branch_code TEXT
        CHECK (branch_code IS NULL OR branch_code ~ '^[A-Za-z0-9-]{2,32}$');

COMMENT ON COLUMN bank_payouts.branch_code IS
    'The destination branch, where the corridor requires one -- Ghana today. '
    'Part of the destination and immutable with it.';

CREATE OR REPLACE FUNCTION bank_payout_branch_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.branch_code IS NOT NULL AND NEW.branch_code IS DISTINCT FROM OLD.branch_code THEN
        RAISE EXCEPTION 'a payout''s branch cannot change: it was sent to %', OLD.branch_code
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_payout_branch_immutable ON bank_payouts;
CREATE TRIGGER bank_payout_branch_immutable
    BEFORE UPDATE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION bank_payout_branch_is_immutable();

/*
 * AND A SAVED RECIPIENT REMEMBERS THEIRS.
 *
 * 068's whole argument is that the first screen is a list of people rather
 * than an empty field — a saved recipient is tapped WITHOUT re-reading. A
 * Ghanaian bank recipient with no branch on the row would be tapped, sent to,
 * and refused, with nothing on the screen to fix because the screen that asks
 * for a branch was skipped.
 *
 * IMMUTABLE WITH THE DESTINATION, by 068's existing trigger's argument: a row
 * a customer taps without re-reading is one whose destination must not be
 * editable, and the branch is part of where the money goes.
 */
ALTER TABLE recipients
    ADD COLUMN IF NOT EXISTS branch_code TEXT
        CHECK (branch_code IS NULL OR branch_code ~ '^[A-Za-z0-9-]{2,32}$');

COMMENT ON COLUMN recipients.branch_code IS
    'The destination branch, where the corridor requires one -- Ghana today. '
    'Part of the destination and immutable with it.';

/*
 * 068'S TRIGGER, WITH THE BRANCH ADDED TO WHAT IT GUARDS.
 *
 * REPLACED RATHER THAN JOINED BY A SECOND TRIGGER, for 019's reason about
 * `apply_retention()`: a rule in two pieces is a rule where one piece stops
 * being called. The body below is 068's with one more field named — a branch
 * that could be edited would redirect every future payment to that recipient,
 * which is the whole argument the original makes about the number.
 */
CREATE OR REPLACE FUNCTION assert_recipient_destination_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.user_id     IS DISTINCT FROM OLD.user_id
       OR NEW.kind     IS DISTINCT FROM OLD.kind
       OR NEW.country  IS DISTINCT FROM OLD.country
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.rail_code IS DISTINCT FROM OLD.rail_code
       OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
       OR NEW.destination IS DISTINCT FROM OLD.destination THEN
        RAISE EXCEPTION 'a recipient''s destination is immutable; remove it and add another'
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN
        RAISE EXCEPTION 'a removed recipient cannot be restored'
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

/**
 * WHAT A COUNTRY CAN DO IN BOTH DIRECTIONS, side by side.
 *
 * A country that can be paid out to and cannot be funded — or the reverse —
 * is a half-open corridor, and neither half reports the other. An operator
 * reading this sees both columns at once, which is the whole point of putting
 * them in one row.
 */
CREATE OR REPLACE VIEW country_money_paths AS
SELECT c.code,
       c.name,
       c.currency,
       c.enabled,
       c.funding_methods AS money_in,
       c.payout_methods  AS money_out,
       /* The asymmetry, named. A customer can be paid on a rail they cannot
          pay in on, and that is a product decision rather than a fault — but
          it should be one somebody MADE. */
       ARRAY(
         SELECT m FROM unnest(c.payout_methods) AS m
          WHERE m <> 'bank' AND NOT (m = ANY (c.funding_methods))
       ) AS out_only
  FROM countries c
 ORDER BY c.enabled DESC, c.name;

COMMENT ON VIEW country_money_paths IS
    'Money in against money out, per country. A rail in one column and not '
    'the other is a half-open corridor.';

INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'country_money_paths',
    'internal',
    'A reference listing rather than a queue: it describes what each country '
    'can do in each direction and nothing here is ever worked. Read when '
    'somebody asks why Add Money offers less than Send does.'
)
ON CONFLICT (source) DO NOTHING;

COMMIT;
