-- ===========================================================================
--  Xetral — transaction monitoring invariants
--  packages/ledger/sql/027_risk_signals.test.sql
-- ===========================================================================

\set QUIET on
\pset format unaligned
\pset tuples_only on

INSERT INTO users (email, status) VALUES
  ('p27-big@example.ng',     'active'),
  ('p27-struct@example.ng',  'active'),
  ('p27-mule@example.ng',    'active'),
  ('p27-quiet@example.ng',   'active'),
  ('p27-chain@example.ng',   'active'),
  ('p27-normal@example.ng',  'active'),
  ('p27-staff@example.ng',   'active');

-- A wallet per customer, plus the float every entry balances against.
DO $$
DECLARE v_u BIGINT; v_email TEXT; v_float BIGINT;
BEGIN
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;
    IF v_float IS NULL THEN
        INSERT INTO accounts (kind, currency, normal_balance)
        VALUES ('provider_float', 'NGN', 'debit');
    END IF;

    FOREACH v_email IN ARRAY ARRAY['p27-big@example.ng', 'p27-struct@example.ng',
                                   'p27-mule@example.ng', 'p27-quiet@example.ng',
                                   'p27-chain@example.ng', 'p27-normal@example.ng']
    LOOP
        SELECT id INTO v_u FROM users WHERE email = v_email;
        INSERT INTO accounts (kind, owner_type, owner_id, currency, normal_balance)
        VALUES ('customer_wallet', 'user', v_u, 'NGN', 'credit');
    END LOOP;
END $$;

/**
 * Posts a balanced entry moving `p_kobo` into (positive) or out of (negative)
 * a customer's naira wallet, at a stated moment.
 *
 * A helper rather than repeated blocks, because the rules read POSTINGS and
 * every test below has to write real ones — a fixture that inserted into
 * `risk_signals` directly would be testing this file's own INSERT rather than
 * its arithmetic.
 */
/**
 * A moment inside the CURRENT Lagos day, `n` seconds after it began.
 *
 * The day-scoped rules below — structuring and pass-through — compare against
 * `lagos_day_start()`, so a fixture written as "two hours ago" falls into
 * YESTERDAY between midnight and 02:00 Lagos and the rule correctly sees
 * nothing. That made these blocks pass twenty-two hours a day, which is the
 * worst kind of green: this file was written in the afternoon and first failed
 * at 00:43.
 *
 * Anchored to the start of the day instead, which is always in the past and
 * always inside it.
 */
CREATE OR REPLACE FUNCTION p27_today(p_seconds INT) RETURNS TIMESTAMPTZ AS $$
    SELECT lagos_day_start() + make_interval(secs => p_seconds);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION p27_move(
    p_email TEXT, p_kobo BIGINT, p_kind entry_kind, p_at TIMESTAMPTZ, p_tag TEXT
) RETURNS VOID AS $$
DECLARE v_u BIGINT; v_w BIGINT; v_float BIGINT; v_entry BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = p_email;
    SELECT id INTO v_w FROM accounts
     WHERE kind = 'customer_wallet' AND owner_id = v_u AND currency = 'NGN';
    SELECT id INTO v_float FROM accounts
     WHERE kind = 'provider_float' AND currency = 'NGN' AND owner_id IS NULL;

    INSERT INTO journal_entries (idempotency_key, kind, occurred_at, description)
    VALUES ('p27:' || p_tag, p_kind, p_at, 'monitoring fixture')
    RETURNING id INTO v_entry;

    INSERT INTO postings (journal_entry_id, account_id, amount_minor, currency)
    VALUES (v_entry, v_w, p_kobo, 'NGN'), (v_entry, v_float, -p_kobo, 'NGN');
END;
$$ LANGUAGE plpgsql;

\echo '=== 1. EVERY CURRENCY THE LEDGER HOLDS IS MONITORED ==='
-- The coverage claim, and the reason it is a view rather than a comment. A
-- monitoring programme is a list of what somebody thought of; the currency
-- nobody thought of is where money goes once somebody notices the gap.
DO $$
DECLARE v_gap TEXT;
BEGIN
    SELECT string_agg(currency, ', ') INTO v_gap
      FROM risk_currency_coverage WHERE NOT monitored;
    IF v_gap IS NOT NULL THEN
        RAISE EXCEPTION
            'TEST FAILED: the ledger holds accounts in % with no risk_thresholds row, '
            'so movements in those currencies are not monitored at all', v_gap;
    END IF;
    RAISE NOTICE 'PASS: every currency in the ledger has a threshold';
END $$;

