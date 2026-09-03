-- ============================================================================
--  043 — Sending money to a Nigerian bank account.
--
--  WHAT WAS MISSING. Sending money has only ever meant sending it to another
--  Xetral customer. That is the smaller half of what a Nigerian fintech is
--  for: money arrives through the dedicated virtual account 006 issues, and
--  the only way out was to spend it on a card, a bill or crypto. A customer
--  could not pay their landlord.
--
--  THE MONEY FLOW IS THE ONE PHASE 9 ALREADY BUILT, and that is deliberate
--  rather than a coincidence. An on-chain withdrawal and a bank payout ask
--  the same question — money is leaving, to somewhere we cannot reach into,
--  through a provider that answers slowly:
--
--    Reserve   customer_wallet  -> customer_pending    the guard decides, BEFORE
--                                                      the provider is asked
--    Sent      customer_pending -> provider_float      it left
--    Failed    a reversal naming the reserve           it never left
--    (neither)                                         we do not know; held
--
--  So no new entry kind and no new account role: `wallet_withdrawal` has been
--  in `001_ledger.sql` since Phase 1 and `customer_pending` since then too.
--  The ledger was designed for this and the design held, exactly as Phase 9
--  and Phase 10 record.
--
--  WHAT IS GENUINELY NEW is that the destination is a PERSON AT A BANK rather
--  than a string, and the two things that follow from it are the reason this
--  file exists at all:
--
--   1. THE BENEFICIARY NAME IS THE BANK'S, NEVER THE CUSTOMER'S. Bitnob's
--      `/api/payouts/account-lookup` answers with the name the bank holds
--      against that account number. That name is what is stored and what the
--      customer is shown before they confirm. Storing what they typed would
--      let somebody believe they were paying their landlord while the digits
--      went to a stranger — and the whole value of a name lookup is that it
--      is not the sender's own claim.
--
--   2. AN ACCOUNT NUMBER AND A BANK CODE ARE IMMUTABLE ONCE THE ROW EXISTS.
--      Same rule 006 applies to a virtual account number, for the mirror
--      reason: there, changing it silently redirects money coming IN; here,
--      changing it after the reserve redirects money going OUT, and the
--      reserve has already been posted against the customer's balance.
--
--  BITNOB'S PAYOUT IS THREE CALLS — quote, initialize, finalize — and the
--  gaps between them are states this table can be in. A payout initialized
--  and not finalized has moved no money at their end; one finalized is gone.
--  `provider_quote_id` and `provider_payout_id` are therefore separate
--  columns rather than one "provider reference": collapsing them loses the
--  ability to say WHICH of the three calls we got through, which is the only
--  question that matters when a process dies in the middle.
-- ============================================================================

BEGIN;

-- reserved   the money is held; the provider has not been asked, or has not answered
-- sent       finalized at the provider; on its way to the bank
-- completed  the bank confirmed it
-- failed     it did not happen, and the reserve has been reversed
CREATE TYPE bank_payout_status AS ENUM ('reserved', 'sent', 'completed', 'failed');

