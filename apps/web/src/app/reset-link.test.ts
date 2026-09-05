import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A RESET IS A CODE, AND NOTHING MAY QUIETLY GO BACK TO BEING A LINK.
 *
 * It used to be a link, and the link needed an address: with `APP_BASE_URL`
 * unset the service refused before it did anything — "Password resets are
 * unavailable right now. Contact support." — on the one flow whose premise is
 * that a customer has nothing left to contact support WITH. A deployment value
 * nobody set took away the way back into an account holding somebody's money.
 *
 * This file used to check the other direction: that the link the API built
 * named a page this app serves, because one was a string literal in the API
 * and the other a folder on disk here, and no compiler has an opinion about
 * either. That contract is gone with the link, and the risk that replaced it
 * is somebody reintroducing a URL — so this asserts the ABSENCE, in both
 * workspaces at once. There is nothing else that could.
 */

const HERE = new URL('.', import.meta.url).pathname;
const API = join(HERE, '..', '..', '..', 'api', 'src');
const SERVICE = join(API, 'auth', 'password-reset.service.ts');
const TEMPLATES = join(API, 'notifications', 'templates.ts');

describe('the password reset code', () => {
  it('the service builds no link and needs no address', () => {
    const source = readFileSync(SERVICE, 'utf8');
    expect(
      /\/reset-password\?/.test(source),
      'the reset service is building a link again — it needs APP_BASE_URL, which is what ' +
        'made this flow refuse on a deployment that had never been told its own hostname',
    ).toBe(false);
    expect(
      source.includes('appBaseUrl'),
      'the reset service reads appBaseUrl again, so an unset one can refuse the flow',
    ).toBe(false);
  });

  it('the email carries the code and nothing to click', () => {
    const templates = readFileSync(TEMPLATES, 'utf8');
    const block = templates.slice(
      templates.indexOf("case 'password_reset':"),
      templates.indexOf("case 'password_changed':"),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block.includes('request.code'), 'the reset template no longer renders the code').toBe(
      true,
    );
    // A button in a reset email is the exact shape a phishing message copies,
    // and it is also the thing that needs a hostname.
    expect(block.includes('href'), 'the reset email has a link in it again').toBe(false);
  });

  it('there is no link-based page left to land on', () => {
    expect(
      existsSync(join(HERE, 'reset-password', 'page.tsx')),
      'the link-based reset page is back; a customer following an old email would be given ' +
        'a form asking for a token nothing issues',
    ).toBe(false);
  });

  it('the screen that finishes a reset asks for the code', () => {
    // `/forgot` is BOTH steps now — ask, then enter the code — because the
    // second step has nothing to arrive from. A customer stays on one page.
    const page = readFileSync(join(HERE, 'forgot', 'page.tsx'), 'utf8');
    expect(page.includes('resetPassword('), '/forgot cannot finish a reset').toBe(true);
    expect(page.toLowerCase().includes('code'), '/forgot has no code box').toBe(true);
  });
});
