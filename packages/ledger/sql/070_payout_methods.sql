-- ===========================================================================
--  070 — A COUNTRY OFFERS MORE THAN ONE WAY OUT
--
--  046 PUT ONE VALUE ON THE COUNTRY AND THAT WAS RIGHT AT THE TIME. The Send
--  screen was offering a Nigerian bank list in Accra, so `payout_method` said
--  which rail a country's money moves on and both the screen and the server
--  read the same row. The failure it fixed was real and the column is still
--  correct about what a country's DEFAULT rail is.
--
--  WHAT IT CANNOT SAY IS "BOTH", and Ghana and Kenya are both. Most people in
--  Accra are paid into an MTN wallet; plenty are also paid into a bank
--  account, and Flutterwave's transfers API serves both from the same
--  endpoint. One value meant offering a Ghanaian either a wallet or a bank and
--  never the choice — and adding a bank button on top of a single-valued
--  column would have been worse than the gap: 067 normalises the destination
--  by that same row, so a bank account number typed into a country marked
--  `mobile_money` is rewritten as a phone number and sent to a wallet that
--  does not exist. In the direction that cannot be recalled.
--
--  SO THE SET IS THE COLUMN AND THE SINGLE VALUE BECOMES THE DEFAULT.
--  `payout_methods` is what a country OFFERS; `payout_method` is which of them
--  a screen opens on. A CHECK keeps the second inside the first, so the
--  default can never be a rail the country does not offer.
--
--  AND THE PAYOUT RECORDS WHICH ONE IT USED. `bank_payouts.payout_method` is
--  immutable for 043's reason and 046's: the destination was normalised one
--  way, the provider was given one shape, and reading the rail off the country
--  afterwards would make every payout in flight unverifiable the moment an
--  operator changed what that country offers.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  What a country offers.
-- ---------------------------------------------------------------------------
ALTER TABLE countries
    ADD COLUMN IF NOT EXISTS payout_methods TEXT[] NOT NULL DEFAULT ARRAY['bank'];

/*
 * BACKFILL FIRST, THEN CONSTRAIN — and the order is not tidiness.
 *
 * The column defaults to `{bank}`, so on any real database Ghana and Kenya
 * arrive holding `payout_method = 'mobile_money'` and an offered set that
 * does not contain it. Adding the CHECK before the backfill therefore fails
 * on the second statement of the migration, with a message about a
 * constraint rather than about the data. Caught by running it.
 *
 * The first UPDATE reproduces exactly what each country already was, so a
 * deployment that stops here is unchanged rather than something new. Only
 * then are Ghana and Kenya widened.
 */
UPDATE countries SET payout_methods = ARRAY[payout_method]
 WHERE payout_methods = ARRAY['bank'] AND payout_method <> 'bank';

/*
 * GHANA AND KENYA OFFER BOTH, and the DEFAULT stays mobile money.
 *
 * That order is the decision rather than an accident of the array. Most
 * people in both countries are paid into a wallet, so the wallet is what the
 * screen opens on; a bank transfer is the second answer rather than the
 * absent one. Nigeria is untouched: there is no consumer mobile money rail
 * there for this platform to send to, and offering one would be 046's fault
 * in the other direction.
 */
UPDATE countries
   SET payout_methods = ARRAY['mobile_money', 'bank']
 WHERE code IN ('GH', 'KE')
   AND payout_method = 'mobile_money';

/*
 * THREE THINGS THE SET MUST BE, and each is a mistake somebody would
 * otherwise make once:
 *
 *   - NOT EMPTY. A country offering nothing is a country whose Send screen
 *     shows a heading and no options, which reads as a broken page rather
 *     than as a decision.
 *   - ONLY RAILS THAT EXIST. The same argument 046 makes for a CHECK over an
 *     enum: a new value needs an adapter anyway, so widening this is exactly
 *     the review that ought to happen.
 *   - IT MUST CONTAIN THE DEFAULT. Otherwise a screen opens on a rail the
 *     country does not offer, and the first thing a customer sees is the one
 *     option they cannot use.
 */
ALTER TABLE countries DROP CONSTRAINT IF EXISTS countries_payout_methods_known;
ALTER TABLE countries
    ADD CONSTRAINT countries_payout_methods_known CHECK (
        array_length(payout_methods, 1) >= 1
        AND payout_methods <@ ARRAY['bank', 'mobile_money']
        AND payout_method = ANY (payout_methods)
    );

COMMENT ON COLUMN countries.payout_methods IS
    'Every rail money can LEAVE on in this country. `payout_method` is which '
    'one a screen opens on and must be one of these.';

-- ---------------------------------------------------------------------------
--  Which rail a payout actually went out on.
-- ---------------------------------------------------------------------------
ALTER TABLE bank_payouts
    ADD COLUMN IF NOT EXISTS payout_method TEXT
        CHECK (payout_method IS NULL OR payout_method IN ('bank', 'mobile_money'));

COMMENT ON COLUMN bank_payouts.payout_method IS
    'The rail this payout was SENT on, recorded at the moment of sending. '
    'Nullable only for rows written before 070; immutable once set.';

/*
 * EVERY EXISTING ROW WENT OUT ON ITS COUNTRY'S ONLY RAIL, because until this
 * migration there was only one. That is a claim about HISTORY rather than a
 * guess — the same argument 050 makes about a row with no country having been
 * created when this platform operated in Nigeria alone.
 *
 * A row whose country is no longer in the table keeps NULL rather than being
 * assumed: 061's rule is repair, never assert.
 */
UPDATE bank_payouts p
   SET payout_method = c.payout_method
  FROM countries c
 WHERE c.code = p.country
   AND p.payout_method IS NULL;

/*
 * IMMUTABLE, like `provider` since 046 and the destination since 043.
 *
 * The number on the row was normalised FOR this rail — a wallet number in
 * E.164, a bank account exactly as typed — so a rail that could be edited
 * afterwards would describe a payout that was never made. And a payout
 * nothing can describe is a payout nothing can settle or reverse, which is
 * the state `bank_payouts_stuck` exists to count.
 */
CREATE OR REPLACE FUNCTION bank_payout_method_is_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.payout_method IS NOT NULL AND NEW.payout_method IS DISTINCT FROM OLD.payout_method THEN
        RAISE EXCEPTION 'a payout''s rail cannot change: it was sent on %', OLD.payout_method
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_payout_method_immutable ON bank_payouts;
CREATE TRIGGER bank_payout_method_immutable
    BEFORE UPDATE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION bank_payout_method_is_immutable();

/**
 * WHAT EACH COUNTRY OFFERS, for an operator opening `/admin/countries`.
 *
 * A country enabled for one rail while its customers are asking for the other
 * is invisible otherwise — the screen refuses, nothing errors, and the only
 * signal is somebody saying "I cannot send to a bank in Ghana".
 */
CREATE OR REPLACE VIEW country_payout_rails AS
SELECT c.code,
       c.name,
       c.currency,
       c.enabled,
       c.payout_method AS opens_on,
       c.payout_methods AS offers,
       array_length(c.payout_methods, 1) AS rail_count
  FROM countries c
 ORDER BY c.enabled DESC, c.name;

COMMENT ON VIEW country_payout_rails IS
    'Every country against the rails money can leave on there. One rail is not '
    'a fault; it is a fact to be able to see.';

INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'country_payout_rails',
    'internal',
    'A reference listing rather than a queue: it describes what each country '
    'offers and nothing here ever needs working. Read when somebody asks why '
    'a rail is missing on the Send screen.'
)
ON CONFLICT (source) DO NOTHING;

COMMIT;
