-- ===========================================================================
--  Xetral — 041: Buying a card, and naming it afterwards
--  packages/ledger/sql/041_card_issuance.sql
--
--  TWO THINGS THE CARD ONBOARDING SCREEN NEEDED AND THE SCHEMA COULD NOT
--  ANSWER.
--
--  1. THE SCREEN SHOWED A PRICE AND NOTHING CHARGED ONE. The reference design
--     puts "$5.00 · one-time payment" in the slot beside the Create card
--     button, and `transfer_fee_basis_points` was the only fee that existed
--     anywhere in this system — so the figure was either a starting balance
--     wearing a price's clothes, or a number a customer would be told they had
--     paid and would not have. A price on a screen has to be a price in the
--     ledger.
--
--     The fee is a `platform_settings` row for the reason every other
--     operational number is one: it is reviewed, it is bounded by the database
--     rather than by whichever endpoint happens to write it, and changing it
--     is not a deploy. It is US CENTS because the card is a dollar card and
--     the fee comes out of a dollar wallet — a kobo figure applied to a card
--     because both are integers is the mistake 032 records about the levy.
--
--     NO NEW ENTRY KIND IS NEEDED. `card_creation` has been in `entry_kind`
--     since 001 and nothing has ever posted one; this is what it was for.
--
--  2. A CUSTOMER WITH THREE CARDS COULD NOT TELL THEM APART. Every card face
--     reads "•••• 4242" and carries the same verified name, so a second card
--     — which the product actively offers — is indistinguishable from the
--     first at the moment somebody is choosing which one to spend from.
--
--     The label is OURS, not the provider's, and deliberately not
--     `name_on_card`: the name on a card is the cardholder's legal name, read
--     off a document by a reviewer, and it is not a field a customer may set.
-- ===========================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. WHAT A CARD COSTS
--
-- Two hundred cents. Bounded at zero and at 2,000 — free is a real answer (a
-- promotion, or an instance that does not charge), and $20 is far above any
-- plausible price for a virtual card, so a figure typed in dollars where cents
-- were meant is refused by the database rather than charged to a customer.
--
-- NOT `sensitive`: it is a price, and a finance operator adjusting one should
-- not need the role that can also enable gift card trading. The bound is what
-- makes that safe.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('card_issuance_fee_cents', '200', 'integer', 0, 2000,
   'Card issuance fee (US cents)',
   'What a customer pays to have a virtual USD card issued, in CENTS — 200 is '
   '$2.00. Taken from their USD wallet at the moment the card is created, as a '
   'card_creation entry, and split for VAT the same way a transfer fee is. Set '
   'it to 0 to issue cards free; the screen then says so rather than showing a '
   'price nothing charges.',
   'fees', FALSE)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. WHAT THE CUSTOMER CALLS IT
--
-- Nullable, because every card issued before this migration has no label and a
-- backfilled one would be a name we invented on somebody's behalf. The UI falls
-- back to the last four digits, which is what it showed before.
--
-- Bounded at 40 characters: long enough for "Subscriptions" or "Work travel",
-- short enough that it cannot become a notes field holding something that then
-- appears in a screenshot beside a card.
-- ---------------------------------------------------------------------------
ALTER TABLE cards
  ADD COLUMN IF NOT EXISTS label TEXT NULL;

ALTER TABLE cards
  DROP CONSTRAINT IF EXISTS cards_label_is_a_label;

ALTER TABLE cards
  ADD CONSTRAINT cards_label_is_a_label CHECK (
    label IS NULL OR length(btrim(label)) BETWEEN 1 AND 40
  );

COMMIT;
