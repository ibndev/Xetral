-- ============================================================================
--  033 seed — the documents currently published.
--
--  The hashes are of the PAGES THEMSELVES, and `consent-documents.test.ts`
--  recomputes them: editing the terms without publishing a new version fails
--  the build. A version number that drifts from the words it names is worse
--  than none, because it looks like evidence.
--
--  A marketing document exists with nothing enqueued against it yet, and that
--  is deliberate rather than an oversight: the opt-in has to exist before
--  there is anything to opt into, or the first campaign is sent to people who
--  were never asked.
-- ============================================================================

INSERT INTO consent_documents (kind, version, body_sha256, summary) VALUES
  ('terms', '2026-08-25',
   '56e2b8389f74f0a0d5e53ef06fe403553d8d7628e13fb8c1a6af7573605030f3',
   'The terms on which Xetral holds and moves your money, including what '
   'happens when something goes wrong and how to complain.'),

  ('privacy', '2026-08-25',
   '75eeb427edf1b3fd6750ea77ff6eb5662caf2418a60fdc38dad0c3a42dc165e8',
   'What personal data we hold, why, how long we keep it, and the rights you '
   'have over it under the NDPA.'),

  ('marketing_email', '2026-08-25',
   -- Not a page: this is the exact wording of the opt-in, hashed so the
   -- sentence somebody agreed to can be produced later.
   -- sha256("Xetral may email me about new features, offers and products. I can withdraw this at any time.")
   '81a24c4690d8f550ddba333c898614f09e64e553ccea5a785b6c8df57e5f025e',
   'Xetral may email me about new features, offers and products. I can '
   'withdraw this at any time.')
ON CONFLICT (kind, version) DO NOTHING;
