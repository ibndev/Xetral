-- ============================================================================
--  075 — republishing the privacy notice, for a recipient the code cannot show
--
--  THE NOTICE DENIED SOMETHING THAT WAS TRUE. It said, in bold:
--
--      "Your date of birth, your address and your Bank Verification Number
--       are not sent to any of them. ... No provider is given them."
--
--  That sentence was DERIVED CORRECTLY and it was wrong. `kyc.service.ts`
--  mints `provider_customers.provider_customer_id` as `xetral-<uuid>` and
--  makes no provider call at all; Paystack's `/customer/:code/identification`,
--  the endpoint a BVN would go to, is declared in the endpoint table and
--  called from nowhere. Every read of the send path says the same thing, and
--  `legal-content.test.ts` checked the processor list against the adapters on
--  disk in both directions and was green throughout.
--
--  AND IDENTITY VERIFICATION IS DONE WITH DOJAH INC. There is no Dojah
--  adapter: `026_provider_credentials.seed.sql` holds three slots, every one
--  `in_use = FALSE`, and nothing in the tree calls them. So the checking
--  happens the only way it can — a reviewer reading the submitted details and
--  putting them to Dojah's own dashboard — and a name, a date of birth and a
--  BVN leave this company by a route that has no line of code in it.
--
--  A NOTICE DERIVED FROM THE SEND PATH IS EXACTLY AS COMPLETE AS THE SEND
--  PATH. What a person does by hand is outside it, and no guard reading this
--  repository could ever have found it. That is the general lesson and it is
--  why `lib/processors.ts` now carries `via: 'operator'` with the reason
--  attached, rather than a nullable adapter that would read as an omission
--  somebody forgot to fill in — and why the guard holds such an entry to the
--  OPPOSITE requirement: the day `packages/providers/src/dojah` exists, the
--  build goes red and the notice has to be rewritten from the request body.
--
--  An absolute denial is the one shape that cannot survive being wrong once,
--  so `legal-content.test.ts` now fails the build on one returning. The page
--  says what IS sent and to whom.
--
--  THE TERMS ARE NOT REPUBLISHED, DELIBERATELY. They did not change, and
--  retiring a version puts every customer on `consent_outstanding` — asking
--  somebody to agree again to the same words is how that queue stops meaning
--  anything.
--
--  SAME SHAPE AS 074, AND FOR THE SAME REASONS: retire then publish, in one
--  statement each, scoped by kind, and idempotent through `WHERE version <>`.
--  On a fresh database the seed has already published this version, so there
--  is nothing to retire and the insert conflicts to nothing.
-- ============================================================================

-- RETIRE ONLY WHAT IS OLDER, AND PUBLISH ONLY IF NOTHING NEWER IS LIVE.
--
-- Both guards are 074's, which did not have them until this file was written
-- and needed them: as `version <>` it retired anything that was not its own
-- version, so on a fresh database — where the seed publishes the CURRENT
-- document, which is this one — 074 would have retired 2026-09-20, published
-- 2026-09-19 over it, and left this file unable to put it back, because
-- retirement is final by trigger and `ON CONFLICT DO NOTHING` would find the
-- row already there and retired. Every deployment would have started with no
-- live privacy notice, out of a chain in which each file is separately right.
--
-- So a republish says "move it forward to here if it is behind", never "make
-- it exactly this".
UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-09-20';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-20',
       -- sha256 of apps/web/src/app/legal/privacy/page.tsx, which
       -- `consent-documents.test.ts` recomputes on every build. Editing the
       -- page without publishing a version is a red build with one obvious
       -- fix, and the fix also asks every customer again.
       'eb6c32bfbc357c5a8dd85bc3bbe04d3c9f23da7d7bdaf0be6ad3202a3baf6ece',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Dojah Inc., which checks identity '
       'details and which our own code does not call — how long it is kept, and '
       'how to get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-20')
ON CONFLICT (kind, version) DO NOTHING;
