-- ============================================================================
--  025 — One person, one account.
--
--  WHAT WAS MISSING. `kyc_one_open_per_user` says a customer may hold one live
--  submission. Nothing said anything about the same PERSON holding several
--  customers — so two, or twenty, accounts could each pass identity review on
--  the SAME BVN, and every per-customer control in this platform would apply
--  to each of them separately. The daily ceiling, the new-recipient count, the
--  hourly velocity: all of them are per customer, which is only a limit at all
--  if a person cannot cheaply become several customers.
--
--  In Nigeria this is the strongest correlation signal available, because a
--  BVN is one human being by definition. It is also the one we already
--  collect, so this control needs no new data about anybody.
--
--  WHY IT COULD NOT ALREADY BE ENFORCED. `bvn_sealed` is an AES-GCM envelope
--  with a random IV, so sealing one BVN twice gives two different strings —
--  correct for confidentiality and useless for equality. `bvn_last4` is four
--  digits, which collides for one submission in ten thousand and is therefore
--  a rule that would refuse honest customers.
--
--  So: a BLIND INDEX. An HMAC of the BVN under a key held only by the
--  application, deterministic so equal BVNs collide, keyed so that reading
--  this table does not reveal anybody's. See `blind-index.ts` for why an
--  unkeyed hash of an eleven-digit number is the number.
--
--  IT REFUSES AT APPROVAL, NOT AT SUBMISSION, and that is deliberate. A
--  customer submitting is told nothing — a submission form that answered "that
--  BVN is already registered" would confirm, to anybody holding a stolen BVN,
--  that its owner banks here. The reviewer sees the collision in their own
--  queue before they click, and the unique index is what makes the rule true
--  even if they do not look.
-- ============================================================================

BEGIN;

/**
 * `v1:<64 hex>` — the version is the KEY's, not the schema's.
 *
 * A blind index cannot have two live keys the way the envelope keyring can:
 * matching requires one. Rotating it therefore means recomputing every
 * fingerprint, and until that finishes the table holds two populations that
 * cannot see each other. The prefix is what makes that state visible rather
 * than presenting as a uniqueness rule that has silently stopped catching
 * anything — see `kyc_blind_index_versions` below.
 */
ALTER TABLE kyc_submissions ADD COLUMN bvn_fingerprint TEXT;

ALTER TABLE kyc_submissions ADD CONSTRAINT bvn_fingerprint_is_versioned
    CHECK (bvn_fingerprint IS NULL OR bvn_fingerprint ~ '^v[0-9]+:[0-9a-f]{64}$');

/**
 * NOT NULL, and the refusal below is why this is not simply an ALTER.
 *
 * A nullable fingerprint is the silent-off failure this codebase keeps
 * warning about: one submission written without one slips past the unique
 * index, and nothing anywhere fails. So it is NOT NULL — which on a database
 * that already holds submissions means the operator must backfill first,
 * because the BVNs are sealed and only the application holds the keys.
 *
 * `scripts/backfill-bvn-fingerprint.mjs` does that. Refusing here with a
 * sentence naming it costs a deploy; the alternative costs the control.
 */
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM kyc_submissions WHERE bvn_fingerprint IS NULL) THEN
        RAISE EXCEPTION
            'kyc_submissions already holds rows with no bvn_fingerprint. The BVNs '
            'are sealed and only the application holds the keys, so run '
            'scripts/backfill-bvn-fingerprint.mjs before applying this migration.';
    END IF;
END $$;

ALTER TABLE kyc_submissions ALTER COLUMN bvn_fingerprint SET NOT NULL;

/**
 * ONE APPROVED SUBMISSION PER BVN.
 *
 * Partial on `approved` rather than covering every row, and each excluded
 * status is excluded for its own reason:
 *
 *   pending   the submission must be ACCEPTED so a reviewer can see the
 *             collision and decide. Refusing at submission would turn the
 *             form into a way to ask "does this person bank here?".
 *   rejected  history. A customer whose first attempt was rejected for a bad
 *             photograph must be able to submit again, and a unique index
 *             over rejected rows would refuse them for ever.
 */
CREATE UNIQUE INDEX kyc_one_approved_per_bvn
    ON kyc_submissions (bvn_fingerprint) WHERE status = 'approved';

/**
 * What the reviewer sees before they click.
 *
 * A pending submission whose BVN already belongs to an approved account. The
 * unique index makes the rule true regardless; this exists so the refusal is
 * not a surprise at the moment of approval, and so the reviewer can see WHICH
 * account holds it — which is the fact that decides whether this is fraud or a
 * customer who lost access to their first account.
 *
 * Returns no BVN and no fingerprint. A queue listing that carried either would
 * put the identifying value into a browser tab and a screenshot, which is the
 * lesson `005_giftcards.sql` records about card codes.
 */
CREATE VIEW kyc_bvn_collisions AS
SELECT p.uuid            AS submission_id,
       p.user_id         AS pending_user_id,
       p.created_at      AS submitted_at,
       a.user_id         AS approved_user_id,
       a.reviewed_at     AS approved_at
  FROM kyc_submissions p
  JOIN kyc_submissions a
    ON a.bvn_fingerprint = p.bvn_fingerprint
   AND a.status = 'approved'
   AND a.user_id <> p.user_id
 WHERE p.status = 'pending'
 ORDER BY p.created_at;

/**
 * How many key versions are in use.
 *
 * More than one means a rotation is half-finished, and while it is, the
 * unique index above cannot see across the boundary — two accounts on one BVN
 * would both be approvable. That is a real gap, so it is reported rather than
 * left to be noticed; the invariant suite asserts the count is one.
 */
CREATE VIEW kyc_blind_index_versions AS
SELECT split_part(bvn_fingerprint, ':', 1) AS version,
       count(*)                            AS submissions
  FROM kyc_submissions
 GROUP BY 1
 ORDER BY 1;

COMMIT;
