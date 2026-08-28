-- ============================================================================
--  036 — Everything somebody has to look at, in one place.
--
--  WHAT WAS WRONG. `admin_work_queue` is what the operations overview reads,
--  and it names FIVE sources: KYC, suspense, gift card review, held purchases
--  and open crypto withdrawals. It was written in Phase 12, before disputes,
--  transaction monitoring, compliance cases, stuck card holds, consent,
--  data-subject requests and three drift views existed. Every one of those
--  shipped with its own view and none of them reached the overview.
--
--  So an operator opening the dashboard saw five queues, all empty, and
--  reasonably concluded there was nothing to do — while a statutory data
--  request ran past its deadline and the ledger drifted. That is worse than
--  no overview: an incomplete list that looks complete is trusted.
--
--  THE FIX IS NOT A LONGER LIST. It is that a list can no longer be short
--  without failing the build. `attention_sources` names EVERY view in this
--  schema against what it is for, and `attention_coverage` reports an
--  UNDECIDED one — in both directions, like `retention_coverage`. Adding a
--  view that reports a problem and forgetting the overview is now a red test
--  rather than a queue nobody works.
--
--  The argument is 019's, restated: a deletion job is a list of what somebody
--  thought of, and the tables nobody thought of are the ones that accumulate
--  data for years. A work queue is a list of what somebody thought of, and the
--  queue nobody thought of is the one that silently fills.
-- ============================================================================

BEGIN;

CREATE TABLE attention_sources (
    /** The view, or the table when a queue reads one directly. */
    source     TEXT PRIMARY KEY,

    /**
     * queue      — a person has to act on rows here, and it belongs on the
     *              overview. Empty is the resting state.
     * watch      — real information, read deliberately rather than worked. A
     *              lead rather than a task.
     * internal   — the application or a test reads it. Not an operator surface.
     */
    decision   TEXT NOT NULL CHECK (decision IN ('queue', 'watch', 'internal')),

    /** What it appears as on the overview. Required for a queue and forbidden
     *  otherwise, so the two cannot drift apart. */
    queue_name TEXT,

    rationale  TEXT NOT NULL CHECK (length(rationale) >= 20),

    CONSTRAINT attention_queue_is_named
        CHECK ((decision = 'queue') = (queue_name IS NOT NULL))
);

