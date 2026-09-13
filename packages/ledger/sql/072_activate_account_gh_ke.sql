-- ===========================================================================
--  072 — ASK THE RAIL WHETHER IT WILL OPEN AN ACCOUNT, RATHER THAN DECIDING
--        HERE THAT IT WILL NOT
--
--  ADD MONEY IN ACCRA AND NAIROBI HAD NO "ACTIVATE ACCOUNT" BUTTON AT ALL.
--  051 recorded `funding_methods = {mobile_money}` for GH and KE, the screen
--  gated the button on `virtual_account`, and the Flutterwave adapter refused
--  every non-NGN currency in its own code BEFORE MAKING A CALL.
--
--  EVERY ONE OF THOSE THREE WAS A COPY OF ONE BELIEF, and the belief was
--  never checked against Flutterwave. That is the identical shape to
--  `RESOLVES_MOBILE_MONEY`, which asserted for three rounds that a Ghanaian
--  wallet has no name enquiry: a claim enforced before the call is
--  UNFALSIFIABLE, because nothing in any log, table or screen can contradict
--  a request that was never sent.
--
--  AND THE BELIEF IS AT BEST OUT OF DATE. Flutterwave have announced Ghanaian
--  virtual accounts — 071 already widened `funding_methods` to carry
--  `bank_transfer` on the strength of it. Whether a PERMANENT number exists
--  in each market is their answer to give, not ours to assume.
--
--  SO THE BUTTON IS OFFERED AND THE PROVIDER DECIDES. Where they refuse, the
--  customer gets `account_issue_refused` carrying THEIR reason — 006's rule,
--  a sentence an operator can act on — instead of a hidden control, which is
--  a silence nobody can act on at all.
--
--  WHAT THIS DOES NOT DO is promise the product. `funding_methods` says what
--  a customer here may be OFFERED; `provider_route_coverage` and the refusal
--  trail say what actually answers. Those were always two different questions
--  and collapsing them is what hid this one.
-- ===========================================================================

BEGIN;

/*
 * GHANA AND KENYA MAY NOW ASK FOR AN ACCOUNT NUMBER.
 *
 * APPENDED, NEVER REPLACED. Both rows carry `mobile_money` (051) and
 * `bank_transfer` (071), and every one of those is still true — this adds a
 * third way in rather than choosing between them. Guarded on absence so the
 * migration is idempotent and so an operator who has already decided
 * otherwise is not overruled, which is 061's rule: repair, never assert.
 */
UPDATE countries
   SET funding_methods = funding_methods || ARRAY['virtual_account']::TEXT[]
 WHERE code IN ('GH', 'KE')
   AND NOT ('virtual_account' = ANY (funding_methods));

/**
 * WHERE A COUNTRY MAY ASK FOR AN ACCOUNT AND NO RAIL IS ROUTED TO ANSWER.
 *
 * Offering the button is a decision about the SCREEN; whether anything can
 * serve it is a decision about `provider_routes`, and 059's whole argument is
 * that those are different questions. A country in this view has a control
 * whose only possible outcome is a refusal — which is worth seeing, and is
 * exactly what nobody could see while the belief lived in three files.
 */
CREATE OR REPLACE VIEW countries_offering_an_unrouted_account AS
SELECT c.code,
       c.name,
       c.currency
  FROM countries c
 WHERE c.enabled
   AND 'virtual_account' = ANY (c.funding_methods)
   AND NOT EXISTS (
         SELECT 1 FROM provider_routes r
          WHERE r.operation = 'collect'
            AND r.currency = c.currency
       )
 ORDER BY c.name;

COMMENT ON VIEW countries_offering_an_unrouted_account IS
    'A country whose Add Money screen offers an account number while no '
    'collection rail is routed for its currency. The button can only refuse.';

INSERT INTO attention_sources (source, decision, rationale)
VALUES (
    'countries_offering_an_unrouted_account',
    'watch',
    'A control whose only outcome is a refusal. Not a queue — nothing here is '
    'worked item by item — but a standing gap between what a screen offers '
    'and what any rail is routed to answer, which is the pair 059 keeps apart '
    'on purpose and which nothing else compares.'
)
ON CONFLICT (source) DO NOTHING;

COMMIT;
