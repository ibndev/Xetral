/**
 * Who Xetral is, in one place.
 *
 * WHY THIS IS A MODULE AND NOT TWO STRINGS TYPED TWICE. The privacy notice
 * and the terms each name the company, and the notice names the contact
 * address twice more. Those were SIX bracketed placeholders — `[registered
 * company name]`, `[registered address]`, `[dpo@ address]` — published on the
 * page a regulator and an app-store reviewer read first, which is a
 * commitment already being broken in writing. Typing the real values into
 * six places is how five of them stay right and the sixth goes stale the day
 * the office moves.
 *
 * `legal-content.test.ts` fails the build on a `[bracketed]` value anywhere
 * under `app/legal`, so the placeholder shape cannot come back.
 *
 * WHAT IS DELIBERATELY ABSENT IS THE NDPC REGISTRATION REFERENCE. The notice
 * used to claim one. Registration with the Nigeria Data Protection Commission
 * is a real obligation for a controller of major importance, and a claim to
 * hold a registration is a claim a regulator can check in an afternoon — so
 * the honest page states the rights and the contact and says nothing about a
 * reference until there is one to state. Saying nothing is not a breach;
 * saying something untrue is.
 */
export const COMPANY = {
  /** As registered. Used wherever the contracting entity must be named. */
  legalName: 'Xetral Ltd',
  /** What a customer calls us, which is not the same string. */
  tradingName: 'Xetral',
  addressLine: '26 Admiralty Way, Lekki Phase 1',
  city: 'Lagos',
  country: 'Nigeria',
  /**
   * ONE ADDRESS, and that is a decision rather than a shortcut. A separate
   * `dpo@` that forwards to the same inbox is theatre; one that forwards
   * nowhere is worse, because a data-rights request is on a 30-day clock the
   * database enforces and nobody would be reading it.
   */
  email: 'hello@xetral.com',
  /** Where the published notice lives, for the Play listing and for emails. */
  privacyUrl: 'https://app.xetral.com/legal/privacy',
  termsUrl: 'https://app.xetral.com/legal/terms',
} as const;

/** The postal address on one line, as a notice quotes it. */
export const REGISTERED_ADDRESS =
  `${COMPANY.addressLine}, ${COMPANY.city}, ${COMPANY.country}`;

/**
 * The countries the platform is open in, as `040_countries.seed.sql` has them.
 *
 * The terms said "resident in Nigeria", which stopped being true when Ghana
 * and Kenya opened — so a customer in Accra was being asked to accept terms
 * that described them as ineligible.
 */
export const OPEN_COUNTRIES = ['Nigeria', 'Ghana', 'Kenya'] as const;
