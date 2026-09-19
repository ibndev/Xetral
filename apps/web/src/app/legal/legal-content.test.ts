import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPANY } from '@/lib/company';
import { NON_PROCESSORS, PROCESSORS } from '@/lib/processors';

/**
 * THE PUBLISHED LEGAL PAGES MUST SAY TRUE THINGS.
 *
 * Two different failures, both of which had shipped, and neither of which any
 * compiler or renderer can see.
 *
 * THE FIRST WAS SIX PLACEHOLDERS. `[registered company name]`,
 * `[registered address]`, `[dpo@ address]` and `[NDPC registration reference]`
 * were live on the page a regulator and an app-store reviewer read first — a
 * privacy notice promising rights in the name of a bracket. The go-live
 * checklist named them, which is the weaker instrument: a checklist is read
 * once by whoever is deploying, and a build failure is read by whoever
 * reintroduces one.
 *
 * THE SECOND WAS THE LIST OF WHO RECEIVES DATA, and it was wrong in both
 * directions at once. It named `Resend`, which is not in this codebase at all
 * — Brevo has been the notification adapter since 048 — and it named Airalo
 * and Twilio, which receive a product code and an opaque reference and nothing
 * about anybody. Meanwhile it omitted Paystack, the DEFAULT funding rail and
 * therefore the company almost every Nigerian customer's name, email and phone
 * number actually reaches. Naming a processor you do not use is a false
 * statement to customers; omitting one you do use is a false declaration to
 * Google as well.
 *
 * So both directions are checked: every company named must have an adapter,
 * and every adapter must be accounted for as either receiving something or
 * receiving nothing. The one that goes stale silently is the second.
 */
const LEGAL_DIR = new URL('.', import.meta.url).pathname;
const PROVIDERS_SRC = join(LEGAL_DIR, '../../../../../packages/providers/src');

/** Every `page.tsx` under `app/legal`, as text. */
function legalPages(): readonly (readonly [string, string])[] {
  return readdirSync(LEGAL_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const path = join(LEGAL_DIR, entry.name, 'page.tsx');
      return [entry.name, readFileSync(path, 'utf8')] as const;
    });
}

const PAGES = legalPages();

describe('the legal pages carry no placeholder', () => {
  it('finds the pages it is meant to be checking', () => {
    // Without this, a moved directory makes every assertion below pass over an
    // empty list — a guard that cannot fail, which is 013's lesson about the
    // reconciliation check that reported through a SELECT and exited zero.
    expect(PAGES.map(([name]) => name).sort()).toEqual(['privacy', 'terms']);
  });

  it.each(PAGES.map(([name]) => name))('%s has no [bracketed] value', (name) => {
    const [, source] = PAGES.find(([page]) => page === name) ?? ['', ''];

    /*
     * The RENDERED text only. A `[` inside code — an array index, a type
     * annotation — is not a placeholder, and a rule that fired on those would
     * be one somebody turns off. This looks for the shape the placeholders
     * actually had: bracketed prose of two or more words.
     */
    const bracketed = source.match(/\[[a-z][a-z@ ]{4,}\]/gi) ?? [];
    expect(
      bracketed,
      `${name}/page.tsx still publishes ${bracketed.join(', ')}`,
    ).toEqual([]);
  });

  it.each(PAGES.map(([name]) => name))('%s names the company', (name) => {
    const [, source] = PAGES.find(([page]) => page === name) ?? ['', ''];
    // Through the module, so the two pages cannot disagree and a change of
    // address is one edit rather than six.
    expect(source).toContain('@/lib/company');
    expect(source).toMatch(/COMPANY\.legalName/);
  });

  it('reaches the customer through an address somebody reads', () => {
    // A `dpo@` that forwards nowhere is worse than none: a data-rights request
    // is on a 30-day clock the database enforces.
    expect(COMPANY.email).toBe('hello@xetral.com');
    for (const [, source] of PAGES) expect(source).toMatch(/COMPANY\.email/);
  });
});

describe('the notice names exactly the companies that receive something', () => {
  const named = [...PROCESSORS, ...NON_PROCESSORS];

  it('every company named has an adapter in this repository', () => {
    const onDisk = readdirSync(PROVIDERS_SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // `Resend` was named for months and has never existed here.
    const missing = named
      .filter((p) => !onDisk.includes(p.adapter))
      .map((p) => `${p.name} (expected packages/providers/src/${p.adapter})`);

    expect(
      missing,
      'the notice names a company with no adapter — it cannot be receiving ' +
        'anything, and saying it does is a false statement',
    ).toEqual([]);
  });

  it('every adapter is accounted for, in one direction or the other', () => {
    /*
     * THE DIRECTION THAT GOES STALE SILENTLY. Adding a provider is a visible
     * change; remembering that the privacy notice describes who receives data
     * is not. An adapter absent from both lists is a company nobody decided
     * about — which for Paystack meant the default funding rail went
     * undeclared.
     *
     * `ports`, `crypto` and `fx` are not providers: `ports` holds the
     * interfaces, and the other two are shared arithmetic and address
     * validation with no company behind them.
     */
    const notCompanies = new Set(['ports', 'crypto', 'fx']);
    const onDisk = readdirSync(PROVIDERS_SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !notCompanies.has(entry.name))
      .map((entry) => entry.name);

    const accounted = new Set(named.map((p) => p.adapter));
    const undecided = onDisk.filter((dir) => !accounted.has(dir));

    expect(
      undecided,
      'a provider adapter nobody has decided about: add it to PROCESSORS if ' +
        'it receives anything identifying, or to NON_PROCESSORS if it does not',
    ).toEqual([]);
  });

  it('says what each one receives, in words a customer can check', () => {
    for (const p of named) {
      expect(p.receives.length, `${p.name} says nothing about what it gets`)
        .toBeGreaterThan(40);
      expect(p.purpose.length).toBeGreaterThan(10);
    }
  });

  it('does not claim an NDPC registration', () => {
    /*
     * The notice used to. Registration is a real obligation and a claim a
     * regulator can check in an afternoon, so the page states the rights and
     * the contact and says nothing about a reference until there is one. This
     * fails the day somebody pastes a number in rather than adding it to
     * `COMPANY` with a decision behind it.
     */
    for (const [name, source] of PAGES) {
      expect(source, `${name} claims an NDPC registration reference`).not.toMatch(
        /registered with the Nigeria Data Protection Commission under/i,
      );
    }
  });
});