CREATE TABLE bank_payouts (
    id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid                UUID        NOT NULL DEFAULT gen_random_uuid(),
    user_id             BIGINT      NOT NULL REFERENCES users(id),

    -- Ours, DERIVED from the customer's key rather than generated. The reserve
    -- entry is posted before this row exists, so a crash in that gap leaves a
    -- retry with no row to find; a derived reference makes the retry reuse the
    -- same ledger idempotency key and the ledger answers `replayed: true`. A
    -- random one pays twice, only under a crash. 004's finding 1, applied to
    -- the one flow where a double payment cannot be clawed back.
    reference           TEXT        NOT NULL,
    idempotency_key     TEXT        NOT NULL,

    -- WHERE IT IS GOING.
    country             CHAR(2)     NOT NULL REFERENCES countries(code),
    bank_code           TEXT        NOT NULL CHECK (length(btrim(bank_code)) BETWEEN 1 AND 32),
    bank_name           TEXT        NOT NULL CHECK (length(btrim(bank_name)) BETWEEN 1 AND 120),
    account_number      TEXT        NOT NULL CHECK (account_number ~ '^[0-9]{6,20}$'),
    -- THE BANK'S ANSWER, not the sender's claim. See the header.
    account_name        TEXT        NOT NULL CHECK (length(btrim(account_name)) BETWEEN 1 AND 140),
    narration           TEXT        NULL CHECK (narration IS NULL OR length(narration) <= 100),

    currency            TEXT        NOT NULL,
    -- What the beneficiary receives.
    amount_minor        BIGINT      NOT NULL CHECK (amount_minor > 0),
    -- What we charge, ON TOP, so a statement can say what was sent and what it
    -- cost. Zero is legitimate and is the shipped default — a fee nobody
    -- configured is money taken from a customer because of a default.
    fee_minor           BIGINT      NOT NULL DEFAULT 0 CHECK (fee_minor >= 0),
    -- The tax inside the fee. A liability, never revenue — 032's rule.
    tax_minor           BIGINT      NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),

    status              bank_payout_status NOT NULL DEFAULT 'reserved',

    -- SEPARATE, and the header says why: together they cannot answer "how far
    -- did we get" when a process died mid-flow.
    provider_quote_id   TEXT        NULL,
    provider_payout_id  TEXT        NULL,
    failure_reason      TEXT        NULL,

    reserve_entry_id    BIGINT      NOT NULL REFERENCES journal_entries(id),
    settle_entry_id     BIGINT      NULL REFERENCES journal_entries(id),

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT bank_payouts_uuid_key      UNIQUE (uuid),
    CONSTRAINT bank_payouts_reference_key UNIQUE (reference),
    -- A customer key is unique PER CUSTOMER. Two customers will send the same
    -- one; a client counting from one is enough. 004's finding 2.
    CONSTRAINT bank_payouts_user_key      UNIQUE (user_id, idempotency_key),

    -- The tax is part of the fee, not additional to it. Booking more tax than
    -- fee would mean remitting money nobody was charged.
    CONSTRAINT bank_payouts_tax_within_fee CHECK (tax_minor <= fee_minor),

    CONSTRAINT bank_payouts_sent_has_an_id CHECK (
        status NOT IN ('sent', 'completed') OR provider_payout_id IS NOT NULL
    ),
    CONSTRAINT bank_payouts_failed_says_why CHECK (
        status <> 'failed' OR failure_reason IS NOT NULL
    ),
    CONSTRAINT bank_payouts_sent_has_an_entry CHECK (
        status NOT IN ('sent', 'completed') OR settle_entry_id IS NOT NULL
    )
);

CREATE INDEX bank_payouts_user ON bank_payouts (user_id, created_at DESC);
CREATE INDEX bank_payouts_open ON bank_payouts (created_at)
    WHERE status IN ('reserved', 'sent');

-- reserved -> sent | failed
-- sent     -> completed | failed
--
-- Note what is absent. There is no path back to `reserved` and none out of
-- `completed`. Once a bank has been told to pay, the money is beyond us
-- whatever this database says, and a state machine that pretended otherwise
-- would be lying to whoever reads it next — 007's rule about bytes on a
-- chain, which is the same rule.
--
-- `sent -> failed` IS permitted, unlike a settled card spend, because a bank
-- transfer really can be returned days later: a closed account, a name
-- mismatch the bank catches. That is a genuine outcome, not a correction.
CREATE OR REPLACE FUNCTION assert_bank_payout_transition() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT (
            (OLD.status = 'reserved' AND NEW.status IN ('sent', 'failed'))
            OR (OLD.status = 'sent'  AND NEW.status IN ('completed', 'failed'))
        ) THEN
            RAISE EXCEPTION 'bank payout % cannot go from % to %',
                OLD.id, OLD.status, NEW.status
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;

    -- WHO, WHERE AND HOW MUCH ARE FROZEN. The reserve is already posted
    -- against the customer's balance by the time this row exists, so an UPDATE
    -- that moved the destination would send money the customer authorised to
    -- somebody they never named — and the ledger would agree, because the
    -- amount matched.
    IF NEW.user_id        IS DISTINCT FROM OLD.user_id
       OR NEW.reference      IS DISTINCT FROM OLD.reference
       OR NEW.country        IS DISTINCT FROM OLD.country
       OR NEW.bank_code      IS DISTINCT FROM OLD.bank_code
       OR NEW.account_number IS DISTINCT FROM OLD.account_number
       OR NEW.account_name   IS DISTINCT FROM OLD.account_name
       OR NEW.currency       IS DISTINCT FROM OLD.currency
       OR NEW.amount_minor   IS DISTINCT FROM OLD.amount_minor
       OR NEW.reserve_entry_id IS DISTINCT FROM OLD.reserve_entry_id
    THEN
        RAISE EXCEPTION 'a bank payout''s owner, destination, amount and reserve are immutable'
            USING ERRCODE = 'check_violation';
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_payouts_transition
    BEFORE UPDATE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION assert_bank_payout_transition();

