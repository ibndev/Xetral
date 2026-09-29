-- ============================================================================
--  088 — a payout whose reserve moved no money is not money waiting
--
--  PRODUCTION HELD A ₦10 PAYOUT TO GTBank 0123456789 THAT NOBODY MADE.
--  `080_payout_provider_known.test.sql` writes one against the FIRST user on
--  the database — the owner, on a live one — and 046's suite does the same.
--  Both insert a `wallet_withdrawal` entry with NO POSTINGS and a `reserved`
--  payout pointing at it. Run by hand against production, that row sat on
--  /admin/recovery as "Needs review" and no button could clear it:
--
--    - ASKING PAYSTACK failed: `GET /transfer/verify/p80:ref` is refused for
--      "illegal special characters". Real references are
--      `xetral-payout-<hex>` and never meet this; the colon is the fixture's.
--    - SENDING AGAIN was refused — "Cannot resolve account" — and that is
--      the lucky half. Had the fake account resolved, the platform would
--      have paid ₦10 of float to a stranger for a reserve that held nothing.
--    - REFUNDING answered 500. It reverses the reserve, `customer_pending ->
--      customer_wallet`, and the owner's pending account held nothing, so the
--      overdraft guard refused. Had they had a REAL payout in flight, it would
--      have succeeded and handed back ₦10 of somebody's held money a second
--      time.
--
--  SO THE RULE IS STRUCTURAL, NOT A LIST OF TEST NAMES. A payout is money
--  awaiting recovery only if its reserve entry actually moved money. Every
--  real payout has one: `LedgerService.post()` never writes an entry without
--  postings, and the reserve commits BEFORE the payout row can reference it,
--  so "reserve with no postings" can only be a row somebody typed.
--
--  THE ROWS ARE FAILED, NOT DELETED. `bank_payouts` refuses a DELETE (043),
--  `journal_entries` too (011), and both are right to. `reserved -> failed`
--  is a transition 043 permits, and a failure with a reason is the true
--  statement: this payout was never going to happen. Nothing is posted,
--  because nothing was held — a reversal of an empty entry would be a
--  statement about money that does not exist.
-- ============================================================================

BEGIN;

-- The record. Every payout whose reserve entry moved nothing, whatever its
-- status — after the cleanup they are all `failed`, and that is the evidence
-- a test file once ran against this database.
CREATE OR REPLACE VIEW hollow_payouts AS
SELECT p.uuid, p.reference, p.status::text AS status, p.currency,
       p.amount_minor, p.created_at
  FROM bank_payouts p
 WHERE NOT EXISTS (SELECT 1 FROM postings x WHERE x.journal_entry_id = p.reserve_entry_id);

-- Closing one. A function rather than a bare UPDATE so an operator can run it
-- again the next time a suite reaches production, and so the invariant suite
-- can prove what it touches and what it leaves alone.
CREATE OR REPLACE FUNCTION fail_hollow_payouts() RETURNS INTEGER AS $$
DECLARE n INTEGER;
BEGIN
    UPDATE bank_payouts p
       SET status = 'failed',
           failure_reason = 'not a real payout: its reserve entry moved no money, '
                            'so nothing was held and nothing was sent',
           updated_at = now()
     WHERE p.status = 'reserved'
       AND NOT EXISTS (SELECT 1 FROM postings x WHERE x.journal_entry_id = p.reserve_entry_id);
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
END;
$$ LANGUAGE plpgsql;

REVOKE ALL ON FUNCTION fail_hollow_payouts() FROM PUBLIC;

-- The recovery queue, as 049 wrote it, with one condition added to the payout
-- arm. `CREATE OR REPLACE` keeps the columns and their order, so every reader
-- — the console, `admin_work_queue`, the summary — is unchanged.
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
   AND EXISTS (SELECT 1 FROM postings x WHERE x.journal_entry_id = p.reserve_entry_id)
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

INSERT INTO attention_sources (source, decision, rationale) VALUES
  ('hollow_payouts', 'internal',
   'A RECORD of payout rows a test file wrote against this database, closed '
   'by fail_hollow_payouts(). Nothing in it was ever held, so there is '
   'nothing for anybody to work; it exists so the evidence stays readable.')
ON CONFLICT (source) DO NOTHING;

SELECT fail_hollow_payouts();

COMMIT;
