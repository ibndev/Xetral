-- ============================================================================
--  032 — Tax we collect on somebody else's behalf.
--
--  WHAT WAS MISSING. Every naira of every fee went to `revenue_fees`. That is
--  wrong twice over: part of a fee charged by a Nigerian company for a service
--  is VAT, which is not our money at all, and there was no account anywhere
--  that could hold money we have collected and owe onward. A finance team
--  filing a return had nothing to file FROM.
--
--  TAX IS A LIABILITY, NOT REVENUE, and that is the whole shape of this file.
--  Money we collect for the FIRS is money we owe the FIRS; booking it as
--  revenue overstates what the business earned and understates what it owes,
--  and both errors point the same way — the flattering one.
--
--  TWO DIFFERENT THINGS, WITH TWO DIFFERENT DEFAULTS, and the difference in
--  defaults is the important part:
--
--    VAT ON FEES is a booking correction. The customer pays what they always
--    paid; we simply stop calling all of it revenue. It ships ON, because
--    leaving it off means continuing to record a number we know is wrong.
--
--    A TRANSFER LEVY would CHANGE WHAT A CUSTOMER IS CHARGED. Whether the
--    Electronic Money Transfer Levy applies to a wallet like this one, at what
--    threshold, and borne by whom, is a question for a Nigerian tax adviser and
--    not one this file may answer. So the machinery is here, complete and
--    tested, and it ships OFF. Turning it on is a deliberate act by somebody
--    who has taken advice.
--
--  NEITHER FIGURE HERE IS TAX ADVICE. The rate and the threshold are rows an
--  operator sets, for the same reason `risk_thresholds` are: a platform
--  running on a number somebody copied from a migration is running on a number
--  nobody reviewed.
-- ============================================================================

-- Outside a transaction, and unusable in the same one.
ALTER TYPE account_kind ADD VALUE IF NOT EXISTS 'liability_tax_payable';

