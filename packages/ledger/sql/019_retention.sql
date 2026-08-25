-- ============================================================================
--  019 — Data retention.
--
--  TWO OBLIGATIONS PULLING IN OPPOSITE DIRECTIONS, which is the whole reason
--  this is difficult rather than a cron entry. Nigeria's AML/CFT regulations
--  require records of a customer relationship to be KEPT for five years after
--  it ends. The NDPA requires personal data NOT to be kept longer than the
--  purpose needs. A policy that implements one of them is the policy that gets
--  the licence looked at; a policy that implements neither is what we had.
--
--  THIS IS THE ONLY SCHEDULED PROCESS IN THE SYSTEM WHOSE JOB IS TO DESTROY
--  DATA, so it is built the way the card reveal was: the dangerous thing is
--  made structurally impossible rather than carefully avoided.
--
--    * The LEDGER IS NEVER TOUCHED. `journal_entries`, `postings`, `accounts`
--      and `account_balances` are the financial record, and 011's triggers
--      already refuse a DELETE. This function does not name them — and
--      `retention_coverage` below makes that a stated decision rather than an
--      omission, so a reader can see that they were considered and excluded.
--    * Nothing is deleted from a table an append-only trigger protects. If
--      this function ever tried, the trigger would raise and the sweep would
--      fail loudly. That is the correct outcome and there is a test for it.
--    * Every period is a `platform_settings` row with CHECK bounds, so
--      shortening one during an incident does not need a deploy, and `0` typed
--      where `90` was meant is refused rather than deleting everything.
--
--  WHAT IS ACTUALLY PURGED, and why each one earns it:
--
--    staff_totp_used_steps  the replay guard needs the last two minutes and
--                           grows for ever otherwise. The only table here
--                           whose retention is measured in HOURS.
--    refresh_tokens         a consumed or expired token is the hash of a dead
--                           credential. Reuse detection only reaches back as
--                           far as a live family.
--    password_reset_tokens  same, and these are minted on every /forgot
--                           whether or not the address exists.
--    notification_outbox    a sent message already has its body erased; what
--                           is left is a list of who we emailed and when.
--    error_events           a resolved fingerprint nobody has seen again.
--    card_declines          a fraud signal with a short useful life.
--    auth_sessions          revoked ones, once no live refresh token can name
--                           them.
--
--  `card_reveals` WAS IN THAT LIST AND IS NOT ANY MORE. Its append-only trigger
--  refused the DELETE, and on looking at why, the trigger was right: a record of
--  who read a card number is worth what its immutability is worth, and a trail a
--  scheduled job can delete from is one an attacker with database access can
--  prune. The way to hold less there is to store less, which it already does.
--
--  WHAT IS KEPT AND WHY IS AS IMPORTANT AS WHAT IS DELETED. `kyc_submissions`
--  holds identity documents and is the row the NDPA cares about most — and it
--  is exactly the row AML says to keep for five years after the relationship
--  ends. It is therefore NOT purged on an age alone: deleting it while the
--  customer still banks with us would destroy the evidence that they were ever
--  verified. Closing that gap properly needs a closed-account lifecycle this
--  platform does not have yet, and inventing one inside a deletion job is the
--  wrong place to start. `retention_coverage` reports it as UNDECIDED, out
--  loud, which is the honest state.
-- ============================================================================

BEGIN;

INSERT INTO platform_settings
  (key, value, value_type, min_value, max_value, label, description, category, sensitive)
VALUES
  ('retention_totp_steps_hours', '2', 'integer', 1, 168,
   'Keep used TOTP steps for (hours)',
   'The replay guard only needs to recognise a code inside its own validity '
   'window. Everything older is a row that grows for ever and proves nothing.',
   'retention', TRUE),

  ('retention_tokens_days', '90', 'integer', 7, 3650,
   'Keep spent refresh and reset tokens for (days)',
   'A consumed or expired token is the hash of a credential that no longer '
   'works. Kept long enough to investigate an incident, not indefinitely.',
   'retention', TRUE),

  ('retention_notifications_days', '180', 'integer', 7, 3650,
   'Keep sent notifications for (days)',
   'A delivered message has already had its body erased. What remains is a '
   'record that we emailed this address on this day, which answers "did the '
   'customer get told?" for as long as anyone asks.',
   'retention', TRUE),

  ('retention_error_events_days', '180', 'integer', 7, 3650,
   'Keep resolved error fingerprints for (days)',
   'Only RESOLVED ones. An open fingerprint is a bug somebody still has to '
   'fix, however old it is.',
   'retention', TRUE),

  ('retention_card_declines_days', '365', 'integer', 30, 3650,
   'Keep card declines for (days)',
   'A fraud signal with a short useful life, and a record of where a customer '
   'shops.',
   'retention', TRUE)