INSERT INTO attention_sources (source, decision, queue_name, rationale) VALUES
  -- ---- Queues. Somebody works these. ------------------------------------
  ('kyc_submissions', 'queue', 'kyc',
   'Identity submissions waiting for a reviewer. Until one is approved the '
   'customer can hold no card and no account number.'),
  ('unattributed_deposits', 'queue', 'suspense',
   'Money that arrived and could not be matched to a customer. Every row is '
   'somebody who is probably about to ring.'),
  ('giftcard_review_queue', 'queue', 'giftcard_review',
   'Gift cards submitted and not yet judged. Nothing is paid until a person '
   'decides, and there is deliberately no auto-approval.'),
  ('pending_purchases', 'queue', 'purchases_held',
   'Money reserved against an outcome nobody has learnt. The sweep asks the '
   'provider; one held past the stale window is escalated to a person.'),
  ('crypto_withdrawals_pending', 'queue', 'crypto_withdrawals_open',
   'Withdrawals reserved or broadcast and not resolved. On a chain the money '
   'is unrecallable, so a stuck one is looked at rather than retried.'),
  ('disputes_open', 'queue', 'disputes',
   'Customers saying a transaction was not theirs, against a deadline the '
   'database sets and nobody can move.'),
  ('risk_signals_open', 'queue', 'risk_signals',
   'Monitoring observations nobody has resolved. A signal is not a verdict, '
   'and the reason a reviewer records is what a regulator inspects.'),
  ('risk_cases_open', 'queue', 'risk_cases',
   'Investigations in progress, against a reporting deadline. One open case '
   'per customer, so this is a count of people rather than of signals.'),
  ('card_holds_stuck', 'queue', 'card_holds_stuck',
   'Card authorizations past the settlement window with no outcome. Invisible '
   'to everything else: the ledger balances and the money is simply held.'),
  ('consent_outstanding', 'queue', 'consent',
   'Customers who have not agreed to the version of the terms or privacy '
   'notice currently in force. Fills the moment one is republished.'),
  ('data_requests_due', 'queue', 'data_requests',
   'Requests for a copy of somebody data or for erasure, against a statutory '
   'window. Overdue here is a regulatory finding, not a slow reply.'),
  ('ledger_drift', 'queue', 'ledger_drift',
   'Materialised balances that disagree with their own postings. The number '
   'to read every morning: nothing else on the dashboard means anything '
   'until this is empty.'),
  ('provider_balance_drift', 'queue', 'provider_drift',
   'What a provider says it holds against what our ledger says it owes. A '
   'difference is either their bug or ours and both need a person.'),
  ('tax_remittance_drift', 'queue', 'tax_drift',
   'More tax held than any collection explains, which means a path posted the '
   'money and forgot to record it. Discovered otherwise while filing.'),
  ('notifications_abandoned', 'queue', 'notifications_abandoned',
   'Messages tried to the attempt ceiling and never accepted. Nobody got '
   'them, and some of them were password resets.'),
  ('errors_open', 'queue', 'errors',
   'Error fingerprints nobody has resolved. An open one is a bug somebody is '
   'still hitting.'),
  ('giftcard_holds_due', 'queue', 'giftcard_holds_due',
   'Approved payouts whose hold has matured and which the release worker has '
   'not made spendable. Its absence is silent: customers are paid and cannot '
   'spend it.'),
  ('staff_without_second_factor', 'queue', 'staff_without_totp',
   'A staff role with no authenticator is a role that cannot be used, and a '
   'privileged account behind one password.'),
  ('kyc_bvn_collisions', 'queue', 'bvn_collisions',
   'Two submissions claiming one BVN. Shown to a reviewer at approval rather '
   'than answered at the form, which would confirm to a stranger that a BVN '
   'banks here.'),
  ('token_reuse_incidents', 'queue', 'token_reuse',
   'A refresh token presented twice, which means it was stolen. The whole '
   'device family is already revoked; this is the record somebody reads.'),
  ('credential_stuffing_sources', 'queue', 'credential_stuffing',
   'One address failing against many different identifiers. The attack that '
   'is easiest to see from outside and was invisible here until 024.'),
  ('prices_without_an_author', 'queue', 'prices_unattributed',
   'Live prices written at a database prompt, so nobody is recorded as having '
   'set what customers are charged.'),

  -- ---- Watched. Real information, read rather than worked. ---------------
  ('accounts_sharing_an_address', 'watch',  NULL,
   'A lead and not a verdict: Nigerian carriers put whole subscriber pools '
   'behind a handful of addresses, which is why the request limiter counts '
   'per customer.'),
  ('accounts_sharing_a_device', 'watch', NULL,
   'The much stronger claim than a shared address, and still a lead. Read '
   'during an investigation rather than worked as a list.'),
  ('cards_frozen_automatically', 'watch', NULL,
   'Cards the protections froze without a person. Reviewed as a set to tune '
   'the thresholds, not one at a time.'),
  ('card_flagged_authorizations', 'watch', NULL,
   'Authorizations the card protections marked. Evidence for a decision '
   'somebody is already making about a card.'),
  ('card_settlement_differences', 'watch', NULL,
   'Settlements that differ from what was authorised. Normal within limits — '
   'tips and currency conversion — so a queue would cry wolf.'),
  ('crypto_deposits_maturing', 'watch', NULL,
   'Deposits seen and not yet confirmed. They mature on their own as blocks '
   'arrive; nothing here needs doing.'),
  ('card_reveal_activity', 'watch', NULL,
   'Who has read a card number and how often. Read when a card is disputed, '
   'and deliberately not deletable by the retention sweep.'),
  ('notification_backlog', 'watch', NULL,
   'How much the outbox is holding. A growing number means the worker has '
   'stopped, which is the failure that looks exactly like a quiet week.'),
  ('admin_liability', 'watch', NULL,
   'What the platform owes customers, per currency. The figure a finance team '
   'reconciles against, not a task list.'),
  ('customer_liability', 'watch', NULL,
   'The per-customer split behind the liability figure.'),
  ('admin_suspense', 'watch', NULL,
   'What is sitting in suspense, as an amount. The queue is '
   'unattributed_deposits; this is the money.'),
  ('dispute_losses', 'watch', NULL,
   'What upholding disputes has cost. Its own expense account so somebody has '
   'to look at the number rather than netting it against revenue.'),
  ('fx_spread_earned', 'watch', NULL,
   'What the FX spread has earned. A revenue figure, read monthly.'),
  ('revenue_monthly', 'watch', NULL,
   'What the business earned, read from postings so it cannot disagree with '
   'the ledger.'),
  ('tax_collected_monthly', 'watch', NULL,
   'What was collected for a revenue authority, per currency, for the return.'),
  ('tax_payable', 'watch', NULL,
   'What is held and not yet remitted, from the account balance rather than '
   'from the record of it.'),
  ('published_prices', 'watch', NULL,
   'What a customer will be quoted today. Checked before a deployment takes '
   'traffic; the queue is prices_without_an_author.'),
  ('provider_credential_status', 'watch', NULL,
   'Which integrations have a key, and never the keys. A map of what is live.'),
  ('erasure_scope', 'watch', NULL,
   'What an erasure request can and cannot reach, computed from the same '
   'table the deletion sweep reads.'),
  ('customer_consents', 'watch', NULL,
   'Where each customer currently stands. The queue is consent_outstanding.'),

  -- ---- Internal. The application or a test reads these. ------------------
  ('errors_alert_due', 'internal', NULL,
   'The alerter own input: fingerprints unseen or an order of magnitude '
   'worse. Read by the worker rather than by a person.'),
  ('active_cards', 'internal', NULL,
   'The card list a customer sees, filtered to what is live.'),
  ('active_sessions', 'internal', NULL,
   'Live sessions, read by the account security surface.'),
  ('card_history', 'internal', NULL,
   'A card whole life, read by the support card panel.'),
  ('customer_wallet_movements', 'internal', NULL,
   'Postings reshaped for the monitoring rules, which read postings rather '
   'than metadata so a flow cannot switch a control off by forgetting a key.'),
  ('entry_status', 'internal', NULL,
   'What later happened to an entry, derived rather than stored so it cannot '
   'drift from the ledger.'),
  ('retention_coverage', 'internal', NULL,
   'Every table against its retention decision. Read by the invariant suite, '
   'which fails on an UNDECIDED row.'),
  ('risk_currency_coverage', 'internal', NULL,
   'Currencies the ledger holds against currencies monitoring watches. Fails '
   'the build on a gap, because unmonitored has to be a visible state.'),
  ('kyc_tier_coverage', 'internal', NULL,
   'Every tier and currency against a limit. Fails the build on a gap: there '
   'is no fallback, so a gap would be no limit at all.'),
  ('kyc_blind_index_versions', 'internal', NULL,
   'How many blind index versions are live. Must be exactly one, or two '
   'accounts on one BVN are both approvable.'),
  ('attention_coverage', 'internal', NULL,
   'This file own coverage check. Read by the invariant suite.'),
  ('admin_work_queue', 'internal', NULL,
   'The overview itself, assembled from the queue rows below.');

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('attention_sources', 'keep',
   'What each view is for. Configuration rather than customer data, and '
   'deleting a row would quietly shorten the overview — which is the failure '
   'this file exists to make impossible.')
