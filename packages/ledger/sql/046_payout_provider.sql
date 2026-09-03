-- 046: which rail sends money OUT to a bank.
--
-- THE BANK LIST HAD EXACTLY ONE IMPLEMENTATION AND IT WAS BITNOB'S, reached
-- through a client the application builds only when `BITNOB_BASE_URL` is set.
-- Paystack is the default FUNDING rail since 044, so the ordinary shipped
-- deployment holds Paystack credentials and no Bitnob ones — and on that
-- deployment every method of the payout port refused. The Send screen asked
-- for the bank list, was refused, and told the customer the list could not be
-- loaded. Nothing was broken except that the only adapter able to answer
-- needed a credential nobody had configured.
--
-- So the rail is a SETTING, the same shape as `funding_provider` and for the
-- reason 009 gives: the reason to switch is almost always that the current
-- provider is having a bad afternoon, and an operational decision taken under
-- pressure should not be a release.
--
-- IT IS A SEPARATE SETTING FROM `funding_provider`, deliberately. Money coming
-- in and money going out are different products with different approvals: a
-- business can be live for dedicated accounts and not yet approved for
-- transfers, and one setting covering both would make enabling either mean
-- claiming both.
--
-- WHAT THIS DOES NOT DO is move a payout already sent. `bank_payouts.provider`
-- records who sent it and `status()` is dispatched on that row, because a
-- provider-side payout id only the issuing rail can resolve becomes
-- unresolvable the moment an operator flips a setting — and an unresolvable
-- payout is one nothing can settle or reverse, which is the exact state
-- `bank_payouts_stuck` exists to count.

BEGIN;

INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category)
VALUES
  ('payout_provider', 'paystack', 'text', NULL, NULL,
   'Bank payout provider',
   'Which rail lists banks, resolves an account name and sends money out: '
   'paystack or bitnob. This is separate from `funding_provider` because a '
   'business can be approved for dedicated accounts and not yet for '
   'transfers. Payouts ALREADY SENT keep being read from the rail that sent '
   'them — the row records the issuer — so switching changes who sends the '
   'NEXT one.',
   'features')
ON CONFLICT (key) DO NOTHING;

/*
 * WHO SENT IT, on the row.
 *
 * `bank_payouts` recorded a `provider_payout_id` and no provider, which was
 * correct while exactly one rail existed and is a lost payout the moment two
 * do: the id is opaque and only its issuer can resolve it. Nullable and
 * defaulted rather than NOT NULL, because rows already exist and a migration
 * that refuses to apply over them would be worse than an unattributed payout
 * — the same choice 035 makes about `created_by` on a published price.
 *
 * The default is 'bitnob' because every row that predates this column was
 * sent by the only adapter there was. Writing 'paystack' would relabel real
 * payouts as having come from a rail that had not been built when they left.
 */
ALTER TABLE bank_payouts
    ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'bitnob'
        CHECK (length(btrim(provider)) > 0);

/*
 * IMMUTABLE, like the destination beside it.
 *
 * 043 already refuses an UPDATE that moves the account number, on the
 * reasoning that the reserve is posted and re-pointing it would send
 * authorised money to somebody never named. The issuer is the same kind of
 * fact: changing it after the fact would make `status()` ask the wrong
 * provider about a payout, and the answer to "did this leave?" would come
 * from a rail that never saw it.
 */
CREATE OR REPLACE FUNCTION bank_payout_provider_is_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.provider IS DISTINCT FROM OLD.provider THEN
        RAISE EXCEPTION
            'a bank payout''s provider cannot change: % -> %',
            OLD.provider, NEW.provider;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS bank_payout_provider_immutable ON bank_payouts;
CREATE TRIGGER bank_payout_provider_immutable
    BEFORE UPDATE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION bank_payout_provider_is_immutable();

COMMIT;

BEGIN;

/*
 * HOW MONEY LEAVES, PER COUNTRY — and this belongs to the COUNTRY.
 *
 * The Send screen offered "Bank account" everywhere, with a Nigerian bank
 * list behind it. In Ghana and Kenya that is the wrong product: money moves
 * to a mobile money wallet on a phone number, not to a ten-digit NUBAN, and a
 * customer in Accra was being shown a list of Nigerian banks and an account
 * number field their money cannot reach.
 *
 * 040's whole argument is that a country is DATA and a currency is not, so
 * this is a column rather than a `switch` in two apps. A hardcoded list would
 * be a fact about where the platform operates living in a stylesheet's
 * neighbour, and adding a country would mean a release in three codebases.
 *
 * A CHECK rather than an enum: the set is small, it is read by the API and
 * both apps, and a new value needs an adapter anyway — so a migration that
 * widens the CHECK is exactly the review that ought to happen.
 */
ALTER TABLE countries
    ADD COLUMN IF NOT EXISTS payout_method TEXT NOT NULL DEFAULT 'bank'
        CHECK (payout_method IN ('bank', 'mobile_money'));

/*
 * NIGERIA IS BANK; GHANA AND KENYA ARE MOBILE MONEY.
 *
 * Written as an UPDATE against named codes rather than as a rule, because
 * "which countries are mobile-money-first" is a fact about those countries
 * and not something derivable from anything else in this schema. The default
 * is 'bank' so a country added later gets the conservative answer — a bank
 * transfer that refuses is recoverable, and a mobile money send to a number
 * that is not a wallet is not.
 */
UPDATE countries SET payout_method = 'mobile_money' WHERE code IN ('GH', 'KE');

COMMIT;