-- A payout is never deleted. It is a record of money leaving a customer's
-- account, and 011's argument about the ledger applies with equal force to the
-- row that explains an entry.
CREATE OR REPLACE FUNCTION refuse_bank_payout_delete() RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'bank payouts are append-only: a payout cannot be deleted'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bank_payouts_no_delete
    BEFORE DELETE ON bank_payouts
    FOR EACH ROW EXECUTE FUNCTION refuse_bank_payout_delete();

-- ---------------------------------------------------------------------------
--  WHAT NOBODY ELSE CAN SEE.
--
--  A payout stuck in `reserved` is money held against an outcome nobody will
--  look up: the customer's balance is down, the beneficiary has nothing, the
--  ledger balances perfectly and `ledger_drift` reports nothing. It is the
--  same invisibility 031 records about a card hold that never settled, and it
--  COUNTS rather than resolves, for the same reason — settling invents a
--  payment the bank never confirmed, and reversing hands back money that may
--  already be in somebody else's account.
--
--  `sent` is here too, with a longer window. A Nigerian instant transfer is
--  minutes; one still `sent` a day later has either been returned or is stuck
--  at the rail, and both need a person.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW bank_payouts_stuck AS
SELECT
    p.id,
    p.uuid,
    p.user_id,
    p.status,
    p.currency,
    p.amount_minor,
    p.bank_name,
    p.created_at,
    EXTRACT(EPOCH FROM (now() - p.created_at)) / 3600 AS hours_open
FROM bank_payouts p
WHERE (p.status = 'reserved' AND p.created_at < now() - INTERVAL '1 hour')
   OR (p.status = 'sent'     AND p.created_at < now() - INTERVAL '24 hours');

