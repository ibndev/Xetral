-- ============================================================================
--  095 — Kora replaces the previous Ghana and Kenya rail, everywhere
--
--  THE PRODUCT OWNER'S DECISION (October 2026): the rail that collected cedis
--  and paid out to Ghanaian wallets is no longer used, and Kora takes its
--  place. Paystack and Bitnob are untouched. What Kora can do is taken from
--  its own guides at developers.korapay.com, read 3 October 2026, and each
--  coverage row below names the guide it rests on — 079's rule that coverage
--  is widened by migration with its evidence, never from a form.
--
--  WHAT MOVES TO KORA, cell by cell, and only where Kora documents it:
--    collect  NGN  card, bank transfer, pay with bank   (Pay-ins Overview)
--    collect  GHS  mobile money                          (Pay-ins Overview)
--    account  NGN  fixed virtual account, with a BVN    (NGN VBA guide)
--    payout   NGN  bank account                          (Payout API guide)
--    payout   GHS  mobile money wallet                   (Payout API guide)
--    payout   KES  bank account and mobile money         (Payout API guide)
--
--  WHAT DOES NOT, AND IS LEFT UNROUTED RATHER THAN GUESSED:
--    collect  USD  Kora documents card payments in NGN only. A dollar
--                  checkout is refused with a code the screen turns into
--                  words, and `provider_route_coverage` shows it UNROUTED.
--    collect  KES  Kora documents mobile money in Kenya, and 083 left Kenyan
--                  collection routed nowhere until a provider was confirmed.
--                  Confirming one is the owner's call, so no coverage row is
--                  added here; the day it is, one INSERT adds it.
--
--  A ROUTE THAT NAMED THE OLD RAIL is moved to Kora where Kora covers the
--  cell, and deleted where it does not. The route-history trigger records
--  both, against no person, which is what a migration is.
--
--  THE CREDENTIALS GO. The old rail's stored keys are deleted with their
--  slots — nothing reads them, a filled box on an operations screen reads as
--  "this is running", and a live secret for a provider nobody uses is a
--  liability with no use. `provider_credential_rotations` keeps who set them
--  and when; it never held a value.
--
--  ACCOUNT NUMBERS THE OLD RAIL ISSUED ARE CLOSED. A customer shown a number
--  nothing here will ever be told about is a customer whose transfer lands
--  nowhere we can see. Closed, Add Money opens a fresh one on the routed rail
--  on their next visit. The rows stay: `virtual_accounts` is history.
--
--  THE OLD RAIL'S DIAGNOSTICS ARE CLEARED — account refusals, name-enquiry
--  refusals and health buckets — because they are about a provider that no
--  longer exists, and a diagnostics screen naming it reads as something still
--  failing. Money records (`bank_payouts`, `deposits`, `link_payments`) keep
--  the name they were written with: they are what happened.
--
--  AND THE PRIVACY NOTICE IS REPUBLISHED, naming Kora — which receives a BVN
--  when it opens a naira account number — before the first request leaves.
--  Moved FORWARD only: retire what is older, publish unless something newer
--  is already live (075's lesson).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
--  Credentials: Kora's one key in, the old rail's out.
-- ---------------------------------------------------------------------------
INSERT INTO provider_credential_slots (provider, name, label, description, env_var, in_use)
VALUES
  ('kora', 'secret_key', 'Kora secret key',
   'Authorises every Kora call — checkouts, virtual accounts, payouts and the '
   'balance read — AND verifies every Kora webhook, which Kora signs with this '
   'same key. Test and live keys differ and the key selects the environment: '
   'there is one host for both. Found under Settings, API Configuration on the '
   'Kora dashboard.',
   'KORA_SECRET_KEY', TRUE)
ON CONFLICT (provider, name) DO NOTHING;

DELETE FROM provider_credentials WHERE provider = 'flutterwave';
DELETE FROM provider_credential_slots WHERE provider = 'flutterwave';

-- ---------------------------------------------------------------------------
--  Coverage: the old rail's rows out, Kora's in, and the CHECK to match.
-- ---------------------------------------------------------------------------
DELETE FROM provider_coverage WHERE provider = 'flutterwave';

ALTER TABLE provider_coverage DROP CONSTRAINT IF EXISTS provider_coverage_provider_check;
ALTER TABLE provider_coverage
  ADD CONSTRAINT provider_coverage_provider_check
  CHECK (provider IN ('paystack', 'kora', 'bitnob'));

INSERT INTO provider_coverage (provider, operation, currency, basis) VALUES
  ('kora', 'collect', 'NGN', 'Checkout, POST /api/v1/charges/initialize; card and bank transfer in NGN (Pay-ins Overview)'),
  ('kora', 'collect', 'GHS', 'Checkout with the mobile_money channel; mobile money in GHS (Pay-ins Overview)'),
  ('kora', 'account', 'NGN', 'Fixed virtual account with a BVN, POST /api/v1/virtual-bank-account (NGN VBA guide)'),
  ('kora', 'payout',  'NGN', 'POST /api/v1/transactions/disburse to a bank_account (Payout API guide)'),
  ('kora', 'payout',  'GHS', 'POST /api/v1/transactions/disburse to mobile_money (Payout API guide)'),
  ('kora', 'payout',  'KES', 'POST /api/v1/transactions/disburse to a bank or mobile_money (Payout API guide)')
ON CONFLICT (provider, operation, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  The routing policy: a preference or a single provider that named the old
--  rail now names Kora, and the CHECKs no longer accept the old name.
-- ---------------------------------------------------------------------------
ALTER TABLE provider_routing_policy
  DROP CONSTRAINT IF EXISTS provider_routing_policy_preferred_provider_check;
ALTER TABLE provider_routing_policy
  DROP CONSTRAINT IF EXISTS provider_routing_policy_single_provider_check;

UPDATE provider_routing_policy
   SET preferred_provider = CASE WHEN preferred_provider = 'flutterwave' THEN 'kora'
                                 ELSE preferred_provider END,
       single_provider    = CASE WHEN single_provider = 'flutterwave' THEN 'kora'
                                 ELSE single_provider END,
       updated_by = NULL,
       updated_at = now()
 WHERE preferred_provider = 'flutterwave' OR single_provider = 'flutterwave';

ALTER TABLE provider_routing_policy
  ADD CONSTRAINT provider_routing_policy_preferred_provider_check
  CHECK (preferred_provider IN ('paystack', 'kora', 'bitnob'));
ALTER TABLE provider_routing_policy
  ADD CONSTRAINT provider_routing_policy_single_provider_check
  CHECK (single_provider IN ('paystack', 'kora', 'bitnob'));

-- ---------------------------------------------------------------------------
--  Routes: moved where Kora covers the cell, removed where it does not.
-- ---------------------------------------------------------------------------
UPDATE provider_routes r
   SET provider = 'kora', updated_by = NULL, updated_at = now()
 WHERE r.provider = 'flutterwave'
   AND EXISTS (SELECT 1 FROM provider_coverage c
                WHERE c.provider = 'kora'
                  AND c.operation = r.operation
                  AND c.currency = r.currency);

DELETE FROM provider_routes WHERE provider = 'flutterwave';

-- ---------------------------------------------------------------------------
--  Account numbers the old rail issued: closed, not deleted.
-- ---------------------------------------------------------------------------
UPDATE virtual_accounts SET status = 'closed'
 WHERE provider = 'flutterwave' AND status <> 'closed';

-- ---------------------------------------------------------------------------
--  Diagnostics about a provider that is gone.
-- ---------------------------------------------------------------------------
DELETE FROM account_refusals WHERE rail = 'flutterwave';
DELETE FROM name_enquiry_refusals WHERE provider = 'flutterwave';
DELETE FROM provider_health WHERE provider = 'flutterwave';

-- ---------------------------------------------------------------------------
--  The privacy notice, naming Kora. Forward only.
-- ---------------------------------------------------------------------------
UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-10-04';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-10-04',
       '338f1d3783b6bf2b4b064f62562213731f596b1e889ee421c7fb68175a8f8739',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Paystack, which is given your BVN and '
       'a bank account on it when it needs them to open your naira account number '
       '— how long it is kept, and how to get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-10-04')
ON CONFLICT (kind, version) DO NOTHING;

COMMIT;