ON CONFLICT (key) DO NOTHING;

/**
 * The one relaxation this migration makes to an append-only rule, and it took
 * a failing test to find it.
 *
 * `014_staff_totp.sql` refuses every DELETE from `staff_totp_used_steps`, for
 * a good reason: the record of a code's use is what makes it single-use, and
 * one DELETE would make a captured code live again. The consequence is that
 * the one table in this schema that grows without bound for no purpose could
 * not be purged at all — the retention sweep failed on it with
 * `restrict_violation`, which is how this was discovered rather than reasoned
 * about.
 *
 * A row here is only ever consulted to answer "has this code already been
 * used?", and a TOTP code is presentable for ninety seconds. A row older than
 * that CANNOT be the answer to that question for any code a caller could
 * still send, so deleting it weakens nothing. The trigger therefore refuses a
 * DELETE of anything recent and allows one that has aged out — bounded by the
 * same setting the sweep reads, whose CHECK floor is one hour, so the window
 * can never be narrowed to the point where it matters.
 *
 * Row-level rather than statement-level, because the decision is now about
 * WHICH row. An UPDATE stays refused outright: re-pointing a row is how a
 * spent code becomes an unspent one, and no age makes that safe.
 */
CREATE OR REPLACE FUNCTION assert_totp_step_append_only() RETURNS TRIGGER AS $$
DECLARE v_hours INT;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT value::INT INTO v_hours FROM platform_settings
         WHERE key = 'retention_totp_steps_hours';

        -- No configured window means no deletions. Refusing beats guessing,
        -- and guessing here makes a captured code live again.
        IF v_hours IS NOT NULL AND OLD.used_at < now() - make_interval(hours => v_hours) THEN
            RETURN OLD;
        END IF;
    END IF;

    RAISE EXCEPTION
        'a spent one-time code cannot be % while it could still be presented — '
        'the record of its use is what makes it single-use', lower(TG_OP)
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS totp_steps_append_only ON staff_totp_used_steps;
CREATE TRIGGER totp_steps_append_only
    BEFORE UPDATE OR DELETE ON staff_totp_used_steps
    FOR EACH ROW EXECUTE FUNCTION assert_totp_step_append_only();

/**
 * Deletes what has aged out, and reports what it did.
 *
 * NO DYNAMIC SQL, deliberately. A retention job driven by a table of names is
 * a job whose behaviour is changed by an INSERT — and the thing it does is
 * delete. Written out, "which tables are purged" is one readable list that
 * cannot be edited without review, and a new table is added by a diff somebody
 * approves rather than by a row somebody adds at 3am.
 *
 * Each statement is bounded by its own setting and none of them can reach a
 * ledger table, because none of them names one.
 */
CREATE OR REPLACE FUNCTION apply_retention()
RETURNS TABLE (table_name TEXT, deleted BIGINT) AS $$
DECLARE
    v_hours   INT;
    v_days    INT;
    v_count   BIGINT;
