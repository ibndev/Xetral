-- ============================================================================
--  027 — Transaction monitoring.
--
--  WHAT WAS MISSING, AND HOW IT DIFFERS FROM WHAT IS ALREADY HERE.
--
--  This platform already REFUSES things. The daily ceiling refuses a transfer
--  over a kobo limit; the velocity rules refuse a customer paying too many
--  strangers in a day; the card protections freeze a card on a second
--  suspicious authorization. Every one of those is a control that acts, and
--  every one is therefore tuned to almost never fire — because the cost of a
--  false positive is a real customer refused their own money.
--
--  Monitoring is the other half, and it is not the same job. AML asks a
--  different question: not "should this be allowed?" but "should somebody
--  LOOK at this?". The answer can be yes far more often, because the cost of a
--  false positive is a reviewer's minute rather than a customer's rent.
--
--  So a signal is an OBSERVATION, NEVER A VERDICT. Nothing here refuses a
--  transaction, freezes an account, or holds money. It cannot: it runs after
--  the fact, on a sweep. Anything that needs to act before money moves belongs
--  in a ledger precondition, where 009 and 021 put it.
--
--  EVERY RULE READS POSTINGS. Not an entry's metadata, not a service's own
--  bookkeeping. A control that depends on a key some flow remembered to set is
--  a control that switches itself off the first time a new flow forgets —
--  which is the rule 017 already records about velocity, and it applies with
--  more force here, because nothing fails when monitoring stops working.
--
--  THRESHOLDS ARE PER CURRENCY, IN A TABLE, and that is not ceremony. An
--  amount carries units: a kobo ceiling applied to USDT because both are
--  integers is the same mistake as adding kobo to cents, and this file is full
--  of amounts. A table rather than settings keys means adding a currency is a
--  row instead of four keys, and — the actual point — `risk_currency_coverage`
--  can report a currency the ledger holds and this file does not monitor.
--  Unmonitored is a real state; it must be a visible one.
-- ============================================================================

BEGIN;

/**
 * The rules, by name.
 *
 * An enum rather than free text, for the reason Phase 3 recorded about
 * `EntryKind`: a TypeScript union and a Postgres enum drift, and only an
 * insert proves they still agree. A rule the API can name and the database
 * cannot is a rule that throws on its first real firing.
 */
CREATE TYPE risk_rule AS ENUM (
    /** One movement at or above the reporting threshold. */
    'large_value',
    /** Several movements each just under it, together above it. */
    'structuring',
    /** Money in and straight back out — the mule-account signature. */
    'rapid_passthrough',
    /** An account quiet for months, suddenly not. */
    'dormant_reactivation',
    /** A withdrawal onto a chain, shortly after money arrived. Unrecallable. */
    'crypto_fast_out'
);

/**
 * What counts as notable, per currency.
 *
 * `large_value_minor` should be the CURRENT REGULATORY REPORTING THRESHOLD for
 * this currency, and the seed's figure is a starting point rather than legal
 * advice: an operator must set it to whatever the NFIU requires today, and it
 * is a `platform_settings`-style row precisely so that takes a dashboard edit
 * and not a deploy.
 *
 * `notable_minor` is the floor below which the proportional rules stay quiet.
 * Without it, an account moving two hundred naira in and out fires
 * `rapid_passthrough` every day — and a rule people learn to ignore is worse
 * than no rule, which is the lesson `015_error_events.sql` records about
 * alerting.
 */
CREATE TABLE risk_thresholds (
    currency           TEXT   PRIMARY KEY,
    large_value_minor  BIGINT NOT NULL CHECK (large_value_minor > 0),
    notable_minor      BIGINT NOT NULL CHECK (notable_minor > 0),
    CONSTRAINT notable_is_not_above_large CHECK (notable_minor <= large_value_minor)
);

