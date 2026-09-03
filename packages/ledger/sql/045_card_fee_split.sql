-- ============================================================================
--  045 — What a card costs US, separately from what it costs the CUSTOMER.
--
--  The customer pays $2 to have a card issued, and the issuer charges the
--  platform for issuing it. Until now the whole $2 was booked as revenue and
--  the provider's charge appeared nowhere — so the margin on a card looked
--  like 100% and the cost of the product was invisible.
--
--  TWO NUMBERS, NOT ONE SPLIT. `card_issuance_fee_cents` is a PRICE: what a
--  customer is charged, set by this business. This one is a COST: what the
--  issuer bills us, set by them. Storing "$1 of the $2" as a single split
--  would tie the two together, so a price rise would silently look like a
--  bigger provider bill and a renegotiated bill would silently reprice the
--  card. They move for unrelated reasons and are unrelated numbers.
--
--  THE ACCOUNTING IS TWO INDEPENDENT PAIRS on one entry:
--
--    customer_wallet        -gross     what they paid
--    revenue_fees           +net       what we earned, less VAT
--    liability_tax_payable  +tax       what we owe onward
--
--    expense_provider_cost  +cost      what issuing cost us
--    provider_float         -cost      taken from our balance at the issuer
--
--  Each pair sums to zero on its own, so the entry balances whatever either
--  number is — and the two facts stay separable in the books. Netting them
--  into a single revenue line would report $1 of turnover on a $2 sale, which
--  understates the business and hides the cost at the same time.
-- ============================================================================

BEGIN;

INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category)
VALUES
  ('card_issuance_provider_cost_cents', '100', 'integer', 0, 2000,
   'Card issuance provider cost (cents)',
   'What the card ISSUER charges us to create one, in US cents. Booked as a '
   'provider cost against our balance with them — not netted off revenue, so '
   'the margin on a card is a number somebody can see. Set to what the issuer '
   'actually bills: the shipped 100 is the commonly quoted figure and is a '
   'starting point, not a verified contract term. Zero is legitimate and '
   'means issuing costs us nothing.',
   'fees')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  WHAT THE CARD LOOKS LIKE.
--
--  Three finishes, chosen at creation. A CHECK rather than a free string,
--  because the value names a stylesheet class in two apps: an unrecognised
--  one is a card that renders with no face at all, and the database is where
--  a typo can be stopped rather than discovered.
--
--  Not an enum, deliberately. Adding a fourth finish to an enum is an
--  ALTER TYPE that cannot run inside a transaction with other statements on
--  some Postgres versions; a CHECK is a one-line migration. This is
--  presentation, and presentation changes more often than money does.
--
--  DEFAULT `graphite`, so every card issued before this migration has the
--  face it already had rather than a NULL the apps would each have to guess
--  about.
-- ---------------------------------------------------------------------------
ALTER TABLE cards
    ADD COLUMN IF NOT EXISTS colour TEXT NOT NULL DEFAULT 'graphite'
        CHECK (colour IN ('graphite', 'sapphire', 'emerald'));

COMMIT;
