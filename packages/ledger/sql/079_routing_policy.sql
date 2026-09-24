-- ============================================================================
--  079 — how the route table is READ: per route, by documented coverage, or
--        one provider for everything; and whether an account request may try
--        the next rail after a refusal
--
--  THE ROUTE TABLE ANSWERS ONE CELL AT A TIME, and the product owner's
--  question is about the whole grid. "Let Bitnob handle the countries it
--  documents and Flutterwave theirs" and "let one provider carry everything"
--  are both sentences an operator could only express by flipping every cell by
--  hand — and a cell left behind is a corridor quietly served by a rail
--  nobody chose.
--
--  SO THE POLICY IS ONE ROW, AND THE ROUTE TABLE STAYS WHAT IT WAS.
--    per_route    — the route table decides, exactly as since 059.
--    by_coverage  — each (operation, currency) goes to a provider whose
--                   documented coverage includes it, the PREFERRED one where
--                   more than one does. The route table answers what nothing
--                   covers.
--    single       — one provider carries every operation it covers; what it
--                   does not cover (Bitnob has no hosted checkout) falls back
--                   to the route table rather than becoming an outage.
--
--  COVERAGE IS WHAT THIS PLATFORM HAS AN ADAPTER FOR, per provider, not a
--  marketing page. Paystack's Nigerian registration settles naira only;
--  Bitnob collects through account numbers and has no hosted checkout here.
--  A provider claiming a corridor this codebase cannot reach would be a
--  toggle that silently falls back — the fault 076 records about the switch.
--  It is a table rather than a constant so the screen can show it and a
--  migration can widen it with its evidence, never a form.
--
--  AND `account_fallback`, which is what made Activate Account fail in both
--  countries. A naira account number on Flutterwave needs a verified BVN, and
--  the route table said Flutterwave, so every unverified Nigerian was refused
--  with nothing else asked — while Paystack, one row away, opens a tier 1
--  account from a name. With the fallback on, a DEFINITE refusal (never a
--  timeout: that may have opened an account) moves to the next rail that
--  covers the currency. It ships ON because the alternative is the screen a
--  customer opens to be paid telling them no when another rail would say yes.
--
--  WHO CHANGED IT, AND FROM WHAT, is written by trigger — 026's rule: a write
--  the endpoint performs is a write a psql prompt skips.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Which provider this codebase can use for which money.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_coverage (
    provider   TEXT NOT NULL CHECK (provider IN ('paystack', 'flutterwave', 'bitnob')),
    operation  TEXT NOT NULL CHECK (operation IN ('account', 'collect', 'payout')),
    currency   TEXT NOT NULL CHECK (currency ~ '^[A-Z]{3,4}$'),
    /* Why this is believed. A coverage row nobody can trace is the table of
     * plausible constants this repo has shipped three times. */
    basis      TEXT NOT NULL CHECK (length(basis) >= 20),
    PRIMARY KEY (provider, operation, currency)
);

COMMENT ON TABLE provider_coverage IS
  'Which provider can serve which operation in which currency, as integrated '
  'here. Read by the by_coverage and single routing modes and by the account '
  'fallback. Widened by migration with its evidence, never from a form.';

INSERT INTO provider_coverage (provider, operation, currency, basis) VALUES
  ('paystack',    'account', 'NGN', 'Dedicated virtual accounts, POST /dedicated_account (044)'),
  ('paystack',    'collect', 'NGN', 'Hosted checkout, POST /transaction/initialize (058)'),
  ('paystack',    'payout',  'NGN', 'Transfer recipient then POST /transfer (046)'),
  ('flutterwave', 'account', 'NGN', 'Permanent virtual account, POST /v3/virtual-account-numbers with BVN (076)'),
  ('flutterwave', 'collect', 'NGN', 'Hosted checkout, POST /v3/payments (059)'),
  ('flutterwave', 'collect', 'GHS', 'Hosted checkout with mobilemoneyghana (059, 073)'),
  ('flutterwave', 'collect', 'KES', 'Hosted checkout with mpesa (059, 073)'),
  ('flutterwave', 'collect', 'USD', 'Hosted checkout, card (060)'),
  ('flutterwave', 'payout',  'NGN', 'POST /v3/transfers to a Nigerian bank (059)'),
  ('flutterwave', 'payout',  'GHS', 'POST /v3/transfers to a Ghanaian wallet or bank (059, 071)'),
  ('flutterwave', 'payout',  'KES', 'POST /v3/transfers to M-PESA with meta (059)'),
  ('bitnob',      'account', 'NGN', 'Virtual accounts for a verified customer, /api/virtual-accounts (042)'),
  ('bitnob',      'payout',  'NGN', 'Quote, initialize, finalize to a Nigerian bank (043)'),
  ('bitnob',      'payout',  'GHS', 'Payout to a Ghanaian wallet matched by network name (076)'),
  ('bitnob',      'payout',  'KES', 'Payout to M-PESA matched by network name (076)')
