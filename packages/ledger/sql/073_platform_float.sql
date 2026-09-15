-- ===========================================================================
--  073 — WHAT THE PLATFORM ITSELF HOLDS, PER CURRENCY
--
--  FLUTTERWAVE IS A PREFUNDED WALLET. It debits the balance matching the
--  payout currency, so a cedi payout needs a cedi float — and a deployment
--  that has never collected a cedi has none. Every Ghanaian transfer then
--  fails with a message about funds, which reads as a bug in the integration
--  and is not one. CLAUDE.md records that sentence; nothing in the schema
--  could answer the question it raises, which is "how much DO we hold?"
--
--  THE LEDGER ALREADY KNEW AND NOTHING ASKED IT. A collection posts
--  `provider_float -> customer_wallet` and a payout settles
--  `customer_pending -> provider_float`, so the platform's position in a
--  currency has been maintained by trigger since Phase 1 — as the NEGATIVE of
--  the `provider_float` balance, because liabilities are positive here and an
--  asset held on our behalf is therefore negative. That inversion is exactly
--  why nobody read it: a figure whose sign means the opposite of what it
--  looks like is one people quietly stop trusting.
--
--  SO THIS MIGRATION ADDS NO TABLE AND NO TRIGGER. It is two views and a
--  setting. A second table recording "what we hold" would be a second copy of
--  the truth that drifts the first time a flow forgets to update it — the
--  argument `entry_status` makes about a stored status column, and the one
--  balances themselves are computed under.
--
--  WHAT IT IS NOT. `provider_float` is ONE account per currency and not one
--  per provider, so `held_minor` is the platform's position across every rail
--  serving that currency. For GHS and KES that is Flutterwave alone, because
--  059 routes both operations there and nothing else touches those currencies
--  — which is the case this exists for. For NGN it is Paystack and Bitnob
--  together, and the payout guard does not apply to naira at all: neither of
--  those rails is prefunded, so there is no float to run out of and a figure
--  spanning two of them would answer a question nobody asked.
-- ===========================================================================
BEGIN;

/*
 * THE PLATFORM'S POSITION, WITH THE SIGN TURNED THE RIGHT WAY UP.
 *
 * `held_minor` is positive when a provider holds money for us and negative
 * when we are overdrawn with them — which is the ordinary reading, and the
 * opposite of the raw balance. The raw figure is carried beside it rather
 * than hidden, so an operator comparing this against `ledger_drift` or a
 * posting listing is not left wondering which of two numbers is real.
 */
CREATE VIEW platform_float_positions AS
SELECT
    a.currency,
    -- MINOR UNITS, and it says so. A major-unit figure here would be a
    -- decimal holding money, which is the one thing this schema refuses.
    (-b.balance_minor)::BIGINT                       AS held_minor,
    b.balance_minor                                  AS ledger_balance_minor,
    b.updated_at                                     AS last_movement_at,
    /*
     * WHAT IS ALREADY SPOKEN FOR AND NOT YET SUBTRACTED.
     *
     * ONLY `reserved`, and that is the whole subtlety. A payout moves to
     * `sent` by POSTING to `provider_float`, so a sent one is already in
     * `held_minor` and counting it again would subtract it twice. A reserved
     * one has touched nothing but the customer's own wallet, so the float
     * still shows money that is spoken for.
     *
     * Leaving it out entirely is what lets two concurrent payouts each find
     * the same cedis available — the race the guard exists to prevent rather
     * than a rounding detail.
     */
    COALESCE((
        SELECT SUM(p.amount_minor)
          FROM bank_payouts p
         WHERE p.currency = a.currency
           AND p.status = 'reserved'
    ), 0)::BIGINT                                    AS committed_minor
  FROM accounts a
  JOIN account_balances b ON b.account_id = a.id
 WHERE a.kind = 'provider_float';