-- ---------------------------------------------------------------------------
--  COVERAGE. Both directions, because 019 fails on a table nobody has decided
--  about and 036 on a view nobody has classified — and the table nobody
--  thought of is the one that accumulates, while the queue nobody thought of
--  is the one that silently fills.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('bank_payouts', 'keep',
   'A RECORD OF MONEY LEAVING A CUSTOMER''S ACCOUNT, and AML requires records '
   'of a relationship for five years after it ends. It also carries a '
   'beneficiary''s name and account number, which is personal data about '
   'somebody who is not our customer — so it is kept because the law requires '
   'it and not because it is convenient, and the erasure path names it as '
   'retained with that reason rather than deleting it.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, queue_name, rationale) VALUES
  ('bank_payouts_stuck', 'queue', 'bank_payouts_stuck',
   'Money held against a payout nobody will look up. Invisible to every other '
   'check — the ledger balances, drift reports nothing, and the customer''s '
   'balance is simply down. It counts rather than resolves, because settling '
   'invents a payment the bank never confirmed and reversing hands back money '
   'that may already be in somebody else''s account.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
--  A KILL SWITCH, because this is a NEW EXTERNAL RAIL.
--
--  The four existing switches guard the four flows where money leaves the
--  platform — crypto, FX, cards, bills. A wallet transfer has none and is
--  right not to: it moves money between two customers and nothing leaves. A
--  bank payout leaves, irreversibly, through a provider that can be having a
--  bad afternoon, so it belongs with the four and not with the transfer.
--
--  Ships ON. Unlike gift cards, nothing here pays out against an instrument
--  nobody can verify: the money is the customer's own and the flow is refused
--  by the overdraft guard when it is not. Shipping it off would mean the
--  feature does not work on a fresh deployment for a reason nothing states.
-- ---------------------------------------------------------------------------
INSERT INTO platform_settings
    (key, value, value_type, min_value, max_value, label, description, category)
VALUES
  ('payouts_enabled', 'true', 'boolean', NULL, NULL,
   'Bank payouts',
   'Off refuses sending money to a bank account. Payouts already sent keep '
   'settling and reconciling — money that has left is still recorded — and a '
   'customer can still be paid by another customer, because that money never '
   'leaves the platform.',
   'features')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------
--  THE OVERVIEW GAINS AN ARM, and 036's coverage check is what demanded it.
--
--  Written out in full rather than assembled by looping over
--  `attention_sources`: an overview whose behaviour changes with an INSERT is
--  the shape `apply_retention()` and `erase_customer_personal_data()` both
--  refuse. So the whole view is restated here with one more arm — the price
--  of that rule, paid deliberately.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW admin_work_queue AS
  SELECT 'kyc'::TEXT AS queue, COUNT(*)::BIGINT AS waiting, MIN(created_at) AS oldest
    FROM kyc_submissions WHERE status = 'pending'
UNION ALL
  SELECT 'suspense', COUNT(*), MIN(created_at) FROM unattributed_deposits
UNION ALL
  SELECT 'giftcard_review', COUNT(*), MIN(created_at) FROM giftcard_review_queue
UNION ALL
  SELECT 'purchases_held', COUNT(*), MIN(created_at) FROM pending_purchases
UNION ALL
  SELECT 'crypto_withdrawals_open', COUNT(*), MIN(created_at) FROM crypto_withdrawals_pending
UNION ALL
  SELECT 'disputes', COUNT(*), MIN(raised_at) FROM disputes_open
UNION ALL
  SELECT 'risk_signals', COUNT(*), MIN(observed_at) FROM risk_signals_open
UNION ALL
  SELECT 'risk_cases', COUNT(*), MIN(opened_at) FROM risk_cases_open
UNION ALL
  SELECT 'card_holds_stuck', COUNT(*), MIN(occurred_at) FROM card_holds_stuck
UNION ALL
  SELECT 'consent', COUNT(*), MIN(published_at) FROM consent_outstanding
UNION ALL
  SELECT 'data_requests', COUNT(*), MIN(requested_at) FROM data_requests_due
UNION ALL
  SELECT 'ledger_drift', COUNT(*), NULL::TIMESTAMPTZ FROM ledger_drift
UNION ALL
  SELECT 'provider_drift', COUNT(*), NULL::TIMESTAMPTZ FROM provider_balance_drift
UNION ALL
  SELECT 'tax_drift', COUNT(*), NULL::TIMESTAMPTZ FROM tax_remittance_drift
UNION ALL
  SELECT 'notifications_abandoned', COUNT(*), MIN(created_at) FROM notifications_abandoned
UNION ALL
  SELECT 'errors', COUNT(*), MIN(first_seen_at) FROM errors_open
UNION ALL
  SELECT 'giftcard_holds_due', COUNT(*), MIN(hold_until) FROM giftcard_holds_due
UNION ALL
  SELECT 'staff_without_totp', COUNT(*), NULL::TIMESTAMPTZ FROM staff_without_second_factor
UNION ALL
  SELECT 'bvn_collisions', COUNT(*), NULL::TIMESTAMPTZ FROM kyc_bvn_collisions
UNION ALL
  SELECT 'token_reuse', COUNT(*), NULL::TIMESTAMPTZ FROM token_reuse_incidents
UNION ALL
  SELECT 'credential_stuffing', COUNT(*), NULL::TIMESTAMPTZ FROM credential_stuffing_sources
UNION ALL
  SELECT 'prices_unattributed', COUNT(*), MIN(effective_from) FROM prices_without_an_author
UNION ALL
  SELECT 'provider_degraded', COUNT(*), NULL::TIMESTAMPTZ FROM provider_degraded
UNION ALL
  -- Added by 040, and the coverage check in 036 is what caught its absence:
  -- `countries_awaiting_a_decision` was classified as a queue and had no arm
  -- here, so the overview would have been complete-looking and short by one.
  -- That is exactly the failure 036 exists to prevent, and it fired.
  SELECT 'countries_awaiting_a_decision', COUNT(*), MIN(created_at)
    FROM countries_awaiting_a_decision
UNION ALL
  -- Added by 043, and 036's coverage check is what demanded it: the view was
  -- classified as a queue and had no arm here, so the overview would have
  -- looked complete and been short by one. It fired, exactly as it did for
  -- 040's own queue.
  SELECT 'bank_payouts_stuck', COUNT(*), MIN(created_at)
    FROM bank_payouts_stuck;

COMMIT;
