-- ---------------------------------------------------------------------------
--  049 — Getting a customer's money back, on the record
--
--  WHAT THIS IS FOR. Money can end up held rather than delivered: a bank
--  payout the provider never answered for, a purchase whose outcome nobody
--  ever learned. 047's sweeps resolve most of that automatically, and
--  deliberately refuse to resolve the rest — past the stale window both
--  remaining answers can be the wrong one, so a person decides.
--
--  This is what that person presses, and the row it writes.
--
--  WHY A TABLE RATHER THAN JUST THE AUDIT LOG. `admin_audit_log` records that
--  an action happened; it does not record WHICH LEDGER ENTRY gave the money
--  back. Without that link, "we refunded this customer" is a claim in one
--  table and a posting in another with nothing joining them — and the first
--  question anybody asks afterwards is which reversal corresponds to which
--  decision. It is written on the SAME transaction as the reversal, so a
--  recovery cannot exist without its posting and a posting made by this path
--  cannot exist without its record.
--
--  IT DOES NOT MOVE MONEY BY ITSELF, and that is the safety property. Every
--  recovery reverses a SPECIFIC held row, and the amount comes from that row
--  rather than from a form. There is no path here that credits an arbitrary
--  customer an arbitrary amount: that would be a money-printing button on an
--  operations screen, and the audited way to say "we bear this loss" already
--  exists — 018's dispute flow, which posts to its own expense account so
--  somebody has to look at the number.
-- ---------------------------------------------------------------------------

BEGIN;

CREATE TYPE recovery_kind AS ENUM (
    'bank_payout',   -- held against a transfer that never left
    'purchase'       -- held against an order whose outcome nobody learned
);

CREATE TABLE recovery_actions (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid            UUID NOT NULL DEFAULT gen_random_uuid(),

    kind            recovery_kind NOT NULL,
    -- The row that was recovered, as ITS OWN uuid. Not a foreign key: the
    -- kinds live in different tables, and a polymorphic FK would be a
    -- constraint that cannot be written rather than one nobody wrote.
    subject_uuid    UUID NOT NULL,

    user_id         BIGINT NOT NULL REFERENCES users(id),
    amount_minor    BIGINT NOT NULL CHECK (amount_minor > 0),
    currency        TEXT   NOT NULL,

    -- THE REVERSAL ITSELF. This is the column that makes the record a record
    -- rather than an assertion: it names the entry that actually moved the
    -- money back, so the decision and the posting cannot describe different
    -- events.
    reversal_entry_id BIGINT NOT NULL REFERENCES journal_entries(id),

    -- WHO, AND WHY, both required. A queue cleared with one-word reasons is
    -- indistinguishable from one nobody worked, and the reason is the part a
    -- customer is eventually read back to.
    actioned_by     BIGINT NOT NULL REFERENCES users(id),
    reason          TEXT   NOT NULL CHECK (length(btrim(reason)) BETWEEN 8 AND 500),

    -- WHEN, from the DATABASE's clock and not the caller's. A timestamp a
    -- process can supply is a timestamp somebody can choose.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT recovery_actions_uuid_key UNIQUE (uuid),
    -- ONE RECOVERY PER SUBJECT. Pressing the button twice must not post a
    -- second reversal — the ledger's idempotency key would refuse it anyway,
    -- and this refuses it earlier and says why.
    CONSTRAINT recovery_actions_one_per_subject UNIQUE (kind, subject_uuid)
);

CREATE INDEX recovery_actions_user ON recovery_actions (user_id, created_at DESC);
CREATE INDEX recovery_actions_recent ON recovery_actions (created_at DESC);

-- ---------------------------------------------------------------------------
--  APPEND-ONLY, the rule every trail in this schema follows.
--
--  A record of who gave money back that the person who gave it back can edit
--  tells you what the last person with access wanted you to believe.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recovery_actions_are_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'recovery_actions is append-only: a recovery cannot be % after the fact',
        lower(TG_OP);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recovery_actions_no_update
    BEFORE UPDATE OR DELETE ON recovery_actions
    FOR EACH ROW EXECUTE FUNCTION recovery_actions_are_append_only();