COMMENT ON VIEW platform_float_positions IS
    'What Xetral holds at its providers, per currency, as the negative of the '
    'provider_float balance. `committed_minor` is what reserved payouts will '
    'draw on but have not yet.';

/*
 * THE ONE AN OPERATOR IS MEANT TO READ, and the reason it is separate.
 *
 * A position view lists every currency including the healthy ones, which is
 * right for a dashboard and wrong for a queue: 036's rule is that a queue
 * nobody thought of is the one that silently fills, and a list where nothing
 * is ever wrong is one people stop opening. This returns rows only when a
 * currency cannot cover what is already committed against it.
 */
CREATE VIEW platform_float_shortfalls AS
SELECT currency,
       held_minor,
       committed_minor,
       (committed_minor - held_minor)::BIGINT AS short_by_minor
  FROM platform_float_positions
 WHERE committed_minor > held_minor;

COMMENT ON VIEW platform_float_shortfalls IS
    'Currencies where committed payouts exceed what the platform holds at its '
    'providers. A prefunded rail will refuse these transfers; the guard in '
    'PayoutService refuses them first, with a reason that names the cause.';

/*
 * THE OFF SWITCH, AND WHY THERE IS ONE.
 *
 * The guard ships ON, because the failure it replaces is worse than the one
 * it can cause: without it a Ghanaian transfer reaches Flutterwave, is
 * refused for want of float, and comes back as a sentence about an account —
 * which has now sent three rounds of customers to check digits that were
 * correct. With it the refusal says what is actually wrong, before any money
 * is held.
 *
 * BUT THE LEDGER IS NOT THE ONLY WAY FLOAT ARRIVES. An operator can wire
 * cedis to Flutterwave directly, and that funding is real and is recorded
 * nowhere here — so a platform genuinely able to pay would be refusing every
 * transfer, and the only remedy would be a release. 009's argument is that an
 * operational decision taken under pressure must not be one, so this is a row.
 *
 * It is deliberately a SINGLE switch rather than a per-currency list. A list
 * invites turning off the one corridor that is complaining, which is how the
 * guard ends up switched off everywhere one currency at a time; one switch
 * makes it an explicit, visible, auditable decision about the whole control.
 */
INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category,
     sensitive)
VALUES (
    'payout_float_guard_enabled', 'true', 'boolean', NULL, NULL,
    'Refuse payouts we cannot fund',
    'Refuses a payout on a PREFUNDED rail — Flutterwave today — when the '
    'platform does not hold enough of that currency at the provider. Turn it '
    'off only where float is funded outside the ledger, such as a wire sent '
    'straight to the provider: the refusal it prevents still happens, it just '
    'arrives from the provider afterwards as a message about the customer''s '
    'own account.',
    'features',
    /* SENSITIVE, because switching it off lets payouts reach a rail that
     * cannot fund them — which fails in the direction that has already cost
     * three rounds of customers being told their own details were wrong. */
    TRUE
)
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  036'S COVERAGE CHECK DEMANDS A DECISION ON EVERY VIEW, in both directions.
-- ---------------------------------------------------------------------------
INSERT INTO attention_sources (source, decision, rationale) VALUES
  ('platform_float_positions', 'internal',
   'A POSITION, not a queue and not a watch. It lists every currency the '
   'platform holds a float in, including the healthy ones, so there is never '
   'a row here that means something is wrong — which is exactly why the '
   'shortfall is its own view. This one is what a screen renders and what an '
   'operator reads before deciding how much to prefund.'),
  ('platform_float_shortfalls', 'watch',
   'Currencies where payouts already reserved exceed what the platform holds '
   'at its providers. Not a queue, because there is nothing here for an '
   'operator to work THROUGH — the single action is to send the provider more '
   'of that currency, and every row clears at once when they do. It is a '
   'watch for the reason ledger_drift is: a row means a number somebody has '
   'to act on, not a task somebody has to tick off.')
ON CONFLICT (source) DO NOTHING;

COMMIT;
