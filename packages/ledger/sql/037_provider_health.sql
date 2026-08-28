-- ============================================================================
--  037 — Whether a provider is answering.
--
--  WHAT WAS MISSING. The kill switches work — 013's Tier 1 made sure of that —
--  and every one of them has to be flipped BY HAND, which means noticing
--  first. Nothing recorded whether a provider call succeeded, so "is Bitnob
--  down?" was answered by reading application logs, and the first reliable
--  signal that a provider had stopped answering was a customer saying so.
--
--  A REJECTION IS NOT A FAILURE, and that distinction is the whole reason this
--  is worth building rather than counting exceptions. `ProviderRejectedError`
--  means the provider understood the request and refused it: insufficient
--  float, a frozen card, a declined authorization. Counting those as ill
--  health makes a provider look broken every time a customer's card is
--  declined — and an alert that fires on ordinary business is one people mute,
--  which is the lesson 015 records about alerting and 027 about thresholds.
--
--  What DOES mean something is unreachable, timed out, or unparseable. The
--  last is the one that pages: a contract error means the provider changed
--  their API, retrying produces the same failure for ever, and Phase 3 records
--  that every guessed constant in the Bitnob adapter was wrong.
--
--  BUCKETS, NOT ONE ROW PER CALL. A row per call is a log, and 015 already
--  records what happens to a table that becomes one: a single bad afternoon
--  buries the row that matters. One row per provider, operation and minute,
--  maintained by a single ON CONFLICT DO UPDATE — the same shape as
--  `record_error`, for the same reason.
--
--  THERE IS DELIBERATELY NO AUTOMATIC DISABLE. See `provider_degraded`.
-- ============================================================================

BEGIN;

CREATE TABLE provider_health (
    provider    TEXT        NOT NULL,
    /** The port method — `issueCard`, `quote`, `send`. Per operation rather
     *  than per provider, because one broken endpoint is a different incident
     *  from a provider being down, and the fix is different too. */
    operation   TEXT        NOT NULL,
    /** Truncated to the minute. Fine enough to see an outage start, coarse
     *  enough that a busy provider does not write a row per call. */
    bucket_at   TIMESTAMPTZ NOT NULL,

    attempts    INTEGER     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    succeeded   INTEGER     NOT NULL DEFAULT 0 CHECK (succeeded >= 0),

    /* The three that mean ill health, counted apart because they mean
       different things and are acted on differently. */
    unavailable INTEGER     NOT NULL DEFAULT 0 CHECK (unavailable >= 0),
    timed_out   INTEGER     NOT NULL DEFAULT 0 CHECK (timed_out >= 0),
    /** The provider replied with something the adapter cannot parse: they
     *  changed their contract. Retrying produces the same failure for ever, so
     *  this is the count that should page somebody rather than be watched. */
    contract    INTEGER     NOT NULL DEFAULT 0 CHECK (contract >= 0),

    /* And the one that does not. A refusal is the provider working. */
    rejected    INTEGER     NOT NULL DEFAULT 0 CHECK (rejected >= 0),

    /** The most recent failure message in this bucket. NOT every message: the
     *  point of a bucket is that it is a count, and keeping them all would
     *  make this the log it exists to avoid. */
    last_error  TEXT,

    PRIMARY KEY (provider, operation, bucket_at)
);

CREATE INDEX provider_health_by_bucket ON provider_health (bucket_at DESC);

/**
 * Records one call.
 *
 * ONE STATEMENT, and it can never fail the request that made it. The caller
 * swallows every error from this — a broken health table must not stop a
 * customer moving money, which is exactly the rule `record_error` follows and
 * for the same reason: the reporter is not more important than the thing it
 * reports on.
 */
CREATE OR REPLACE FUNCTION record_provider_call(
    p_provider  TEXT,
    p_operation TEXT,
    p_outcome   TEXT,
    p_error     TEXT DEFAULT NULL
) RETURNS VOID AS $$
    INSERT INTO provider_health AS h
      (provider, operation, bucket_at, attempts, succeeded,
       unavailable, timed_out, contract, rejected, last_error)
    VALUES (
      p_provider, p_operation, date_trunc('minute', now()), 1,
      CASE WHEN p_outcome = 'succeeded'   THEN 1 ELSE 0 END,
      CASE WHEN p_outcome = 'unavailable' THEN 1 ELSE 0 END,
      CASE WHEN p_outcome = 'timed_out'   THEN 1 ELSE 0 END,
      CASE WHEN p_outcome = 'contract'    THEN 1 ELSE 0 END,
      CASE WHEN p_outcome = 'rejected'    THEN 1 ELSE 0 END,
      p_error)
    ON CONFLICT (provider, operation, bucket_at) DO UPDATE SET
      attempts    = h.attempts    + 1,
      succeeded   = h.succeeded   + CASE WHEN p_outcome = 'succeeded'   THEN 1 ELSE 0 END,
      unavailable = h.unavailable + CASE WHEN p_outcome = 'unavailable' THEN 1 ELSE 0 END,
      timed_out   = h.timed_out   + CASE WHEN p_outcome = 'timed_out'   THEN 1 ELSE 0 END,
      contract    = h.contract    + CASE WHEN p_outcome = 'contract'    THEN 1 ELSE 0 END,
      rejected    = h.rejected    + CASE WHEN p_outcome = 'rejected'    THEN 1 ELSE 0 END,
      -- Kept only when this call actually failed, so a success does not erase
      -- the message somebody is about to read.
      last_error  = COALESCE(
        CASE WHEN p_outcome = 'succeeded' THEN h.last_error ELSE p_error END,
        h.last_error);