CREATE TABLE risk_signals (
    id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    uuid        UUID        NOT NULL DEFAULT gen_random_uuid(),

    rule        risk_rule   NOT NULL,
    user_id     BIGINT      NOT NULL REFERENCES users(id),

    /**
     * What makes this signal THIS signal, so a sweep that runs every ten
     * minutes does not produce a new row every ten minutes.
     *
     * Built by the rule that raised it, from the thing it actually saw: a
     * posting id where the rule is about one movement, and a customer plus a
     * Lagos day where it is about a pattern across several. The same
     * discipline as the ledger's `idempotency_key` — a repeat is a no-op
     * rather than a duplicate, and the UNIQUE constraint is what enforces it
     * rather than the sweep remembering.
     */
    signal_key  TEXT        NOT NULL,

    /**
     * The numbers the rule saw, so a reviewer can check its arithmetic rather
     * than trust it. Never a card number, a BVN or a token: this table is read
     * by everyone on the compliance rota.
     */
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,

    observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    /** Closed by a person, with a reason. A signal nobody has decided about is
     *  the queue; one closed with no explanation is a queue that was cleared
     *  rather than worked. */
    resolved_at TIMESTAMPTZ NULL,
    resolved_by BIGINT      NULL REFERENCES users(id),
    resolution  TEXT        NULL,

    CONSTRAINT risk_signals_uuid_key UNIQUE (uuid),
    CONSTRAINT risk_signals_key_unique UNIQUE (signal_key),
    CONSTRAINT risk_resolution_is_complete CHECK (
        (resolved_at IS NULL) = (resolved_by IS NULL)
        AND (resolved_at IS NULL) = (resolution IS NULL)
    )
);

CREATE INDEX risk_signals_unresolved ON risk_signals (observed_at DESC)
    WHERE resolved_at IS NULL;
CREATE INDEX risk_signals_user ON risk_signals (user_id, observed_at DESC);

/**
 * A signal is a record that a rule fired, so the rule, the customer and the
 * evidence are immutable. Only the resolution may be written, and only once.
 *
 * The same shape as the dispute state machine: an outcome is final. Reopening
 * a closed signal in place would erase that somebody looked at it and decided,
 * which is the one thing this table exists to prove to a regulator.
 */
CREATE OR REPLACE FUNCTION assert_risk_signal_append_only() RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a risk signal cannot be deleted'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF NEW.rule <> OLD.rule OR NEW.user_id <> OLD.user_id
       OR NEW.signal_key <> OLD.signal_key OR NEW.detail <> OLD.detail
       OR NEW.observed_at <> OLD.observed_at THEN
        RAISE EXCEPTION 'a risk signal records what a rule saw; that is immutable'
            USING ERRCODE = 'restrict_violation';
    END IF;

    IF OLD.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'risk signal % is already resolved; raise a new one', OLD.uuid
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER risk_signals_append_only
    BEFORE UPDATE OR DELETE ON risk_signals
    FOR EACH ROW EXECUTE FUNCTION assert_risk_signal_append_only();

COMMIT;