ON CONFLICT (provider, operation, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  The policy: one row, and it cannot be deleted into nothing.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS provider_routing_policy (
    id                  BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
    mode                TEXT NOT NULL DEFAULT 'per_route'
                        CHECK (mode IN ('per_route', 'by_coverage', 'single')),
    preferred_provider  TEXT NULL
                        CHECK (preferred_provider IN ('paystack', 'flutterwave', 'bitnob')),
    single_provider     TEXT NULL
                        CHECK (single_provider IN ('paystack', 'flutterwave', 'bitnob')),
    account_fallback    BOOLEAN NOT NULL DEFAULT TRUE,
    updated_by          BIGINT NULL REFERENCES users(id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    /* A mode that needs a name and has none would read as a choice and route
     * by nothing — refused here rather than defaulted in code. */
    CONSTRAINT single_names_its_provider
        CHECK (mode <> 'single' OR single_provider IS NOT NULL),
    CONSTRAINT coverage_names_a_preference
        CHECK (mode <> 'by_coverage' OR preferred_provider IS NOT NULL)
);

COMMENT ON TABLE provider_routing_policy IS
  'How provider_routes is read. One row. per_route is the table as since 059; '
  'by_coverage and single choose from provider_coverage and fall back to the '
  'table for anything not covered.';

INSERT INTO provider_routing_policy (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING;

CREATE OR REPLACE FUNCTION assert_routing_policy_kept()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'provider_routing_policy is one row and is changed, never removed';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_routing_policy_kept ON provider_routing_policy;
CREATE TRIGGER provider_routing_policy_kept
    BEFORE DELETE ON provider_routing_policy
    FOR EACH ROW EXECUTE FUNCTION assert_routing_policy_kept();

CREATE TABLE IF NOT EXISTS provider_routing_policy_history (
    id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    mode                TEXT NOT NULL,
    preferred_provider  TEXT NULL,
    single_provider     TEXT NULL,
    account_fallback    BOOLEAN NOT NULL,
    changed_by          BIGINT NULL REFERENCES users(id),
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION assert_routing_policy_history_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'provider_routing_policy_history is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_routing_policy_history_immutable ON provider_routing_policy_history;
CREATE TRIGGER provider_routing_policy_history_immutable
    BEFORE UPDATE OR DELETE ON provider_routing_policy_history
    FOR EACH ROW EXECUTE FUNCTION assert_routing_policy_history_append_only();

CREATE OR REPLACE FUNCTION record_routing_policy_change()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.mode IS NOT DISTINCT FROM NEW.mode
       AND OLD.preferred_provider IS NOT DISTINCT FROM NEW.preferred_provider
       AND OLD.single_provider IS NOT DISTINCT FROM NEW.single_provider
       AND OLD.account_fallback IS NOT DISTINCT FROM NEW.account_fallback THEN
        RETURN NEW;
    END IF;
    INSERT INTO provider_routing_policy_history
        (mode, preferred_provider, single_provider, account_fallback, changed_by)
    VALUES (NEW.mode, NEW.preferred_provider, NEW.single_provider,
            NEW.account_fallback, NEW.updated_by);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS provider_routing_policy_recorded ON provider_routing_policy;
CREATE TRIGGER provider_routing_policy_recorded
    AFTER UPDATE ON provider_routing_policy
    FOR EACH ROW EXECUTE FUNCTION record_routing_policy_change();

INSERT INTO retention_decisions (table_name, decision, rationale)
VALUES
  ('provider_coverage', 'keep',
   'Reference data describing what each integration can do. Not personal data.'),
  ('provider_routing_policy', 'keep',
   'Operational configuration, not personal data. How payments were routed is '
   'part of reconstructing any one of them.'),
  ('provider_routing_policy_history', 'keep',
   'Who changed how every corridor is routed, and when. The question asked '
   'after an incident, so it outlives the incident.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