\echo '=== 2. ONE LARGE MOVEMENT is flagged, and an ordinary one is not ==='
DO $$
DECLARE v_u BIGINT; v_n INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-big@example.ng';

    -- ₦60,000 — ordinary.
    PERFORM p27_move('p27-big@example.ng', 6000000, 'wallet_funding', now(), 'big-small');
    -- ₦6,000,000 — above the ₦5,000,000 threshold.
    PERFORM p27_move('p27-big@example.ng', 600000000, 'wallet_funding', now(), 'big-large');

    PERFORM detect_risk_signals();

    SELECT count(*) INTO v_n FROM risk_signals
     WHERE user_id = v_u AND rule = 'large_value';
    IF v_n <> 1 THEN
        RAISE EXCEPTION 'TEST FAILED: expected exactly one large_value signal, got %', v_n;
    END IF;
    RAISE NOTICE 'PASS: the large movement is flagged and the ordinary one is not';
END $$;

\echo '=== 3. THE SWEEP IS IDEMPOTENT ==='
-- It runs on a schedule and may run from several instances. A second pass must
-- produce the same rows, which is what makes the advisory lock in the worker an
-- optimisation rather than a correctness requirement — the same division the
-- purchase reconciler makes.
DO $$
DECLARE v_u BIGINT; v_before INT; v_after INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-big@example.ng';
    SELECT count(*) INTO v_before FROM risk_signals WHERE user_id = v_u;
    PERFORM detect_risk_signals();
    PERFORM detect_risk_signals();
    SELECT count(*) INTO v_after FROM risk_signals WHERE user_id = v_u;

    IF v_after <> v_before THEN
        RAISE EXCEPTION 'TEST FAILED: re-running the sweep raised % extra signal(s)',
            v_after - v_before;
    END IF;
    RAISE NOTICE 'PASS: running the sweep again changes nothing';
END $$;

\echo '=== 4. STRUCTURING: several just under, together above ==='
-- What the large-value rule cannot see by construction, because every piece is
-- deliberately unremarkable.
DO $$
DECLARE v_u BIGINT; v_row RECORD; i INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-struct@example.ng';

    -- Four movements of ₦1,800,000: each well under ₦5,000,000, together
    -- ₦7,200,000.
    FOR i IN 1..4 LOOP
        PERFORM p27_move('p27-struct@example.ng', 180000000, 'wallet_funding',
                         p27_today(i * 10), 'struct-' || i);
    END LOOP;

    PERFORM detect_risk_signals();

    SELECT * INTO v_row FROM risk_signals
     WHERE user_id = v_u AND rule = 'structuring';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: four movements under the threshold summing above it '
                        'raised no structuring signal';
    END IF;
    IF (v_row.detail->>'movements')::INT <> 4 THEN
        RAISE EXCEPTION 'TEST FAILED: the signal counted % movements',
            v_row.detail->>'movements';
    END IF;
    IF v_row.detail->>'direction' <> 'in' THEN
        RAISE EXCEPTION 'TEST FAILED: the signal says direction %', v_row.detail->>'direction';
    END IF;
    -- No large_value signal, because no single piece reached the threshold.
    IF EXISTS (SELECT 1 FROM risk_signals WHERE user_id = v_u AND rule = 'large_value') THEN
        RAISE EXCEPTION 'TEST FAILED: a structured deposit also raised large_value';
    END IF;
    RAISE NOTICE 'PASS: structuring is seen by counting, not by size';
END $$;

\echo '=== 5. STRUCTURING does NOT fire on ordinary busy days ==='
-- The rule that decides whether anybody reads this queue. Several small
-- movements are how a normal customer uses a wallet; the pattern is small
-- movements that TOGETHER cross the reporting threshold.
DO $$
DECLARE v_u BIGINT; i INT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-normal@example.ng';

    -- Six movements of ₦20,000. Together ₦120,000 — nowhere near ₦5,000,000.
    FOR i IN 1..6 LOOP
        PERFORM p27_move('p27-normal@example.ng', 2000000, 'wallet_funding',
                         p27_today(i * 10), 'normal-' || i);
    END LOOP;

    PERFORM detect_risk_signals();

    IF EXISTS (SELECT 1 FROM risk_signals WHERE user_id = v_u AND rule = 'structuring') THEN
        RAISE EXCEPTION 'TEST FAILED: six ordinary deposits were reported as structuring';
    END IF;
    RAISE NOTICE 'PASS: a busy day is not a pattern';
END $$;