BEGIN;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('vat_basis_points', '750', 'integer', 0, 2500,
   'VAT on fees (basis points)',
   'Nigeria''s standard rate is 750 basis points — 7.5%. CONFIRM IT AGAINST '
   'CURRENT FIRS GUIDANCE. Applied to the FEE and never to the amount being '
   'transferred: what is taxed is the service, not the money moving.',
   'tax', TRUE),

  ('vat_inclusive', 'true', 'boolean', NULL, NULL,
   'Fees already include VAT',
   'ON means a fee is what the customer pays and part of it is VAT, so turning '
   'VAT on changes the BOOKS and not the price. OFF would add VAT on top, '
   'raising every fee — which is a pricing decision, not a tax one, and is not '
   'something a tax setting should make quietly.',
   'tax', TRUE),

  ('transfer_levy_enabled', 'false', 'boolean', NULL, NULL,
   'Charge the electronic money transfer levy',
   'OFF by default, and deliberately. Whether the EMTL applies to a wallet '
   'like this one, at what threshold, and borne by whom, is a question for a '
   'Nigerian tax adviser. Turning this on CHANGES WHAT CUSTOMERS ARE CHARGED, '
   'so it is an act somebody takes having read advice — not a default.',
   'tax', TRUE),

  ('transfer_levy_kobo', '5000', 'integer', 0, 100000,
   'Levy per qualifying transfer (kobo)',
   'A FLAT amount, not a percentage — ₦50.00 as ₦5,000 kobo is the figure the '
   'Finance Act 2020 introduced. Confirm it before enabling the levy.',
   'tax', TRUE),

  ('transfer_levy_threshold_kobo', '1000000', 'integer', 0, 100000000,
   'Transfers at or above this attract the levy (kobo)',
   '₦10,000.00 as kobo. A transfer BELOW this attracts nothing, so the levy '
   'never applies to the small transfers that are most of the traffic.',
   'tax', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * What we collected, for whom, and against which entry.
 *
 * A LEDGER POSTING ALREADY RECORDS THE MONEY — this records what KIND of tax
 * it was, which the account alone cannot say: VAT and a transfer levy both
 * land in `liability_tax_payable` and are filed on different returns, at
 * different times, to different schedules.
 *
 * It is derived from postings rather than the source of them: the entry is
 * written first and this names it. Reporting reads this; the money is still
 * the ledger's.
 */
CREATE TYPE tax_kind AS ENUM ('vat', 'transfer_levy');

CREATE TABLE tax_collections (
    id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind          tax_kind    NOT NULL,

    /** The entry whose posting moved this money. */
    entry_id      BIGINT      NOT NULL REFERENCES journal_entries(id),
    /** Whose transaction it was. */
    user_id       BIGINT      NOT NULL REFERENCES users(id),

    amount_minor  BIGINT      NOT NULL CHECK (amount_minor > 0),
    currency      TEXT        NOT NULL,

    /** What it was charged ON: the fee for VAT, the transfer for a levy. Kept
     *  so a return can be checked against the transactions behind it without
     *  recomputing them from the postings. */
    base_minor    BIGINT      NOT NULL CHECK (base_minor >= 0),
    /** The rate or flat amount in force at the time, so a return filed last
     *  year can still be explained after the rate changes. */
    rate_applied  TEXT        NOT NULL,

    occurred_at   TIMESTAMPTZ NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

    /** One collection of each kind per entry. A redelivered webhook or a
     *  retried transfer is a replay at the ledger, and must be one here. */
    CONSTRAINT tax_collections_one_per_entry UNIQUE (entry_id, kind)
);

CREATE INDEX tax_collections_period ON tax_collections (kind, occurred_at);
CREATE INDEX tax_collections_user ON tax_collections (user_id, occurred_at);

/**
 * Append-only. A tax record that can be edited after a return is filed is a
 * record that says whatever makes the last return look right.
 */
CREATE OR REPLACE FUNCTION refuse_tax_collection_change() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'tax_collections is append-only; % is refused', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tax_collections_append_only
    BEFORE UPDATE OR DELETE ON tax_collections
    FOR EACH ROW EXECUTE FUNCTION refuse_tax_collection_change();

COMMIT;

BEGIN;

/**
 * What finance files, by month.
 *
 * A Lagos month, for the same reason "today" is a Lagos day everywhere else: a
 * UTC boundary puts an hour of the first of the month into the previous
 * return.
 *
 * Reported PER CURRENCY, because a return is filed in one. Summing kobo and
 * cents into a single figure is the arithmetic the ledger's per-currency
 * balance invariant exists to refuse, and a tax return is the last place to
 * start doing it.
 */
CREATE VIEW tax_collected_monthly AS
SELECT date_trunc('month', occurred_at AT TIME ZONE 'Africa/Lagos')::DATE AS month,
       kind::TEXT AS kind,
       currency,
       count(*)                  AS transactions,
       sum(amount_minor)::BIGINT AS collected_minor,
       sum(base_minor)::BIGINT   AS base_minor
  FROM tax_collections
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 2, 3;

/**
 * What the business actually earned, net of tax, by month.
 *
 * Read from POSTINGS rather than from a fee counter, so it cannot disagree
 * with the ledger — the same rule the velocity and monitoring rules follow. A
 * revenue figure computed from a second record is a revenue figure that drifts.
 */
CREATE VIEW revenue_monthly AS
SELECT date_trunc('month', e.occurred_at AT TIME ZONE 'Africa/Lagos')::DATE AS month,
       a.kind::TEXT AS account,
       p.currency,
       sum(p.amount_minor)::BIGINT AS amount_minor
  FROM postings p
  JOIN accounts a        ON a.id = p.account_id
  JOIN journal_entries e ON e.id = p.journal_entry_id
 WHERE a.kind IN ('revenue_fees', 'revenue_fx_spread', 'liability_tax_payable')
 GROUP BY 1, 2, 3
 ORDER BY 1 DESC, 2, 3;

/**
 * What we hold and have not yet remitted.
 *
 * From the account balance, which is the money itself, rather than from
 * `tax_collections`, which is the description of it. If the two ever disagree
 * the balance is the one that is true — and `tax_remittance_drift` below is
 * what makes the disagreement visible instead of a surprise at filing time.
 */
CREATE VIEW tax_payable AS
SELECT a.currency,
       COALESCE(b.balance_minor, 0)::BIGINT AS balance_minor
  FROM accounts a
  LEFT JOIN account_balances b ON b.account_id = a.id
 WHERE a.kind = 'liability_tax_payable'
 ORDER BY a.currency;

/**
 * Does the tax we recorded match the tax we hold?
 *
 * The same question `provider_balance_drift` asks about a provider, asked
 * about ourselves. `tax_collections` is written alongside the posting but by
 * different code, so a path that posts the money and forgets the record — or
 * the reverse — is exactly the bug that shows up as an unexplained figure on a
 * return. This makes it a row somebody can see rather than an argument in
 * March.
 *
 * Remittances are excluded from the comparison: paying the FIRS reduces the
 * balance and is not a collection, so the balance is expected to fall below
 * what was collected once money has been sent. Only the OTHER direction — more
 * held than ever collected — is a discrepancy.
 */
CREATE VIEW tax_remittance_drift AS
SELECT c.currency,
       c.collected_minor,
       COALESCE(p.balance_minor, 0) AS held_minor,
       COALESCE(p.balance_minor, 0) - c.collected_minor AS difference_minor
  FROM (
    SELECT currency, sum(amount_minor)::BIGINT AS collected_minor
      FROM tax_collections GROUP BY currency
  ) c
  LEFT JOIN tax_payable p ON p.currency = c.currency
 WHERE COALESCE(p.balance_minor, 0) > c.collected_minor;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('tax_collections', 'keep',
   'What was collected on the revenue authority''s behalf and filed on which '
   'return. Tax records outlive almost everything else here, and one that a '
   'scheduled job can delete from is one that says whatever makes the last '
   'return look right.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
