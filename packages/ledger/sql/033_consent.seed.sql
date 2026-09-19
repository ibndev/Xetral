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
  -- Republished by 074 when the pages stopped naming `[registered company
  -- name]` as the contracting party. THE SEED IS THE FRESH-DATABASE PATH ONLY:
  -- an existing database cannot be moved by editing a row here, because both
  -- versions would be live and `consent_one_current_per_kind` refuses that.
  -- 074 retires and republishes, and is idempotent so this pair stays correct.
  ('terms', '2026-09-19',
   '866c9d5e52b5511048facae0eb2343709d4ae52d4c52984dbf10ad4a68ea72fb',
   'The terms on which Xetral Ltd holds and moves your money, including who '
   'may open an account, what cannot be undone, and how to complain.'),

  -- Republished by 074. The list of companies that receive personal data was
  -- wrong in BOTH directions — it named Resend, which is not in this codebase,
  -- and omitted Paystack, the default funding rail — so the correction is one
  -- every customer has to be asked about. Retiring a version puts them all on
  -- `consent_outstanding`, which is the mechanism doing its job rather than a
  -- nuisance: a change nobody was asked about is a change nobody agreed to.
  ('privacy', '2026-09-19',
   '6c83b172c42a68b354c16949d1bcfc33f70c01dc22a3d78bd9299664a8c95f78',
   'What personal data Xetral Ltd holds, why, exactly which companies receive '
   'it and what reaches them, how long it is kept, and how to get a copy or '
   'have it erased.'),

  ('marketing_email', '2026-08-25',
   -- Not a page: this is the exact wording of the opt-in, hashed so the
   -- sentence somebody agreed to can be produced later.
   -- sha256("Xetral may email me about new features, offers and products. I can withdraw this at any time.")
   '81a24c4690d8f550ddba333c898614f09e64e553ccea5a785b6c8df57e5f025e',
   'Xetral may email me about new features, offers and products. I can '
   'withdraw this at any time.')
ON CONFLICT (kind, version) DO NOTHING;
