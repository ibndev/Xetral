-- ============================================================================
--  044 — A second naira funding rail, and a naira account without KYC.
--
--  WHAT WAS WRONG. `006_funding.sql` records that "issuing an account is gated
--  on KYC, not on asking", and that was written as a statement about Nigerian
--  bank accounts in general. It is not one. It is a statement about BITNOB,
--  which will not issue a naira account to a customer it does not already hold
--  a verified BVN for.
--
--  CBN's tiered KYC permits a tier 1 account on a name, a phone number and an
--  address, with a low ceiling — and `029_kyc_tiers.seed.sql` has capped tier
--  0 at ₦50,000 a day since it landed. So the platform was already enforcing
--  the tier 1 ceiling while refusing every unverified customer the account
--  that ceiling is for. The policy and the product had drifted apart, and the
--  customer met that drift on the screen they open in order to put money in.
--
--  PAYSTACK IS THE DEFAULT AND BITNOB IS THE FALLBACK. `POST /customer` there
--  takes a name and an email address and returns a customer code; no BVN, no
--  document, nothing a customer has to go and find. Bitnob stays wired and
--  reachable by flipping one setting, because a rail with no alternative is a
--  rail whose bad afternoon is the platform's bad afternoon.
--
--  RULE 0 SAID NOT TO. `CLAUDE.md` listed Paystack among the providers the
--  reference plugin used and this rebuild would not: that rule was about not
--  inheriting the plugin's architecture, and it is being deliberately
--  reversed here for a funding rail chosen on its own merits. The rule is
--  updated in the same commit rather than left contradicting the schema.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  WHICH RAIL. A setting rather than a deployment variable, so switching
--  during a provider incident is one action on the dashboard rather than a
--  release under pressure — 009's argument, applied to the choice of provider
--  instead of to a fee.
--
--  TEXT rather than a boolean, because "not Paystack" will not always mean
--  Bitnob. A third rail should be a new value here and an adapter, not an
--  inversion of a flag whose name has stopped describing what it does.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category)
VALUES
  ('funding_provider', 'paystack', 'text', NULL, NULL,
   'Naira funding provider',
   'Which rail issues dedicated naira account numbers and receives deposits: '
   'paystack or bitnob. Paystack opens an account from signup details alone, '
   'which is what CBN tier 1 permits and what the tier 0 daily ceiling already '
   'assumes; Bitnob requires a verified BVN first and will refuse an '
   'unverified customer. Accounts ALREADY ISSUED keep working whatever this '
   'says — a customer''s account number is permanent and their bank has it '
   'saved — so switching changes who the NEXT account is opened with.',
   'features')
ON CONFLICT (key) DO NOTHING;

-- The bank Paystack should issue the NUBAN at. A deployment value rather than
-- a constant: test integrations issue Titan accounts and live ones are usually
-- Wema, and a business can be enabled for one and not the other. Empty means
-- "let Paystack choose", which is what their API does with no preference.
INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category)
VALUES
  ('paystack_preferred_bank', '', 'text', NULL, NULL,
   'Paystack preferred bank',
   'The bank slug Paystack issues dedicated account numbers at — usually '
   '`wema-bank` live and `titan-bank` in test. Blank lets Paystack choose. A '
   'value the integration is not enabled for is refused at the moment a '
   'customer asks for an account, so it is worth setting deliberately.',
   'features')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  THE CREDENTIAL. One, not two — and the asymmetry with Bitnob is real.
--
--  Paystack's secret key both authorises requests AND verifies webhooks: the
--  `x-paystack-signature` header is an HMAC-SHA512 over the raw body keyed by
--  that same key. Bitnob has a separate webhook secret. Adding a second slot
--  here to make the two providers look alike would be a box an operator fills
--  with a value nothing reads — the failure 026 exists to prevent.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
VALUES
  ('paystack', 'secret_key', 'Paystack secret key',
   'Authorises every Paystack call AND verifies every Paystack webhook — the '
   'signature is an HMAC-SHA512 over the raw body keyed by this same value, '
   'so there is deliberately no separate webhook secret. Starts sk_test_ or '
   'sk_live_, and WHICH ONE decides whether the money is real.',
   'PAYSTACK_SECRET_KEY', TRUE)
ON CONFLICT (provider, name) DO NOTHING;

-- ---------------------------------------------------------------------------
--  WHERE THE SWEEP LOOKS.
--
--  `deposit-reconciliation` is the only thing that finds a webhook which never
--  arrived — the failure a bank rail cannot otherwise detect, because the
--  customer transferred, sees nothing, and waiting does not help.
--
--  It runs from `provider_account_id`, which is right for Bitnob and cannot
--  work for Paystack: their transaction list is a CUSTOMER-level query and
--  does not accept a dedicated-account id. Without somewhere to put the
--  customer code the sweep would silently stop working for the DEFAULT
--  provider — a worker that runs, reports nothing and finds nothing, which
--  looks exactly like a rail with no lost webhooks.
--
--  Nullable, because Bitnob genuinely has nothing to put here. A NOT NULL
--  column with an invented value would be worse: it would make "this rail
--  does not need one" indistinguishable from "somebody forgot".
-- ---------------------------------------------------------------------------
ALTER TABLE virtual_accounts
    ADD COLUMN IF NOT EXISTS provider_customer_ref TEXT
        CHECK (provider_customer_ref IS NULL OR length(btrim(provider_customer_ref)) > 0);

COMMIT;
