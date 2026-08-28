-- ===========================================================================
--  Xetral — is this restored copy a usable ledger?
--  deploy/standby/verify-restore.sql
--
--  Run against a RESTORED database, by `restore-drill.sh` or by a person
--  holding a copy they are about to trust.
--
--  WHY THIS IS A FILE AND NOT SHELL. Two reasons, and the second is the one
--  that matters. It is reviewable — these are the questions somebody must be
--  able to disagree with before an incident, not during one. And it is
--  runnable by hand: at 3am, against a copy restored by whatever means were
--  available, by somebody who is not going to read a 200-line bash script
--  first.
--
--  WHAT IT IS FOR. "Postgres started" is not a restored database. A truncated
--  or partially-recovered copy usually starts perfectly: the data directory is
--  valid, connections are accepted, and the ledger is quietly missing a week.
--  Every check below is chosen because it FAILS on such a copy.
--
--  It raises on the first failure, so `psql -v ON_ERROR_STOP=1` exits non-zero
--  and a drill cannot report success by printing reassuring text.
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

\echo '=== 1. The schema the application requires is present ==='
DO $$
DECLARE
    v_missing TEXT;
BEGIN
    -- Named individually rather than counted. A count passes when fifteen
    -- tables exist and the one the money is in is not among them.
    SELECT string_agg(t, ', ') INTO v_missing
      FROM unnest(ARRAY[
        'users', 'accounts', 'journal_entries', 'postings', 'account_balances',
        'auth_sessions', 'refresh_tokens', 'cards', 'purchases', 'deposits',
        'crypto_deposits', 'crypto_withdrawals', 'platform_settings',
        'admin_audit_log', 'notification_outbox'
      ]) AS t
     WHERE to_regclass('public.' || t) IS NULL;

    IF v_missing IS NOT NULL THEN
        RAISE EXCEPTION
            'RESTORE FAILED: these tables are missing, so this archive predates '
            'a migration the application needs: %', v_missing;
    END IF;
    RAISE NOTICE 'PASS: every required table is present';
END $$;

\echo ''
\echo '=== 2. The ledger is not EMPTY ==='
-- An empty ledger restores perfectly and is worth nothing. No structural
-- check anywhere else in this file would notice.
DO $$
DECLARE v_postings BIGINT; v_entries BIGINT;
BEGIN
    SELECT count(*) INTO v_entries FROM journal_entries;
    SELECT count(*) INTO v_postings FROM postings;

    IF v_postings = 0 THEN
        RAISE EXCEPTION 'RESTORE FAILED: the restored ledger has no postings at all';
    END IF;
    RAISE NOTICE 'PASS: % journal entries, % postings', v_entries, v_postings;
END $$;

\echo ''
\echo '=== 3. Every entry still balances, PER CURRENCY ==='
--
-- THE CHECK THAT MATTERS MOST IN THIS FILE.
--
-- A restore that lost rows in the middle of an entry passes every structural
-- test above: the tables are there, the row counts look plausible, the server
-- is happy. This is the only place the loss becomes visible.
--
-- Per currency rather than per entry, for the reason 001_ledger.sql gives: a
-- whole-entry sum adds kobo to cents as raw integers, so two independent
-- errors in different currencies cancel and the check passes.
DO $$
DECLARE v_broken BIGINT; v_example BIGINT;
BEGIN
    SELECT count(*), min(journal_entry_id) INTO v_broken, v_example
      FROM (
        SELECT journal_entry_id, currency, sum(amount_minor) AS total
          FROM postings
         GROUP BY journal_entry_id, currency
        HAVING sum(amount_minor) <> 0
      ) AS unbalanced;

    IF v_broken > 0 THEN
        RAISE EXCEPTION
            'RESTORE FAILED: % journal entry/currency pair(s) do not sum to zero '
            '(for example entry %). Rows were lost inside an entry.',
            v_broken, v_example;
    END IF;
    RAISE NOTICE 'PASS: every entry balances in every currency';
END $$;

\echo ''
\echo '=== 4. Materialised balances agree with the postings ==='
-- `ledger_drift` is the view the platform already uses for this, so the drill
-- asks the same question production asks nightly rather than a second version
-- of it that could disagree.
DO $$
DECLARE v_drift BIGINT;
BEGIN
    SELECT count(*) INTO v_drift FROM ledger_drift;
    IF v_drift > 0 THEN
        RAISE EXCEPTION
            'RESTORE FAILED: % account(s) whose cached balance disagrees with '
            'their postings', v_drift;
    END IF;
    RAISE NOTICE 'PASS: no drift between balances and postings';
END $$;

\echo ''
\echo '=== 5. No customer is overdrawn ==='
-- The overdraft guard is a trigger, so it protects WRITES. A restore is not a
-- write path, and a copy assembled from the wrong pieces can hold a state the
-- running system would have refused.
DO $$
DECLARE v_negative BIGINT;
BEGIN
    SELECT count(*) INTO v_negative
      FROM account_balances b
      JOIN accounts a ON a.id = b.account_id
     WHERE a.kind IN ('customer_wallet', 'customer_card', 'customer_pending')
       AND b.balance_minor < 0;

    IF v_negative > 0 THEN
        RAISE EXCEPTION
            'RESTORE FAILED: % customer account(s) are overdrawn, which the '
            'running system would never have permitted', v_negative;
    END IF;
    RAISE NOTICE 'PASS: no customer account is negative';
END $$;

\echo ''
\echo '=== 6. How far back this copy takes us ==='
-- Not a pass/fail. It is the number an operator needs in order to know what
-- restoring would actually COST, and the one nobody can produce during an
-- incident because nobody looked before.
DO $$
DECLARE v_newest TIMESTAMPTZ; v_age INTERVAL;
BEGIN
    SELECT max(created_at) INTO v_newest FROM journal_entries;
    v_age := now() - v_newest;
    RAISE NOTICE 'RECOVERY POINT: newest entry is % (% behind now)', v_newest, v_age;
END $$;

\echo ''
\echo 'restore verification: all checks passed'
