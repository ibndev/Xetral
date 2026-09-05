-- ============================================================================
--  051 — how somebody puts money in, per country
--
--  WHAT WAS WRONG. The top-up screen offers one thing: Activate account, which
--  issues a dedicated NUBAN. That is how a Nigerian funds a wallet and it is
--  the only way this platform has ever offered — so a customer in Accra opened
--  the screen they go to in order to put money in and was offered a Nigerian
--  bank account they cannot pay into.
--
--  046 put the PAYOUT method on the country row, for exactly this shape of
--  problem in the other direction. This is the inbound half, and it is a
--  SEPARATE column rather than a reuse of that one: money in and money out are
--  different products with different approvals, which is the same argument
--  046 makes for keeping `payout_provider` apart from `funding_provider`. A
--  business can be live for dedicated accounts and not yet for collections.
--
--  AN ARRAY, because a country can have BOTH and Nigeria may yet. The screen
--  renders one panel per method, so adding one to a row is a new option on the
--  next load with no deploy — which is the point: the day Paystack issues
--  dedicated accounts in Ghana, an operator adds `virtual_account` to GH and
--  Ghanaian customers are offered it.
-- ============================================================================

BEGIN;

ALTER TABLE countries
    ADD COLUMN IF NOT EXISTS funding_methods TEXT[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
--  EVERY ENTRY MUST BE ONE THIS PLATFORM IMPLEMENTS.
--
--  A free-text array is a place to type `momo` and have a screen quietly not
--  render it — the failure `crypto_enabled` records, where a setting nothing
--  reads is worse than no setting because it is trusted.
-- ---------------------------------------------------------------------------
ALTER TABLE countries DROP CONSTRAINT IF EXISTS countries_funding_methods_known;
ALTER TABLE countries ADD CONSTRAINT countries_funding_methods_known
    CHECK (funding_methods <@ ARRAY['virtual_account', 'mobile_money']::TEXT[]);

-- ---------------------------------------------------------------------------
--  What is true TODAY, which is not the same as what is possible.
--
--  Nigeria has a dedicated account rail — Paystack by default, Bitnob as the
--  fallback — and both issue a NUBAN. Nowhere else does: Paystack's dedicated
--  accounts are a Nigerian product, and this row says so rather than a screen
--  assuming it.
--
--  Ghana and Kenya are marked `mobile_money` because that is how money moves
--  there, and marking it is what lets the screen say something true to a
--  customer in Accra instead of offering them a NUBAN. IT IS NOT A CLAIM THAT
--  THE RAIL IS BUILT: `funding_provider` still names who would carry it, and
--  the screen reads the platform's actual capability rather than this column
--  alone. What this column decides is what a customer is OFFERED.
-- ---------------------------------------------------------------------------
UPDATE countries SET funding_methods = ARRAY['virtual_account'] WHERE code = 'NG';
UPDATE countries SET funding_methods = ARRAY['mobile_money']    WHERE code IN ('GH', 'KE');

COMMENT ON COLUMN countries.funding_methods IS
  'How a customer here can put money in. `virtual_account` is a dedicated '
  'account number issued in their name; `mobile_money` is a local wallet. An '
  'array because a country can have both — add virtual_account to GH the day '
  'Paystack issues one there and the screen offers it on the next load.';

-- ---------------------------------------------------------------------------
--  A COUNTRY OPEN FOR BUSINESS WITH NO WAY IN is worth seeing.
--
--  Nothing refuses it — that would be a trigger stopping an operator opening
--  a country while they arrange the rail, which is the wrong order — but a
--  customer there can be paid by another Xetral customer and by a link and by
--  crypto, and can put nothing in themselves. That is a real state and a
--  temporary one, and it should be visible rather than discovered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW countries_without_a_way_in AS
SELECT code, name, currency
  FROM countries
 WHERE enabled AND cardinality(funding_methods) = 0;

COMMENT ON VIEW countries_without_a_way_in IS
  'Open countries where a customer cannot fund a wallet themselves. They can '
  'still be paid — by another customer, by a payment link, in crypto — so this '
  'is a gap rather than a fault, and it is the kind that is otherwise found by '
  'a customer rather than by us.';

INSERT INTO attention_sources (source, decision, queue_name, rationale)
VALUES ('countries_without_a_way_in', 'watch', NULL,
        'An open country with no funding rail. Customers there can be paid '
        'but cannot top up, which is a real and temporary state worth seeing '
        'rather than discovering from a support ticket.')
ON CONFLICT (source) DO UPDATE
   SET decision = EXCLUDED.decision,
       queue_name = EXCLUDED.queue_name,
       rationale = EXCLUDED.rationale;

COMMIT;