BEGIN
    SELECT value::INT INTO v_hours FROM platform_settings
     WHERE key = 'retention_totp_steps_hours';
    IF v_hours IS NULL THEN
        -- Refusing beats guessing. A retention job that invents its own
        -- periods when the settings are missing is a job that deletes on the
        -- strength of a default nobody reviewed.
        RAISE EXCEPTION 'retention settings are not configured; refusing to delete anything';
    END IF;

    DELETE FROM staff_totp_used_steps WHERE used_at < now() - make_interval(hours => v_hours);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'staff_totp_used_steps'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings WHERE key = 'retention_tokens_days';
    -- Only tokens that can no longer be used. A live one is a live session,
    -- and deleting it would sign a customer out for a housekeeping job.
    DELETE FROM refresh_tokens
     WHERE (consumed_at IS NOT NULL OR expires_at < now())
       AND issued_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'refresh_tokens'::TEXT, v_count;

    DELETE FROM password_reset_tokens
     WHERE (consumed_at IS NOT NULL OR expires_at < now())
       AND issued_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'password_reset_tokens'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_notifications_days';
    -- Sent or abandoned only. A PENDING message is one nobody has received,
    -- and deleting it would silently drop a password reset somebody is waiting
    -- on — which is the single worst thing this job could do.
    DELETE FROM notification_outbox
     WHERE status IN ('sent', 'abandoned')
       AND created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'notification_outbox'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_error_events_days';
    -- RESOLVED only. An open fingerprint is a bug somebody still has to fix,
    -- however old it is, and deleting it would hide a failure that is still
    -- happening.
    DELETE FROM error_events
     WHERE resolved_at IS NOT NULL
       AND last_seen_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'error_events'::TEXT, v_count;

    SELECT value::INT INTO v_days FROM platform_settings
     WHERE key = 'retention_card_declines_days';
    DELETE FROM card_declines WHERE created_at < now() - make_interval(days => v_days);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN QUERY SELECT 'card_declines'::TEXT, v_count;
END;
$$ LANGUAGE plpgsql;

COMMIT;

BEGIN;

/**
 * EVERY TABLE, AND WHAT WE DECIDED ABOUT IT.
 *
 * This is the retention analogue of `route-coverage.test.ts`, and it exists
 * for the same reason. A deletion job is a list of what somebody thought of;
 * the tables nobody thought of are invisible in it, and those are exactly the
 * ones that quietly accumulate customer data for years. So the decision is
 * recorded for EVERY table in the schema, including the ones we deliberately
 * keep for ever, and a table added next year with no entry shows up as
 * `UNDECIDED` rather than as nothing at all.
 *
 * `019_retention.test.sql` fails the build on an UNDECIDED row, which turns
 * "somebody should look at this" into "this does not merge".
 */
CREATE TABLE retention_decisions (
    table_name  TEXT PRIMARY KEY,
    /**
     * purge  — rows are deleted by apply_retention() once they age out.
     * keep   — kept for as long as the record exists, and WHY is stated.
     * derive — no independent lifetime; it goes when its parent does.
     */
    decision    TEXT NOT NULL CHECK (decision IN ('purge', 'keep', 'derive')),
    rationale   TEXT NOT NULL CHECK (length(rationale) >= 20)
);

