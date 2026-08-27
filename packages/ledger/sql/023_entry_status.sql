-- ============================================================================
--  023 — What later happened to an entry.
--
--  WHAT WAS MISSING. The audit's line was "no disputed state anywhere, and
--  refunded is not distinct from reversed". Both halves come from the same
--  root: `reverses_id` was bound to reversals by a BICONDITIONAL —
--
--      CHECK ((kind = 'reversal') = (reverses_id IS NOT NULL))
--
--  — so a refund COULD NOT NAME WHAT IT REFUNDS. `dispute_refund` and
--  `card_refund` have existed as kinds since Phase 1 and have always been
--  floating entries: money appearing in a wallet with nothing in the ledger
--  tying it to the charge it answers. Nothing could derive "this entry was
--  refunded", so nothing could show it, and a customer reading their history
--  saw a debit and an unexplained credit rather than a charge and its refund.
--
--  A REVERSAL AND A REFUND ARE DIFFERENT CLAIMS ABOUT THE WORLD, which is why
--  collapsing them was wrong rather than untidy:
--
--    reversal   it did not happen. A purchase the provider refused, a card
--               authorisation that expired. The original was a statement about
--               money that turned out not to have moved.
--    refund     it DID happen, correctly, and the money is going back. A
--               dispute upheld, a merchant refund.
--
--  Both are appended and neither edits the original — that rule is untouched.
--  The difference is what the pair MEANS, and a customer is owed the true one.
--
--  THE STATUS IS DERIVED, NEVER STORED. A `status` column on `journal_entries`
--  would be a second copy of facts the ledger already holds, and the copy
--  drifts the first time a flow forgets to update it — the same reason
--  balances are computed from postings and the velocity rules read postings
--  rather than an entry's metadata. `entry_status` is a view over what
--  actually exists, so it cannot disagree with the books.
-- ============================================================================

BEGIN;

/**
 * `reverses_id` becomes "the entry this one acts upon".
 *
 * The column keeps its name deliberately. Renaming it would touch every caller
 * and every intent for no gain, and a column name is part of the ledger's
 * public surface — a rename is the kind of change that looks free and is not.
 * What changes is the CHECK, and it is written per kind rather than as one
 * widened biconditional, because the three kinds do not have the same
 * obligation:
 *
 *   reversal        MUST name its target. "That entry did not happen" is a
 *                   statement ABOUT a specific entry; without one it is not a
 *                   reversal, it is money appearing from nowhere.
 *   dispute_refund  MUST name it. We are refunding a charge we can point at —
 *                   `disputes.entry_id` is where the claim was raised, so the
 *                   information is always in hand and an unattached one would
 *                   be a floating credit for no stated reason.
 *   card_refund     MAY name it. This one comes from a MERCHANT, days or weeks
 *                   after the settlement, and whether Bitnob's payload
 *                   identifies the original transaction is not something we
 *                   control or have confirmed — the card event surface is the
 *                   one part of that integration still unsettled. Requiring
 *                   the link would mean a real refund the customer is owed is
 *                   REFUSED because the provider did not tell us what it was
 *                   for. An unlinked refund is worse reporting; a rejected one
 *                   is missing money.
 *   everything else MUST NOT name one.
 */
ALTER TABLE journal_entries DROP CONSTRAINT reversal_has_target;

ALTER TABLE journal_entries ADD CONSTRAINT entry_target_is_consistent CHECK (
    CASE kind
      WHEN 'reversal'       THEN reverses_id IS NOT NULL
      WHEN 'dispute_refund' THEN reverses_id IS NOT NULL
      WHEN 'card_refund'    THEN TRUE
      ELSE reverses_id IS NULL
    END
);

-- The view below asks "what points at this entry?" for every row it returns,
-- which without this is a sequential scan per entry. Partial, because the vast
-- majority of entries answer nothing.
CREATE INDEX IF NOT EXISTS journal_entries_target
    ON journal_entries (reverses_id) WHERE reverses_id IS NOT NULL;

/**
 * What later happened to each entry, computed from what exists.
 *
 * ORDER MATTERS IN THE CASE. An entry can be both disputed and refunded — a
 * dispute upheld is exactly that — and the refund is the more useful thing to
 * tell somebody, because it is the one that changed their balance. `disputed`
 * is therefore reserved for a claim still OPEN, which is the state where
 * nothing has been decided and the customer is waiting on us.
 */
CREATE VIEW entry_status AS
SELECT e.id,
       e.uuid,
       e.kind::text AS kind,
       CASE
         WHEN EXISTS (
           SELECT 1 FROM journal_entries r
            WHERE r.reverses_id = e.id AND r.kind = 'reversal'
         ) THEN 'reversed'
         WHEN EXISTS (
           SELECT 1 FROM journal_entries r
            WHERE r.reverses_id = e.id
              AND r.kind IN ('dispute_refund', 'card_refund')
         ) THEN 'refunded'
         WHEN EXISTS (
           SELECT 1 FROM disputes d WHERE d.entry_id = e.id AND d.status = 'open'
         ) THEN 'disputed'
         ELSE 'settled'
       END AS status,
       -- The entry that answered this one, so a client can show the pair as a
       -- charge and its answer rather than two unrelated lines.
       (SELECT r.uuid FROM journal_entries r
         WHERE r.reverses_id = e.id
           AND r.kind IN ('reversal', 'dispute_refund', 'card_refund')
         ORDER BY r.id LIMIT 1) AS answered_by
  FROM journal_entries e;

COMMENT ON VIEW entry_status IS
  'Derived, never stored: what later happened to an entry. A stored status '
  'column would be a second copy of the ledger that drifts the first time a '
  'flow forgets to update it.';

COMMIT;
