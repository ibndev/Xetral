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
 * AND THE COLUMN IS DELIBERATELY NOT TOUCHED — a correction to this
 * migration's own first draft, which turned CI red.
 *
 * It appended `virtual_account` to Ghana and Kenya, and 051's invariant says
 * in as many words: "a NUBAN is offered outside Nigeria" is a TEST FAILURE.
 * That invariant is right and the append was wrong, for a reason that is
 * about the word rather than about the product: a NUBAN is a NIGERIAN bank
 * account number. Whatever Flutterwave issues in Accra, it is not one, and
 * `funding_methods` is what the SCREEN reads to decide which rails to name.
 *
 * THE BUTTON DID NOT NEED THE COLUMN ANYWAY. Add Money no longer gates
 * Activate Account on `funding_methods` at all — it offers it wherever the
 * platform operates and lets the rail answer, which is the whole point of the
 * adapter no longer refusing non-NGN currencies in its own code. So the data
 * change bought nothing and cost an invariant.
 *
 * WHAT IS RECORDED HERE INSTEAD is the DECISION and the view that watches it.
 * If Flutterwave is confirmed to issue dedicated numbers in a new market, the
 * column and 051's assertion move together, in one migration, with the
 * provider's own answer as the evidence — rather than one of them drifting
 * ahead of the other because a button needed to appear.
 */

/*
 * EVERY PAYOUT RECORDS ITS RAIL, INCLUDING THE ONES NOBODY TOLD.
 *
 * 070 added `bank_payouts.payout_method` and BACKFILLED it from the country,
 * then asserted that no payout in a known country is left without one. That
 * assertion was true at the moment the migration ran and false ever after: it
 * describes a one-off UPDATE rather than a property of the table, so the next
 * INSERT that omits the column breaks it. CI found it immediately — six rows,
 * written by the test files that run AFTER the migrations.
 *
 * A BACKFILL IS NOT AN INVARIANT. The fix is not to weaken the assertion, it
 * is to make the thing it asserts actually true: the column is filled from
 * the country on the way in, by the same reasoning the backfill used — until
 * 070 a country had exactly one rail, so the country IS the evidence for a
 * row that did not say. Rule 4: if it protects money it is a constraint or a
 * trigger, not a statement somebody remembered to make.
 *
 * IT NEVER OVERRIDES. A service that names the rail — which every live path
 * does, since 070 put it in the INSERT — is untouched, and the immutability
 * trigger 070 installed still refuses a later change. This only speaks for
 * the rows that arrive silent.
 */
CREATE OR REPLACE FUNCTION bank_payout_rail_from_country()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.payout_method IS NULL THEN
        SELECT c.payout_method INTO NEW.payout_method
          FROM countries c
         WHERE c.code = NEW.country;
    END IF;
    RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS bank_payout_rail_default ON bank_payouts;
CREATE TRIGGER bank_payout_rail_default
    BEFORE INSERT ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION bank_payout_rail_from_country();

/* And the rows already written by anything that ran between 070 and here. */
UPDATE bank_payouts p
   SET payout_method = c.payout_method
  FROM countries c
 WHERE c.code = p.country
   AND p.payout_method IS NULL;

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
