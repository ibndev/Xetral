-- ============================================================================
--  074 — republishing the terms and the privacy notice
--
--  WHY THIS IS A MIGRATION AND NOT AN EDIT TO THE SEED. `033_consent.seed.sql`
--  is the state a FRESH database starts in, and editing a row there changes
--  nothing on a database that already holds customers. Worse, it cannot: the
--  live version and the new one are both rows with `retired_at IS NULL`, and
--  `consent_one_current_per_kind` is a partial unique index on exactly that.
--  Re-running an edited seed against a live database raises rather than
--  updating — and `ON CONFLICT (kind, version) DO NOTHING` does not catch it,
--  because the collision is on the index, not on the key.
--
--  So: retire, then publish. 033's own rule, applied to itself.
--
--  WHAT CHANGED, and why every customer is asked again. The pages carried six
--  bracketed placeholders — `[registered company name]`, `[registered
--  address]`, `[dpo@ address]`, `[NDPC registration reference]` — so the
--  document customers were agreeing to named a bracket as the contracting
--  party. They now name Xetral Ltd, its registered address and a contact
--  address that is read.
--
--  And the privacy notice's list of who receives personal data was wrong in
--  BOTH directions, which is worse than a vague one:
--
--    * It named Resend, which is not in this codebase. Brevo has been the
--      notification adapter since 048.
--    * It named Airalo and Twilio, which receive a product code and an opaque
--      reference of ours and nothing that identifies anybody.
--    * It OMITTED Paystack — the default funding rail since 044, and therefore
--      the company almost every Nigerian customer's name, email address and
--      phone number actually reaches. The recipient most customers had was the
--      one the notice did not mention.
--    * It omitted Flutterwave and Expo.
--
--  A notice that names a processor you do not use is a false statement to a
--  customer; one that omits a processor you do use is also a false declaration
--  to an app store. Both are corrections a customer has to be asked about,
--  which is what retiring the version does: `consent_outstanding` fills the
--  moment this applies, and that is the mechanism working rather than a
--  nuisance.
--
--  IDEMPOTENT, AND `WHERE version <` IS WHAT MAKES IT SO. On an existing
--  database the old row is retired and the new one published; applying it
--  twice does nothing the second time. On a fresh database the seed has
--  already published the CURRENT document — which since 075 is NEWER than
--  this one — so both halves here must decline to act rather than drag it
--  backwards. See the comment on the statements: as first written this file
--  would have left a fresh deployment with no live privacy notice at all.
-- ============================================================================

-- Retire whatever is live and OLDER than what we are about to publish.
--
-- Scoped by kind, so `marketing_email` — unchanged, and the sentence somebody
-- actually ticked — is left exactly where it is.
--
-- `version <` RATHER THAN `version <>`, AND THAT IS A CORRECTION. As `<>` this
-- migration retired anything that was not its own version, INCLUDING SOMETHING
-- NEWER — and the newer thing is exactly what a fresh database has, because
-- `033_consent.seed.sql` publishes the CURRENT document and every republish
-- since is then a no-op. 075 moved the privacy notice to 2026-09-20, so on a
-- fresh database this file would have retired it, published 2026-09-19 over
-- the top, and left 075 unable to put it back: retirement is FINAL by trigger,
-- so the `ON CONFLICT DO NOTHING` below would have found the 2026-09-20 row
-- retired and left it that way. A privacy notice with no live version at all,
-- on every new deployment, from a chain where each file is individually right.
--
-- ON EVERY DATABASE THIS FILE WAS WRITTEN FOR, THE TWO SPELLINGS ARE THE SAME
-- STATEMENT: what was live was 2026-08-25 and 2026-08-28, and both are older.
-- The change only removes an action that was never wanted.
UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'terms'
   AND retired_at IS NULL
   AND version < '2026-09-19';

UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-09-19';

-- The hashes are of the PAGES THEMSELVES, and `consent-documents.test.ts`
-- recomputes them from `apps/web/src/app/legal/*/page.tsx` on every build. A
-- version whose hash has drifted from its words is worse than no version,
-- because it looks like evidence.
--
-- AND THE INSERT IS GUARDED THE SAME WAY THE RETIRE IS. Publishing an older
-- version beside a live newer one is refused by `consent_one_current_per_kind`
-- — so without the guard this is not a silent wrong answer but a failed
-- deployment, which is better and is still not the right one. `NOT EXISTS`
-- makes running an earlier republish after a later one a no-op, which is the
-- only sensible meaning it can have.
INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'terms', '2026-09-19',
       '866c9d5e52b5511048facae0eb2343709d4ae52d4c52984dbf10ad4a68ea72fb',
       'The terms on which Xetral Ltd holds and moves your money, including who '
       'may open an account, what cannot be undone, and how to complain.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'terms' AND retired_at IS NULL AND version > '2026-09-19')
ON CONFLICT (kind, version) DO NOTHING;

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-19',
       '6c83b172c42a68b354c16949d1bcfc33f70c01dc22a3d78bd9299664a8c95f78',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them, how long it is kept, and how to get a copy or '
       'have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-19')
ON CONFLICT (kind, version) DO NOTHING;