BEGIN;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('risk_structuring_count', '3', 'integer', 2, 50,
   'Movements that make a pattern',
   'How many separate movements, each below the reporting threshold and '
   'together above it, count as structuring in one Lagos day. Two is a busy '
   'morning; several is somebody who knows what the threshold is.',
   'risk', TRUE),

  ('risk_passthrough_percent', '80', 'integer', 10, 100,
   'Pass-through proportion (%)',
   'What share of the day''s credits has to leave again for the account to '
   'look like a conduit rather than a wallet. Money in and straight out is '
   'the mule-account signature, and it is a proportion rather than an amount '
   'so it means the same thing in every currency.',
   'risk', TRUE),

  ('risk_dormant_days', '180', 'integer', 30, 1095,
   'Quiet before a reactivation counts (days)',
   'How long an account must have been silent for its next movement to be '
   'worth a look. A long-dormant account waking up is what a sold or '
   'recovered credential looks like from here.',
   'risk', TRUE),

  ('risk_crypto_fast_out_hours', '6', 'integer', 1, 168,
   'Deposit to chain withdrawal (hours)',
   'How soon after money arrives a crypto withdrawal is worth flagging. A '
   'chain transaction cannot be recalled, so this is the one pattern where '
   'the window between noticing and being unable to act is measured in '
   'minutes.',
   'risk', TRUE),

  ('risk_monitoring_enabled', 'true', 'boolean', NULL, NULL,
   'Transaction monitoring',
   'Whether the sweep raises signals at all. Off is a deliberate act with a '
   'reason: an AML programme that stopped observing and nobody noticed is the '
   'finding that costs a licence.',
   'risk', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * Every currency the ledger actually holds, against whether this file watches
 * it.
 *
 * The retention analogue, and it exists for the same reason
 * `retention_coverage` does: a monitoring programme is a list of what somebody
 * thought of, and the currencies nobody thought of are invisible in it. An
 * account moving money in a currency with no threshold row is not being
 * monitored, and that has to be a visible state rather than a silent one.
 *
 * `027_risk_signals.test.sql` fails the build on an unmonitored currency, so
 * adding one to the registry without a threshold does not merge.
 */
CREATE VIEW risk_currency_coverage AS
SELECT c.currency,
       (t.currency IS NOT NULL) AS monitored,
       t.large_value_minor,
       t.notable_minor
  FROM (SELECT DISTINCT currency FROM accounts) c
  LEFT JOIN risk_thresholds t ON t.currency = c.currency
 ORDER BY (t.currency IS NULL) DESC, c.currency;

/**
 * The start of the current Lagos day.
 *
 * "Today" is a Lagos day everywhere in this codebase — a UTC boundary would
 * roll these rules over at 1am local, which is surprising to a customer and an
 * hour a fraudster would learn.
 */
CREATE OR REPLACE FUNCTION lagos_day_start(p_at TIMESTAMPTZ DEFAULT now())
RETURNS TIMESTAMPTZ AS $$
    SELECT (date_trunc('day', p_at AT TIME ZONE 'Africa/Lagos') AT TIME ZONE 'Africa/Lagos');
$$ LANGUAGE sql STABLE;

/**
 * A customer's own wallet movements, which is what every rule below reads.
 *
 * From POSTINGS, joined to accounts, and only the customer's own leg — the
 * same shape the wallet's own history takes. A transfer's fee leg and the
 * recipient's leg belong to other stories.
 */
CREATE VIEW customer_wallet_movements AS
SELECT p.id            AS posting_id,
       a.owner_id      AS user_id,
       p.currency,
       p.amount_minor,
       e.id            AS entry_id,
       e.kind          AS entry_kind,
       e.occurred_at
  FROM postings p
  JOIN accounts a        ON a.id = p.account_id
  JOIN journal_entries e ON e.id = p.journal_entry_id
 WHERE a.kind = 'customer_wallet' AND a.owner_type = 'user';

COMMIT;

BEGIN;

/**
 * Runs every rule and records what it found.
 *
 * ONE FUNCTION, NAMING ITS TABLES LITERALLY, with no dynamic SQL — the same
 * discipline `apply_retention()` follows, and for a related reason: a
 * monitoring job whose behaviour can be changed by an INSERT is a monitoring
 * job an attacker can turn off with an INSERT.
 *
 * Every insert is `ON CONFLICT (signal_key) DO NOTHING`, so running the sweep
 * twice — or ten times, from ten instances — produces the same rows. That is
 * what makes the advisory lock in the worker an optimisation rather than a
 * correctness requirement, exactly as it is for the purchase reconciler.
 *
 * Returns a count per rule, so a sweep that suddenly finds nothing is visible
 * in the logs rather than being indistinguishable from a quiet day.
 */
CREATE OR REPLACE FUNCTION detect_risk_signals()
RETURNS TABLE (rule TEXT, raised BIGINT) AS $$
DECLARE
    v_count     BIGINT;
    v_structure INT;
    v_percent   INT;
    v_dormant   INT;
    v_hours     INT;
    v_enabled   TEXT;
    v_day       TIMESTAMPTZ := lagos_day_start();
BEGIN
    SELECT value INTO v_enabled FROM platform_settings WHERE key = 'risk_monitoring_enabled';
    IF v_enabled IS DISTINCT FROM 'true' THEN
        -- Off is a deliberate act. Returning no rows rather than raising, so
        -- an operator who switched it off during an incident does not also get
        -- a failing worker to investigate.
        RETURN;
    END IF;

    SELECT value::INT INTO v_structure FROM platform_settings WHERE key = 'risk_structuring_count';
    SELECT value::INT INTO v_percent   FROM platform_settings WHERE key = 'risk_passthrough_percent';
    SELECT value::INT INTO v_dormant   FROM platform_settings WHERE key = 'risk_dormant_days';
    SELECT value::INT INTO v_hours     FROM platform_settings
     WHERE key = 'risk_crypto_fast_out_hours';

    IF v_structure IS NULL OR v_percent IS NULL OR v_dormant IS NULL OR v_hours IS NULL THEN
        -- Refusing beats guessing, the same answer `apply_retention()` gives.
        -- A monitoring run on invented thresholds is worse than none, because
        -- its output looks exactly like a real one.
        RAISE EXCEPTION 'risk settings are not configured; refusing to monitor on defaults';
    END IF;

    -- ---- 1. ONE MOVEMENT AT OR ABOVE THE REPORTING THRESHOLD --------------
    -- Keyed on the POSTING, so this is naturally one signal per movement and
    -- a re-run cannot duplicate it. Only currencies with a threshold row are
    -- considered; `risk_currency_coverage` is where an unmonitored one shows.
    INSERT INTO risk_signals (rule, user_id, signal_key, detail)
    SELECT 'large_value', m.user_id,
           'large_value:' || m.posting_id,
           jsonb_build_object(
             'currency', m.currency,
             'amount_minor', abs(m.amount_minor)::TEXT,
             'threshold_minor', t.large_value_minor::TEXT,
             'direction', CASE WHEN m.amount_minor > 0 THEN 'in' ELSE 'out' END,
             'entry_kind', m.entry_kind::TEXT,
             'entry_id', m.entry_id::TEXT)
      FROM customer_wallet_movements m
      JOIN risk_thresholds t ON t.currency = m.currency
     WHERE abs(m.amount_minor) >= t.large_value_minor
       -- A bounded look-back, so the first sweep on an old database does not
       -- raise a signal for every large transfer since Phase 4.
       AND m.occurred_at >= now() - interval '7 days'
    ON CONFLICT (signal_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'large_value'::TEXT, v_count;

    -- ---- 2. SEVERAL JUST UNDER IT, TOGETHER ABOVE ------------------------
    -- The classic. Each piece is deliberately unremarkable, which is why the
    -- large-value rule above cannot see it and why counting is the only way.
    --
    -- Per DIRECTION, because breaking up money coming in and money going out
    -- are different behaviours with different explanations, and a signal that
    -- merged them would tell a reviewer neither.
    INSERT INTO risk_signals (rule, user_id, signal_key, detail)
    SELECT 'structuring', d.user_id,
           'structuring:' || d.direction || ':' || d.user_id || ':' || d.currency
             || ':' || to_char(v_day, 'YYYY-MM-DD'),
           jsonb_build_object(
             'currency', d.currency,
             'direction', d.direction,
             'movements', d.movements,
             'total_minor', d.total::BIGINT::TEXT,
             'threshold_minor', d.large_value_minor::TEXT,
             'largest_minor', d.largest::BIGINT::TEXT)
      FROM (
        SELECT m.user_id,
               m.currency,
               CASE WHEN m.amount_minor > 0 THEN 'in' ELSE 'out' END AS direction,
               count(*)                  AS movements,
               sum(abs(m.amount_minor))  AS total,
               max(abs(m.amount_minor))  AS largest,
               t.large_value_minor
          FROM customer_wallet_movements m
          JOIN risk_thresholds t ON t.currency = m.currency
         WHERE m.occurred_at >= v_day
           -- Each piece BELOW the threshold. One that is above it is already
           -- a large_value signal, and counting it here would report an
           -- ordinary large payment plus its change as a pattern.
           AND abs(m.amount_minor) < t.large_value_minor
         GROUP BY m.user_id, m.currency, 3, t.large_value_minor
        HAVING count(*) >= v_structure
           AND sum(abs(m.amount_minor)) >= max(t.large_value_minor)
      ) d
    ON CONFLICT (signal_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'structuring'::TEXT, v_count;

    -- ---- 3. MONEY IN AND STRAIGHT BACK OUT -------------------------------
    -- A proportion, so it means the same thing in every currency — unlike an
    -- amount, which would have to be restated per currency and would then be
    -- wrong for the one nobody restated.
    --
    -- Credits and debits are compared WITHIN one currency. Netting them across
    -- currencies would add kobo to cents, which is the exact arithmetic the
    -- ledger's per-currency balance invariant exists to refuse.
    INSERT INTO risk_signals (rule, user_id, signal_key, detail)
    SELECT 'rapid_passthrough', d.user_id,
           'passthrough:' || d.user_id || ':' || d.currency
             || ':' || to_char(v_day, 'YYYY-MM-DD'),
           jsonb_build_object(
             'currency', d.currency,
             'credited_minor', d.credited::BIGINT::TEXT,
             'debited_minor', d.debited::BIGINT::TEXT,
             'percent_out', trunc(d.debited * 100 / d.credited)::BIGINT::TEXT,
             'threshold_percent', v_percent::TEXT)
      FROM (
        SELECT m.user_id, m.currency,
               sum(m.amount_minor) FILTER (WHERE m.amount_minor > 0)        AS credited,
               -sum(m.amount_minor) FILTER (WHERE m.amount_minor < 0)       AS debited,
               t.notable_minor
          FROM customer_wallet_movements m
          JOIN risk_thresholds t ON t.currency = m.currency
         WHERE m.occurred_at >= v_day
         GROUP BY m.user_id, m.currency, t.notable_minor
      ) d
     WHERE d.credited IS NOT NULL AND d.debited IS NOT NULL
       -- The floor. Without it an account moving two hundred naira in and out
       -- fires this every day, and a rule people learn to ignore is worse than
       -- no rule.
       AND d.credited >= d.notable_minor
       AND d.debited * 100 >= d.credited * v_percent
    ON CONFLICT (signal_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'rapid_passthrough'::TEXT, v_count;

    -- ---- 4. A LONG SILENCE, THEN MOVEMENT --------------------------------
    -- What a sold or recovered credential looks like from here. Keyed on the
    -- posting that broke the silence, so it fires once per reactivation rather
    -- than on every movement of the busy week that follows.
    INSERT INTO risk_signals (rule, user_id, signal_key, detail)
    SELECT 'dormant_reactivation', m.user_id,
           'dormant:' || m.posting_id,
           jsonb_build_object(
             'currency', m.currency,
             'amount_minor', abs(m.amount_minor)::TEXT,
             'quiet_days', extract(day FROM m.occurred_at - prev.last_at)::INT,
             'entry_kind', m.entry_kind::TEXT)
      FROM customer_wallet_movements m
      JOIN risk_thresholds t ON t.currency = m.currency
      JOIN LATERAL (
        -- The last movement on this ACCOUNT before this one, in any currency:
        -- a customer active in dollars is not dormant because their naira
        -- wallet was quiet.
        SELECT max(e.occurred_at) AS last_at
          FROM customer_wallet_movements e
         WHERE e.user_id = m.user_id AND e.posting_id < m.posting_id
      ) prev ON TRUE
     WHERE m.occurred_at >= now() - interval '7 days'
       AND abs(m.amount_minor) >= t.notable_minor
       AND prev.last_at IS NOT NULL
       AND m.occurred_at - prev.last_at >= make_interval(days => v_dormant)
    ON CONFLICT (signal_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'dormant_reactivation'::TEXT, v_count;

    -- ---- 5. ONTO A CHAIN, SHORTLY AFTER MONEY ARRIVED --------------------
    -- Its own rule rather than a case of pass-through, because the RESPONSE
    -- differs: a chain transaction cannot be recalled, so the window in which
    -- anybody can act is the one before it is broadcast.
    --
    -- The time proximity is the signal, and the amounts are deliberately NOT
    -- compared: money arriving in naira and leaving as USDT crosses an FX
    -- trade, and comparing the two sides would be adding kobo to cents. The
    -- withdrawal has to clear its own currency's floor; the credit only has to
    -- have happened.
    INSERT INTO risk_signals (rule, user_id, signal_key, detail)
    SELECT 'crypto_fast_out', w.user_id,
           'crypto_fast_out:' || w.posting_id,
           jsonb_build_object(
             'currency', w.currency,
             'amount_minor', abs(w.amount_minor)::TEXT,
             'hours_after_credit',
               round(extract(epoch FROM w.occurred_at - c.credited_at) / 3600.0, 1)::TEXT,
             'credit_kind', c.entry_kind::TEXT)
      FROM customer_wallet_movements w
      JOIN risk_thresholds t ON t.currency = w.currency
      JOIN LATERAL (
        SELECT e.occurred_at AS credited_at, e.entry_kind
          FROM customer_wallet_movements e
         WHERE e.user_id = w.user_id
           AND e.amount_minor > 0
           AND e.occurred_at <= w.occurred_at
           AND e.occurred_at >= w.occurred_at - make_interval(hours => v_hours)
         ORDER BY e.occurred_at DESC
         LIMIT 1
      ) c ON TRUE
     WHERE w.entry_kind = 'crypto_withdrawal'
       AND w.amount_minor < 0
       AND abs(w.amount_minor) >= t.notable_minor
       AND w.occurred_at >= now() - interval '7 days'
    ON CONFLICT (signal_key) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'crypto_fast_out'::TEXT, v_count;
END;
$$ LANGUAGE plpgsql;

/** The queue, oldest first, with the customer named so a reviewer does not
 *  have to join by hand. */
CREATE VIEW risk_signals_open AS
SELECT s.uuid, s.rule::TEXT AS rule, s.detail, s.observed_at,
       s.user_id, u.uuid AS user_uuid, u.email, u.status::TEXT AS user_status,
       -- How many OTHER open signals this customer has. One signal is a
       -- transaction; several is a pattern, and a reviewer should see that
       -- before they open the first one.
       (SELECT count(*) FROM risk_signals o
         WHERE o.user_id = s.user_id AND o.resolved_at IS NULL AND o.id <> s.id)
         AS other_open_signals
  FROM risk_signals s
  JOIN users u ON u.id = s.user_id
 WHERE s.resolved_at IS NULL
 ORDER BY s.observed_at;

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  ('risk_signals', 'keep',
   'The AML record: what was flagged, what a reviewer decided, and when. This '
   'is the evidence a regulator asks for and the reason the table is '
   'append-only; deleting from it on an age would destroy exactly the years '
   'AML says to keep.'),
  ('risk_thresholds', 'keep',
   'What counted as notable, per currency. Deleting a row would silently stop '
   'monitoring that currency, which is the failure the coverage view exists '
   'to make visible.')
ON CONFLICT (table_name) DO NOTHING;

COMMIT;
