-- ============================================================================
--  080 — whether a payout's `provider` is a fact or a default
--
--  046 ADDED `bank_payouts.provider` AND NOTHING EVER WROTE IT. The INSERT in
--  PayoutService named sixteen columns and not that one, so every payout since
--  has read the column's DEFAULT — `bitnob` — whoever actually sent it. The
--  sweep and the `transfer.*` webhook both ask `row.provider` about a payout,
--  so a Flutterwave transfer was asked about at Bitnob:
--
--    * on a deployment without Bitnob, a thrown error — the webhook answered
--      500 and Flutterwave retried it for ever, so no Ghanaian or Kenyan
--      payout's final state was ever applied;
--    * with Bitnob, "no such payout" — which the sweep reads as a DEFINITE
--      refusal and REVERSES, refunding the customer for money that had left.
--
--  THE ROWS ALREADY WRITTEN CANNOT BE REPAIRED FROM SQL, and this migration
--  does not pretend to. Paystack and Flutterwave both issue numeric transfer
--  ids and both serve naira, so nothing in a row says which one sent it. What
--  CAN be said is that the column is not evidence — so it is marked, and the
--  code asks every rail and accepts only an answer carrying OUR reference,
--  and never reads a refusal from a guessed rail as an outcome.
--
--  `provider` stays immutable (046). A default that was wrong is not
--  corrected by rewriting it to another guess.
-- ============================================================================

BEGIN;

ALTER TABLE bank_payouts
    ADD COLUMN IF NOT EXISTS provider_known BOOLEAN NOT NULL DEFAULT FALSE;

-- Every row written from here on names its rail, so the default flips. Rows
-- that existed before this line keep FALSE, which is the truth about them.
ALTER TABLE bank_payouts ALTER COLUMN provider_known SET DEFAULT TRUE;

COMMENT ON COLUMN bank_payouts.provider_known IS
  'TRUE when `provider` was recorded by the code that chose the rail. FALSE for '
  'rows written before 080, whose `provider` is the column default and may not '
  'be the rail that sent them.';

-- Once known, always known; and a guess cannot be promoted to a fact by an
-- UPDATE, because nothing new has been learnt about which rail sent it.
CREATE OR REPLACE FUNCTION bank_payout_provider_known_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.provider_known IS DISTINCT FROM OLD.provider_known THEN
        RAISE EXCEPTION 'whether a payout''s provider is known cannot change: % -> %',
            OLD.provider_known, NEW.provider_known;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_payout_provider_known_immutable ON bank_payouts;
CREATE TRIGGER bank_payout_provider_known_immutable
    BEFORE UPDATE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION bank_payout_provider_known_is_immutable();

COMMIT;