\echo '=== 6. PASS-THROUGH: in and straight back out ==='
DO $$
DECLARE v_u BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-mule@example.ng';

    -- ₦2,000,000 in, ₦1,900,000 straight out: 95%.
    PERFORM p27_move('p27-mule@example.ng',  200000000, 'wallet_funding',
                     p27_today(10), 'mule-in');
    PERFORM p27_move('p27-mule@example.ng', -190000000, 'wallet_transfer',
                     p27_today(20), 'mule-out');

    PERFORM detect_risk_signals();

    SELECT * INTO v_row FROM risk_signals
     WHERE user_id = v_u AND rule = 'rapid_passthrough';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: 95%% of the day''s credits leaving raised nothing';
    END IF;
    IF (v_row.detail->>'percent_out')::INT < 80 THEN
        RAISE EXCEPTION 'TEST FAILED: the signal computed %%% out',
            v_row.detail->>'percent_out';
    END IF;
    RAISE NOTICE 'PASS: money in and straight back out is reported';
END $$;

\echo '=== 7. PASS-THROUGH stays quiet below the floor ==='
-- Without the floor, an account moving small change in and out fires this
-- every single day — and a rule people learn to ignore is worse than no rule,
-- which is the lesson 015 records about alerting.
DO $$
DECLARE v_u BIGINT;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-quiet@example.ng';

    -- ₦2,000 in and ₦2,000 out: 100% out, and far below the ₦100,000 floor.
    PERFORM p27_move('p27-quiet@example.ng',  200000, 'wallet_funding',
                     p27_today(10), 'tiny-in');
    PERFORM p27_move('p27-quiet@example.ng', -200000, 'wallet_transfer',
                     p27_today(20), 'tiny-out');

    PERFORM detect_risk_signals();

    IF EXISTS (SELECT 1 FROM risk_signals
                WHERE user_id = v_u AND rule = 'rapid_passthrough') THEN
        RAISE EXCEPTION 'TEST FAILED: ₦2,000 in and out was reported as pass-through';
    END IF;
    RAISE NOTICE 'PASS: the floor keeps small change out of the queue';
END $$;

\echo '=== 8. A LONG SILENCE then movement is reported ==='
DO $$
DECLARE v_u BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-chain@example.ng';

    -- One movement a year ago, then one today.
    PERFORM p27_move('p27-chain@example.ng', 50000000, 'wallet_funding',
                     now() - interval '400 days', 'dormant-old');
    PERFORM p27_move('p27-chain@example.ng', 50000000, 'wallet_funding',
                     now() - interval '30 minutes', 'dormant-new');

    PERFORM detect_risk_signals();

    SELECT * INTO v_row FROM risk_signals
     WHERE user_id = v_u AND rule = 'dormant_reactivation';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: an account silent for 400 days waking up raised nothing';
    END IF;
    IF (v_row.detail->>'quiet_days')::INT < 180 THEN
        RAISE EXCEPTION 'TEST FAILED: the signal reports % quiet days',
            v_row.detail->>'quiet_days';
    END IF;
    RAISE NOTICE 'PASS: a reactivated account is reported once';
END $$;

\echo '=== 9. A CHAIN WITHDRAWAL soon after money arrived is reported ==='
-- Its own rule rather than a case of pass-through, because a chain
-- transaction cannot be recalled: the only window in which anybody can act is
-- the one before it is broadcast.
DO $$
DECLARE v_u BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-mule@example.ng';

    -- Funded first: the overdraft guard is real and this wallet has ₦100,000
    -- left after block 6. A fixture that ignored it would be asserting on a
    -- posting the ledger refuses to write.
    PERFORM p27_move('p27-mule@example.ng',  60000000, 'wallet_funding',
                     now() - interval '40 minutes', 'chain-fund');
    PERFORM p27_move('p27-mule@example.ng', -50000000, 'crypto_withdrawal',
                     now() - interval '20 minutes', 'chain-out');

    PERFORM detect_risk_signals();

    SELECT * INTO v_row FROM risk_signals
     WHERE user_id = v_u AND rule = 'crypto_fast_out';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: a chain withdrawal hours after a credit raised nothing';
    END IF;
    RAISE NOTICE 'PASS: money leaving onto a chain soon after arriving is reported';
END $$;

\echo '=== 10. A signal is IMMUTABLE except for its resolution ==='
-- What a rule saw is evidence. If it could be edited, this table would say
-- what the last person with access wanted it to say — the same reason the
-- audit log and the sign-in events are append-only.
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM risk_signals WHERE rule = 'large_value' LIMIT 1;
    UPDATE risk_signals SET detail = '{"amount_minor": "1"}'::jsonb WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: the evidence on a signal was rewritten';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: what a rule saw cannot be edited';
END $$;