$$ LANGUAGE sql;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('provider_health_window_minutes', '15', 'integer', 1, 240,
   'Minutes of provider history to judge health on',
   'Short enough to notice an outage, long enough that a handful of calls do '
   'not read as one. Fifteen minutes is roughly a Bitnob retry cycle.',
   'operations', FALSE),

  ('provider_degraded_percent', '25', 'integer', 1, 100,
   'Failure rate at which a provider is called degraded',
   'Percent of attempts in the window that were unreachable, timed out or '
   'unparseable. REJECTIONS ARE NOT COUNTED: a declined card is the provider '
   'working, and an alert that fires on ordinary business is one people mute.',
   'operations', FALSE),

  ('provider_degraded_minimum_calls', '5', 'integer', 1, 1000,
   'Calls needed before a failure rate means anything',
   'One failed call out of one is a 100% failure rate and says nothing. This '
   'is what stops a quiet endpoint reading as an outage.',
   'operations', FALSE)
ON CONFLICT (key) DO NOTHING;

COMMIT;

BEGIN;

/**
 * How each provider has been answering lately.
 *
 * The window is a setting rather than a constant, because "lately" is
 * different for a card provider and an email provider, and an operator
 * watching an incident wants to narrow it.
 */
CREATE VIEW provider_health_recent AS
SELECT h.provider,
       h.operation,
       sum(h.attempts)::BIGINT    AS attempts,
       sum(h.succeeded)::BIGINT   AS succeeded,
       sum(h.rejected)::BIGINT    AS rejected,
       sum(h.unavailable)::BIGINT AS unavailable,
       sum(h.timed_out)::BIGINT   AS timed_out,
       sum(h.contract)::BIGINT    AS contract,
       /* The health figure, and note what is NOT in it. A rejection is the
          provider working, so counting it here would make a busy decline rate
          look like an outage. */
       (sum(h.unavailable) + sum(h.timed_out) + sum(h.contract))::BIGINT AS failures,
       CASE WHEN sum(h.attempts) = 0 THEN 0
            ELSE trunc(
              (sum(h.unavailable) + sum(h.timed_out) + sum(h.contract)) * 100.0
              / sum(h.attempts))::INT
       END AS failure_percent,
       max(h.bucket_at) AS last_seen,
       (array_agg(h.last_error ORDER BY h.bucket_at DESC)
          FILTER (WHERE h.last_error IS NOT NULL))[1] AS last_error
  FROM provider_health h
 WHERE h.bucket_at >= now() - make_interval(
         mins => COALESCE(
           (SELECT value::INT FROM platform_settings
             WHERE key = 'provider_health_window_minutes'), 15))
 GROUP BY h.provider, h.operation
 ORDER BY 9 DESC, 1, 2;

/**
 * Providers that look ill enough to act on.
 *
 * THERE IS NO AUTOMATIC DISABLE, and that is a decision rather than a gap.
 *
 * The obvious next step is to have this flip `crypto_enabled` or `cards_enabled`
 * off on its own, and it is wrong for three reasons. A flapping provider would
 * disable a flow nobody meant to stop, at whatever moment the rate crossed the
 * line. Re-enabling needs a person anyway — nothing here can know the incident
 * is over — so the automation only ever adds a surprise on the way in. And the
 * switches exist to be used deliberately during an incident by somebody who
 * understands it; a second hand on the same lever is how an operator turns
 * something on and watches it turn itself off.
 *
 * So this makes the failure VISIBLE and fast to act on. The switch is one
 * click away on the same dashboard, and flipping it is seconds. What was
 * missing was never the flipping; it was knowing.
 */
CREATE VIEW provider_degraded AS
SELECT r.provider,
       r.operation,
       r.attempts,
       r.failures,
       r.failure_percent,
       r.last_error,
       /* A contract error is its own severity: the provider changed their API,
          the same request will fail for ever, and no amount of waiting fixes
          it. Everything else may just be a bad ten minutes. */
       r.contract > 0 AS contract_broken
  FROM provider_health_recent r
 WHERE r.attempts >= COALESCE(
         (SELECT value::INT FROM platform_settings
           WHERE key = 'provider_degraded_minimum_calls'), 5)
   AND r.failure_percent >= COALESCE(
         (SELECT value::INT FROM platform_settings
           WHERE key = 'provider_degraded_percent'), 25)
 ORDER BY r.contract > 0 DESC, r.failure_percent DESC;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('provider_health', 'purge',
   'Counts of how a provider answered, per minute. Useful for days and then '
   'only as history; it holds no customer data, and keeping every minute for '
   'ever makes the recent window slower to read.')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO attention_sources (source, decision, queue_name, rationale) VALUES
  ('provider_degraded', 'queue', 'provider_degraded',
   'Providers failing often enough to act on. Deliberately not wired to the '
   'kill switches: a flapping provider would disable a flow nobody meant to '
   'stop, and re-enabling needs a person anyway.'),
  ('provider_health_recent', 'watch', NULL,
   'How every provider has been answering lately, including the ones that are '
   'fine. Read during an incident rather than worked as a list.')
ON CONFLICT (source) DO NOTHING;

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
  -- Added by 037. The coverage check in 036 is what would have failed the
  -- build if this arm had been forgotten, which is the point of it.
  SELECT 'provider_degraded', COUNT(*), NULL::TIMESTAMPTZ FROM provider_degraded;

COMMIT;
