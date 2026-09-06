import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LINK THE API BUILDS MUST BE A PAGE THIS APP SERVES, AND THAT PAGE MUST
 * BE PAYABLE BY A STRANGER.
 *
 * `paymentLinkFor()` returns `${origin}/pay/${slug}` and the page that answers
 * it is a DIRECTORY NAME in another workspace. Nothing compares those two: one
 * is a string literal in the API, the other a folder on disk here, and no
 * compiler has an opinion about either. That is not hypothetical — `apps/web`
 * once had no `/pay` route at all and every link generated answered 404.
 *
 * THE SECOND HALF IS NEWER AND IS THE ONE THAT WAS REPORTED. The page existed
 * and REDIRECTED TO THE SEND SCREEN, which is behind a sign-in — so the link a
 * customer was told to share "to accept payment globally" was payable only by
 * somebody who already had a Xetral account with money in it. A test that only
 * checks the route exists would have passed throughout.
 */

const HERE = new URL('.', import.meta.url).pathname;
const WEB = join(HERE, '..', '..', '..');
const API = join(WEB, '..', 'api', 'src');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The segment the API builds its links under, read out of the one function
 *  that builds them. */
function segment(): string {
  const profile = read(join(API, 'auth', 'profile.service.ts'));
  const built = profile.match(/`\$\{origin[^`]*\}\/([a-z-]+)\/\$\{/);
  expect(built, 'profile.service.ts no longer builds a link of a shape this test knows')
    .not.toBeNull();
  return built?.[1] ?? '';
}

describe('the payment link', () => {
  it('the segment the API generates is the directory this app serves', () => {
    expect(
      existsSync(join(HERE, '..', segment(), '[ref]', 'page.tsx')),
      `the API hands people /${segment()}/<slug> and apps/web has no page for it — ` +
        'every payment link answers 404',
    ).toBe(true);
  });

  it('the page takes a payment; it does not send the payer to sign in', () => {
    /*
     * THE FAULT THIS FILE EXISTS FOR NOW. The page used to `redirect()` to
     * `/transfer`, which is authenticated — so the "payment link" was a
     * shortcut for existing customers wearing the name of something else.
     */
    const page = read(join(HERE, '[ref]', 'page.tsx'));
    expect(page.includes('redirect('), 'the checkout page redirects again').toBe(false);
    expect(
      page.includes('/charge'),
      'the checkout page does not start a payment, so nobody without an account can pay',
    ).toBe(true);
  });

  it('the money goes to Paystack, and no card detail touches this page', () => {
    // The only thing this page does with money is hand the payer to Paystack's
    // own hosted page. A field that took a card number here would drag in
    // everything that decision exists to stay out of.
    const page = read(join(HERE, '[ref]', 'page.tsx'));
    expect(page.includes('authorization_url')).toBe(true);
    for (const forbidden of ['card_number', 'cardNumber', 'cvv', 'expiry']) {
      expect(page.includes(forbidden), `the checkout page asks for ${forbidden}`).toBe(false);
    }
  });

  it('the slug is not the phone number', () => {
    /*
     * A link is forwarded, indexed and pasted into group chats. A phone number
     * in one is a phone number published to everybody it reaches, for ever,
     * with no way to take it back — and the customer cannot rotate it, because
     * changing it means changing the number on the account.
     */
    const profile = read(join(API, 'auth', 'profile.service.ts'));
    expect(
      /paymentLinkFor\(origin,\s*phone\)/.test(profile),
      'the link is built from the phone number again',
    ).toBe(false);
    expect(profile.includes('paymentLinkFor(origin, slug)')).toBe(true);
  });

  it('a payment credits the wallet of the customer the link belongs to', () => {
    // The one thing the whole feature is for, asserted where it is decided.
    // `link_payments.user_id` is written before the payer is sent to Paystack
    // and is immutable by trigger, so the wallet credited is the one the link
    // named at the moment somebody chose to pay it.
    const service = read(join(API, 'pay', 'payment-link.service.ts'));
    expect(service.includes("kind: 'customer_wallet', ownerId: row.user_id")).toBe(true);
    expect(service.includes("kind: 'wallet_funding'")).toBe(true);
  });
});