-- ---------------------------------------------------------------------------
--  WHAT IS WAITING FOR A PERSON.
--
--  One list across the flows that can hold money, because an operator asked
--  "whose money is stuck?" should not have to know which product it was stuck
--  in. `hours_held` rather than a timestamp alone: a queue of three that has
--  been three since Tuesday is a queue nobody is working, and the age is what
--  says which.
--
--  ALREADY-RECOVERED ROWS ARE EXCLUDED, so pressing the button removes the
--  item from the list rather than leaving it there looking unactioned.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW money_awaiting_recovery AS
SELECT
    'bank_payout'::recovery_kind AS kind,
    p.uuid                       AS subject_uuid,
    p.user_id,
    u.email,
    p.currency,
    p.amount_minor + p.fee_minor AS amount_minor,
    p.status::text               AS status,
    p.created_at,
    EXTRACT(EPOCH FROM (now() - p.created_at)) / 3600 AS hours_held,
    p.bank_name || ' ' || p.account_number AS destination
  FROM bank_payouts p
  JOIN users u ON u.id = p.user_id
 WHERE p.status = 'reserved'
   AND NOT EXISTS (SELECT 1 FROM recovery_actions r
                    WHERE r.kind = 'bank_payout' AND r.subject_uuid = p.uuid)

UNION ALL

SELECT
    'purchase'::recovery_kind,
    q.uuid,
    q.user_id,
    u.email,
    q.currency,
    q.amount_minor,
    q.status::text,
    q.created_at,
    EXTRACT(EPOCH FROM (now() - q.created_at)) / 3600,
    q.service::text || ' ' || q.target
  FROM purchases q
  JOIN users u ON u.id = q.user_id
 WHERE q.status = 'reserved'
   AND NOT EXISTS (SELECT 1 FROM recovery_actions r
                    WHERE r.kind = 'purchase' AND r.subject_uuid = q.uuid);

-- ---------------------------------------------------------------------------
--  COVERAGE, both directions. 019 fails on a table nobody has decided about
--  and 036 on a view nobody has classified — because the table nobody thought
--  of is the one that accumulates, and the queue nobody thought of is the one
--  that silently fills.
-- ---------------------------------------------------------------------------
INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('recovery_actions', 'keep',
   'A RECORD OF MONEY GIVEN BACK TO A CUSTOMER AND WHO DECIDED IT. AML '
   'requires records of a relationship for five years after it ends, and this '
   'is the trail somebody is read back to when they ask why they were '
   'refunded — or why they were not.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, queue_name, rationale) VALUES
  ('money_awaiting_recovery', 'queue', 'recovery',
   'Money held against something that never completed, past the point where a '
   'sweep should keep deciding on its own. It is a QUEUE rather than a watch '
   'because every row is one person waiting for their own money back.')
ON CONFLICT (source) DO NOTHING;

-- ---------------------------------------------------------------------------
--  AND AN ARM IN THE OVERVIEW, because 036 refuses a queue nobody can see.
--
--  That refusal is the whole point of the file: `admin_work_queue` once named
--  five sources and was written before disputes, monitoring, cases, stuck card
--  holds, consent, data requests and three drift views existed — so an
--  operator saw five empty queues and reasonably concluded there was nothing
--  to do. An incomplete list that looks complete is trusted, which is worse
--  than no overview. The coverage check caught this arm being missing before
--  anybody ran the screen.
--
--  Rewritten in full rather than appended to, because a view cannot be
--  extended in place: `CREATE OR REPLACE VIEW` may only add columns, never
--  change the query's shape.
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
    FROM bank_payouts_stuck
UNION ALL
  -- THE NEW ARM. Unconditional like every other, so "recovery: 0 waiting"
  -- says the queue was checked — an absent row says nothing at all, and the
  -- two look identical on a dashboard.
  SELECT 'recovery', COUNT(*), MIN(created_at) FROM money_awaiting_recovery;

-- ---------------------------------------------------------------------------
--  A RECOVERY MUST SAY WHY, in the audit log as well as in its own table.
--
--  009's list is the actions that take something away from a customer. This
--  one GIVES something back, and it is on the list for the mirror-image
--  reason: it moves money on somebody's say-so, and the reason is the sentence
--  the customer is eventually read back to. `price.retire` is on the same list
--  on the same argument — an action that looks like tidying and is not.
-- ---------------------------------------------------------------------------
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS destructive_actions_say_why;
ALTER TABLE admin_audit_log ADD CONSTRAINT destructive_actions_say_why CHECK (
    action NOT IN ('user.freeze', 'user.close', 'deposit.return', 'giftcard.clawback',
                   'data.erase', 'price.retire', 'recovery.reverse')
    OR reason IS NOT NULL
);

COMMIT;