ON CONFLICT (table_name) DO NOTHING;

/**
 * Every view against what it is for.
 *
 * UNDECIDED in either direction fails the build: a view nobody classified,
 * and a classification for a view that no longer exists. The second matters
 * as much — a list describing a surface that is not there invites the reader
 * to stop trusting it, which is the argument `route-coverage.test.ts` makes
 * about routes.
 *
 * Tables appear only when a queue reads one directly, so they are matched by
 * name against both catalogues.
 */
CREATE VIEW attention_coverage AS
  SELECT v.viewname AS source,
         COALESCE(a.decision, 'UNDECIDED') AS decision,
         a.queue_name,
         a.rationale
    FROM pg_views v
    LEFT JOIN attention_sources a ON a.source = v.viewname
   WHERE v.schemaname = 'public'
UNION ALL
  -- A classification with nothing behind it.
  SELECT a.source, 'ORPHANED', a.queue_name, a.rationale
    FROM attention_sources a
   WHERE NOT EXISTS (
          SELECT 1 FROM pg_views v
           WHERE v.schemaname = 'public' AND v.viewname = a.source)
     AND NOT EXISTS (
          SELECT 1 FROM pg_tables t
           WHERE t.schemaname = 'public' AND t.tablename = a.source)
 ORDER BY 2, 1;

COMMIT;

BEGIN;

/**
 * What is waiting, everywhere.
 *
 * WRITTEN OUT, one arm per source, with no dynamic SQL. A queue assembled by
 * looping over `attention_sources` would be an overview whose behaviour
 * changes with an INSERT — the same reason `apply_retention()` and
 * `erase_customer_personal_data()` name their tables.
 *
 * Every arm is an UNCONDITIONAL AGGREGATE, so each source contributes exactly
 * one row even when it is empty. That is what lets the invariant suite compare
 * this against `attention_sources` exactly, in both directions, and it is also
 * the honest presentation: "consent: 0 waiting" says the queue was checked,
 * where an absent row says nothing at all.
 */
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
  -- No timestamp: drift is a disagreement about the present, not an event.
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
  SELECT 'prices_unattributed', COUNT(*), MIN(effective_from) FROM prices_without_an_author;

COMMIT;