\echo '=== 11. A signal cannot be DELETED ==='
DO $$
DECLARE v_id BIGINT;
BEGIN
    SELECT id INTO v_id FROM risk_signals WHERE rule = 'large_value' LIMIT 1;
    DELETE FROM risk_signals WHERE id = v_id;
    RAISE EXCEPTION 'TEST FAILED: a risk signal was deleted';
EXCEPTION WHEN restrict_violation THEN
    RAISE NOTICE 'PASS: a signal cannot be deleted, however old';
END $$;

\echo '=== 12. RESOLVING one is FINAL, and needs a person and a reason ==='
DO $$
DECLARE v_id BIGINT; v_staff BIGINT;
BEGIN
    SELECT id INTO v_id FROM risk_signals WHERE rule = 'large_value' LIMIT 1;
    SELECT id INTO v_staff FROM users WHERE email = 'p27-staff@example.ng';

    -- A resolution with nobody behind it is a queue that was cleared rather
    -- than worked.
    BEGIN
        UPDATE risk_signals SET resolved_at = now() WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: a signal was closed with no reviewer and no reason';
    EXCEPTION WHEN check_violation THEN
        NULL;
    END;

    UPDATE risk_signals
       SET resolved_at = now(), resolved_by = v_staff,
           resolution = 'known salary payment, confirmed with the customer'
     WHERE id = v_id;

    BEGIN
        UPDATE risk_signals
           SET resolved_at = NULL, resolved_by = NULL, resolution = NULL
         WHERE id = v_id;
        RAISE EXCEPTION 'TEST FAILED: a resolved signal was reopened';
    EXCEPTION WHEN restrict_violation THEN
        NULL;
    END;

    RAISE NOTICE 'PASS: a resolution names somebody, says why, and is final';
END $$;

\echo '=== 13. The queue shows a customer HAS OTHER OPEN SIGNALS ==='
-- One signal is a transaction; several is a pattern, and a reviewer should
-- know which they are looking at before they open the first one.
DO $$
DECLARE v_u BIGINT; v_row RECORD;
BEGIN
    SELECT id INTO v_u FROM users WHERE email = 'p27-mule@example.ng';
    SELECT * INTO v_row FROM risk_signals_open WHERE user_id = v_u LIMIT 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEST FAILED: the mule account has no open signal in the queue';
    END IF;
    IF v_row.other_open_signals < 1 THEN
        RAISE EXCEPTION 'TEST FAILED: a customer with several signals shows % others',
            v_row.other_open_signals;
    END IF;
    RAISE NOTICE 'PASS: the queue says when a customer has more than one signal';
END $$;

\echo '=== 14. Turning MONITORING OFF stops it, without failing ==='
-- Off is a deliberate act an operator may take during an incident. It must not
-- also hand them a failing worker to investigate — but it must be visible, and
-- the setting is what makes it so.
DO $$
DECLARE v_raised BIGINT;
BEGIN
    UPDATE platform_settings SET value = 'false' WHERE key = 'risk_monitoring_enabled';

    SELECT count(*) INTO v_raised FROM detect_risk_signals();
    IF v_raised <> 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the sweep ran % rule(s) with monitoring off', v_raised;
    END IF;

    UPDATE platform_settings SET value = 'true' WHERE key = 'risk_monitoring_enabled';
    SELECT count(*) INTO v_raised FROM detect_risk_signals();
    IF v_raised = 0 THEN
        RAISE EXCEPTION 'TEST FAILED: the sweep ran no rules with monitoring on';
    END IF;

    RAISE NOTICE 'PASS: the switch stops the sweep and turning it back on restarts it';
END $$;

\echo '=== 15. The rules read POSTINGS, not an entry''s metadata ==='
-- Structural. A control that depends on a key some flow remembered to set is a
-- control that switches itself off the first time a new flow forgets — and
-- nothing fails when monitoring quietly stops working.
DO $$
DECLARE v_body TEXT;
BEGIN
    SELECT prosrc INTO v_body FROM pg_proc WHERE proname = 'detect_risk_signals';
    IF v_body IS NULL THEN
        RAISE EXCEPTION 'TEST FAILED: detect_risk_signals() does not exist';
    END IF;
    IF v_body ~* 'metadata' THEN
        RAISE EXCEPTION 'TEST FAILED: a rule reads an entry''s metadata';
    END IF;
    IF v_body !~ 'customer_wallet_movements' THEN
        RAISE EXCEPTION 'TEST FAILED: the rules do not read postings';
    END IF;
    RAISE NOTICE 'PASS: every rule reads postings and none reads metadata';
END $$;
