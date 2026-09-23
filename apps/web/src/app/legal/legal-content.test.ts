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
  const byAdapter = named.filter(
    (p): p is Extract<typeof p, { via: 'adapter' }> => p.via === 'adapter',
  );
  const byOperator = named.filter(
    (p): p is Extract<typeof p, { via: 'operator' }> => p.via === 'operator',
  );

  /** Every directory under `packages/providers/src` that is a company. */
  function adapterDirectories(): readonly string[] {
    /*
     * `ports`, `crypto` and `fx` are not providers: `ports` holds the
     * interfaces, and the other two are shared arithmetic and address
     * validation with no company behind them.
     */
    const notCompanies = new Set(['ports', 'crypto', 'fx']);
    return readdirSync(PROVIDERS_SRC, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !notCompanies.has(entry.name))
      .map((entry) => entry.name);
  }

  it('every company said to be called has an adapter in this repository', () => {
    const onDisk = adapterDirectories();

    // `Resend` was named for months and has never existed here.
    const missing = byAdapter
      .filter((p) => !onDisk.includes(p.adapter))
      .map((p) => `${p.name} (expected packages/providers/src/${p.adapter})`);

    expect(
      missing,
      'the notice says this company is called by our code and there is no ' +
        'adapter — either it receives nothing, or it receives it some other ' +
        'way and belongs under via: "operator"',
    ).toEqual([]);
  });

  it('every adapter is accounted for, in one direction or the other', () => {
    /*
     * THE DIRECTION THAT GOES STALE SILENTLY. Adding a provider is a visible
     * change; remembering that the privacy notice describes who receives data
     * is not. An adapter absent from both lists is a company nobody decided
     * about — which for Paystack meant the default funding rail went
     * undeclared.
     */
    const accounted = new Set(byAdapter.map((p) => p.adapter));
    const undecided = adapterDirectories().filter((dir) => !accounted.has(dir));

    expect(
      undecided,
      'a provider adapter nobody has decided about: add it to PROCESSORS if ' +
        'it receives anything identifying, or to NON_PROCESSORS if it does not',
    ).toEqual([]);
  });

  it('a company we say a PERSON sends to has no adapter', () => {
    /*
     * THE OPPOSITE REQUIREMENT, and it is what stops the notice describing a
     * route that has been replaced. Dojah receives a name, a date of birth and
     * a BVN today because a reviewer types them into Dojah's own dashboard —
     * there is no code path, which is exactly why deriving the notice from the
     * send path could never have found it.
     *
     * The day an adapter lands, how the data gets there changes, what is sent
     * changes with it, and this goes red rather than the notice quietly
     * describing the old arrangement. A guard that only ever fires on an
     * omission cannot see an entry that has become out of date.
     */
    const onDisk = adapterDirectories();
    const nowIntegrated = byOperator
      .filter((p) => onDisk.includes(p.watchFor))
      .map((p) => `${p.name} (packages/providers/src/${p.watchFor} now exists)`);

    expect(
      nowIntegrated,
      'this company now has an adapter, so our code sends to it: move it to ' +
        'via: "adapter" and rewrite `receives` from the request body',
    ).toEqual([]);
  });

  it('a company with no adapter says why there is none', () => {
    // Without this, `via: "operator"` is a way to name anybody at all. The
    // reason has to be checkable against the tree by whoever reads it.
    for (const p of byOperator) {
      expect(p.why.length, `${p.name} does not say why it has no adapter`)
        .toBeGreaterThan(40);
    }
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

  it('does not claim nobody receives an identity detail', () => {
    /*
     * IT DID, AND IT WAS TRUE WHEN IT WAS WRITTEN. "Your date of birth, your
     * address and your Bank Verification Number are not sent to any of them"
     * was derived correctly from a send path that makes no identity call —
     * and it was false the moment a reviewer opened Dojah, because the route
     * a person takes is not in the code the sentence was derived from.
     *
     * An absolute denial is the one shape that cannot survive that, so the
     * absolute is what is banned. The page says what IS sent and to whom.
     */
    for (const [name, source] of PAGES) {
      expect(
        source,
        `${name} denies sending an identity detail to anybody at all`,
      ).not.toMatch(/not sent to any of them|No provider is given them/i);
    }
  });

  it('names, in its own words, every company a BVN reaches', () => {
    /*
     * "Only Dojah is given your Bank Verification Number" was the absolute
     * 075 retired, one company wider — and it went false the day naira
     * account numbers moved to Flutterwave, which will not open a permanent
     * account without one. The table carries the fact; the sentence a
     * customer actually reads is prose in the page, and prose is what drifts.
     * So every processor whose entry says it receives a BVN must be named in
     * the privacy page's own text, not only in the rows rendered from data.
     */
    const [, privacy] = PAGES.find(([page]) => page === 'privacy') ?? ['', ''];
    const bvnRecipients = PROCESSORS.filter((p) =>
      /Bank Verification Number/.test(p.receives),
    );
    expect(bvnRecipients.length).toBeGreaterThan(0);
    for (const p of bvnRecipients) {
      const shortName = p.name.split(' ')[0] as string;
      expect(privacy, `${p.name} receives a BVN and the page never says so`).toContain(
        shortName,
      );
    }
    expect(privacy).not.toMatch(/Only Dojah is given/);
  });
});