INSERT INTO retention_decisions (table_name, decision, rationale) VALUES
  -- ---- The financial record. Never deleted, by trigger as well as by this. --
  ('journal_entries', 'keep',
   'The financial record. Append-only by trigger; AML requires five years and '
   'the ledger is the thing every other number is reconciled against.'),
  ('postings', 'keep',
   'Half of a journal entry. Deleting one would unbalance an entry that the '
   'per-currency invariant says must sum to zero.'),
  ('accounts', 'keep',
   'Every posting names one. An account row outlives its balance reaching zero.'),
  ('account_balances', 'derive',
   'Materialised from postings by trigger. It has no independent lifetime and '
   'deleting a row would make the drift view report a discrepancy that is not one.'),

  -- ---- Records of a customer relationship. AML: five years after it ends. ---
  ('users', 'keep',
   'The relationship itself. Every retention period below is measured against '
   'a customer who, until there is a closed-account lifecycle, never ends.'),
  ('kyc_submissions', 'keep',
   'Identity documents: the row the NDPA cares about most and the row AML says '
   'to keep for five years after the relationship ends. Deleting it while the '
   'customer still banks with us would destroy the proof that they were ever '
   'verified. Needs a closed-account lifecycle, which this platform lacks.'),
  ('provider_customers', 'keep',
   'The KYC mapping that gates cards and virtual accounts. Losing it makes an '
   'onboarded customer look unverified to every provider-backed route.'),
  ('user_status_changes', 'keep',
   'Why an account was frozen, and by whom. The record somebody asks for '
   'during a complaint or an audit, which is exactly when it must still exist.'),
  ('admin_audit_log', 'keep',
   'Append-only by trigger. A log a privileged user can shorten tells you what '
   'the last person with access wanted you to believe.'),
  ('disputes', 'keep',
   'Append-only by trigger. A complaints record with a regulatory deadline '
   'attached, which the regulator may ask about long after it closed.'),
  ('platform_settings_history', 'keep',
   'Who set the fee to 5% last March. Asked exactly once, during an incident.'),

  -- ---- Money-adjacent records that hang off the ledger. --------------------
  ('cards', 'keep', 'Every card webhook already delivered points at this row.'),
  ('purchases', 'keep', 'What a customer bought, and the delivery they may query.'),
  ('deposits', 'keep', 'Money that arrived. The reconciliation record.'),
  ('virtual_accounts', 'keep',
   'Permanent and immutable: customers save the number as a bank beneficiary.'),
  ('crypto_addresses', 'keep',
   'An address we issued. A deposit to a forgotten one has nowhere to land.'),
  ('crypto_deposits', 'keep', 'Money on a chain. The reconciliation record.'),
  ('crypto_withdrawals', 'keep', 'Money on a chain, unrecallable.'),
  ('fx_trades', 'keep', 'The rate a customer was given, which they may query.'),
  ('fx_spread_policies', 'keep', 'Append-only pricing history.'),
  ('giftcard_submissions', 'keep',
   'A payout against a bearer instrument: the highest-fraud surface here.'),
  ('giftcard_rate_cards', 'keep',
   'Append-only. Editing one rewrites the price of every past trade.'),
  ('card_authorizations', 'keep',
   'The settlement that matches an authorization can arrive fourteen business '
   'days later, and the duplicate check reads this table.'),
  ('card_freezes', 'keep', 'Why a card was frozen, including automatically.'),
  ('staff_roles', 'keep',
   'Who could approve what, and when. Append-only grants and revocations.'),

  -- ---- Purged. Each is deleted by apply_retention(). -----------------------
  ('staff_totp_used_steps', 'purge',
   'The replay guard needs the last two minutes. The only table here whose '
   'retention is measured in hours, and the only one that would otherwise grow '
   'without bound for no purpose at all.'),
  ('refresh_tokens', 'purge',
   'A consumed or expired token is the hash of a credential that no longer '
   'works. Reuse detection only reaches back as far as a live family.'),
  ('password_reset_tokens', 'purge',
   'Minted on every /forgot whether or not the address exists, so this table '
   'accumulates rows for people who do not have accounts.'),
  ('notification_outbox', 'purge',
   'A delivered message already has its body erased. What is left is a list of '
   'who we emailed and when.'),
  ('card_reveals', 'keep',
   'IT WAS GOING TO BE PURGED, and the append-only trigger from 016 refused — '
   'which turned out to be the right answer rather than an obstacle. This is '
   'an audit trail of who read a card number, and a trail a scheduled job can '
   'delete from is one an attacker with database access can prune. The way to '
   'hold less here is to STORE less, which it already does: it records that a '
   'reveal happened and never what it showed.'),
  ('error_events', 'purge',
   'Resolved fingerprints only. An open one is a bug somebody still has to fix.'),
  ('card_declines', 'purge',
   'A fraud signal with a short useful life, and a record of where a customer '
   'shops.'),

  -- ---- Tied to something else's lifetime. ----------------------------------
  ('auth_sessions', 'keep',
   'Which device signed in and when. A customer asking "was that me?" is '
   'asking about this table, and it is small.'),
  ('devices', 'keep',
   'A device fingerprint a customer recognises in their own security screen.'),
  ('user_credentials', 'derive',
   'One row per user, holding a hash. It goes when the user does.'),
  ('transaction_pins', 'derive', 'One row per user, holding a hash.'),
  ('biometric_enrollments', 'derive', 'One row per device, and no secret.'),
  ('staff_totp', 'derive', 'One row per staff member, holding a sealed secret.'),
  ('platform_settings', 'keep', 'Current policy. Its history is a separate table.'),
  ('retention_decisions', 'keep', 'This table. Deleting a decision is not a decision.')
ON CONFLICT (table_name) DO NOTHING;

/**
 * What has NO stated decision.
 *
 * Empty is the only acceptable state, and the invariant suite asserts it. A
 * table added next year without a line above appears here, which is the whole
 * point: the tables nobody thought about are the ones that accumulate customer
 * data for years.
 */
CREATE VIEW retention_coverage AS
SELECT t.tablename AS table_name,
       COALESCE(d.decision, 'UNDECIDED') AS decision,
       d.rationale
  FROM pg_tables t
  LEFT JOIN retention_decisions d ON d.table_name = t.tablename
 WHERE t.schemaname = 'public'
 ORDER BY (d.decision IS NULL) DESC, t.tablename;

COMMIT;
