-- ============================================================================
--  076 — who opens a naira account number, as its own decision
--
--  NAIRA ACCOUNT NUMBERS MOVE TO FLUTTERWAVE, AND ONLY THEY DO.
--
--  Opening a dedicated account read the `collect` route, which is also what
--  sends a naira payment link to a checkout. So the only way to move account
--  numbers was to move every naira checkout with them — two products with two
--  approvals at the provider, switched by one row. The product owner's
--  decision is about account numbers: Flutterwave by default, Bitnob as the
--  alternative, chosen on the operations screen rather than in a release.
--
--  SO `account` IS AN OPERATION OF ITS OWN. Where a currency has an `account`
--  row it decides; where it has none, `collect` answers exactly as before —
--  which is why cedis and shillings need no row here and why this file
--  changes nothing about a Ghanaian or Kenyan account.
--
--  SWITCHING MOVES NOBODY. `virtual_accounts.provider` records the issuer and
--  every read is dispatched on it, so each number already saved in a banking
--  app keeps receiving at Paystack. What this row changes is who opens the
--  NEXT one.
--
--  AND ON FLUTTERWAVE A NAIRA ACCOUNT NUMBER IS A VERIFIED CUSTOMER'S PRODUCT.
--  Their live environment will not open a permanent account without a BVN, so
--  an unverified customer is refused with `kyc_required` — before anything is
--  sent — rather than given the tier 1 account Paystack opens from a name. An
--  operator who wants that back points this row at `paystack`.
--
--  `DO NOTHING`, as every route seed here: a row that already exists was put
--  there by a person, and a migration must not undo an operator's decision.
-- ============================================================================

ALTER TABLE provider_routes DROP CONSTRAINT IF EXISTS provider_routes_operation_check;
ALTER TABLE provider_routes
    ADD CONSTRAINT provider_routes_operation_check
    CHECK (operation IN ('collect', 'payout', 'account'));

INSERT INTO provider_routes (operation, currency, provider)
VALUES ('account', 'NGN', 'flutterwave')
ON CONFLICT (operation, currency) DO NOTHING;

-- ---------------------------------------------------------------------------
--  A FLUTTERWAVE ACCOUNT IS FOUND BY THE REFERENCE IT WAS OPENED UNDER.
--
--  Every payment into a permanent account is echoed back under the `tx_ref`
--  the account was created with, and that is what the deposit path and the
--  sweep now key on. Accounts opened before this recorded the customer's EMAIL
--  in `provider_customer_ref` instead — shared with every checkout the same
--  person ever paid, and so no use for telling one account's money from
--  another's.
--
--  REPAIRED, NOT GUESSED. The reference sent was always
--  `xetral-va-<user id>-<currency>`, built by `FundingService` from the row's
--  own columns, so it can be rebuilt exactly. Only rows still holding an
--  address are touched; `provider_customer_ref` is not one of the columns
--  006 makes immutable.
-- ---------------------------------------------------------------------------
UPDATE virtual_accounts
   SET provider_customer_ref = 'xetral-va-' || user_id || '-' || currency
 WHERE provider = 'flutterwave'
   AND provider_customer_ref LIKE '%@%';

CREATE INDEX IF NOT EXISTS virtual_accounts_provider_ref
    ON virtual_accounts (provider, provider_customer_ref)
    WHERE provider_customer_ref IS NOT NULL;
