-- ============================================================================
--  077 — republishing the privacy notice, because a BVN now leaves through code
--
--  THE NOTICE SAID, IN BOLD, THAT ONLY DOJAH IS GIVEN A BVN. 076 routes naira
--  account numbers to Flutterwave, and Flutterwave will not open a permanent
--  account in production without the customer's BVN — so from the first
--  account it opened, that sentence would have been false in the direction a
--  regulator reads first. The notice now names both recipients and why.
--
--  THE HASH IS WIDER THAN IT WAS, and that is a fix rather than a change of
--  convention. The notice renders its recipients from `lib/processors.ts`,
--  and the recorded hash covered `page.tsx` alone — so that list could be
--  rewritten under an unchanged version with every test green. This version's
--  hash is sha256 over the page, `processors.ts`, `company.ts` and
--  `retention-table.ts` in that order, which `consent-documents.test.ts`
--  recomputes on every build.
--
--  THE TERMS ARE NOT REPUBLISHED. They did not change, and retiring a version
--  asks every customer to agree again to the same words.
--
--  075'S GUARDS, FOR 075'S REASON: retire only what is OLDER and publish only
--  if nothing NEWER is live, so a fresh database — whose seed publishes this
--  version already — is left exactly as the seed made it.
-- ============================================================================

UPDATE consent_documents
   SET retired_at = now()
 WHERE kind = 'privacy'
   AND retired_at IS NULL
   AND version < '2026-09-23';

INSERT INTO consent_documents (kind, version, body_sha256, summary)
SELECT 'privacy', '2026-09-23',
       'a8891157983f45a907bc29e6787aefc836f934df1d2ba0dbc688db60979f6a56',
       'What personal data Xetral Ltd holds, why, exactly which companies receive '
       'it and what reaches them — including Flutterwave, which is given your '
       'BVN to open your naira account number — how long it is kept, and how to '
       'get a copy or have it erased.'
 WHERE NOT EXISTS (
       SELECT 1 FROM consent_documents
        WHERE kind = 'privacy' AND retired_at IS NULL AND version > '2026-09-23')
ON CONFLICT (kind, version) DO NOTHING;
