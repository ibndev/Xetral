import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LINK THE API BUILDS MUST BE A PAGE THIS APP SERVES.
 *
 * `paymentLinkFor()` returns `${origin}/pay/${digits}`. The Add Money screen
 * shows it with a Copy button and tells the customer it is safe to post
 * publicly. `apps/web` had no `/pay` route at all, so every link generated
 * since the feature shipped answered 404 — and nothing failed anywhere: the
 * path is a template string in one workspace and a DIRECTORY NAME in another,
 * which no compiler and no type can compare.
 *
 * It is also the shape `wallet.service.ts` parses back out of a pasted link,
 * so three separate places have to agree on one segment. This test is the only
 * thing that reads all three.
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
      `the API hands customers /${segment()}/<number> and apps/web has no page for it — ` +
        'every payment link answers 404',
    ).toBe(true);
  });

  it('the parser accepts the link the service produces', () => {
    // `payLinkTarget` is what turns a pasted link back into an identifier on
    // the transfer path. It matches on the same segment, in its own regex, in
    // a third file — so the two can disagree without either one being wrong on
    // its own.
    const wallet = read(join(API, 'wallet', 'wallet.service.ts'));
    expect(
      wallet.includes(`\\/${segment()}\\/`),
      `payLinkTarget() does not parse /${segment()}/ links, so a customer pasting one is ` +
        'told there is no such recipient',
    ).toBe(true);
  });

  it('the link drops the plus and both readers put it back', () => {
    // A `+` in a URL is a space to enough software that a link carrying one
    // breaks on the way to whoever was asked to pay. So the generator strips
    // it, and BOTH things that read a link back have to restore it — the
    // landing page for a browser, and the API parser for a paste.
    const profile = read(join(API, 'auth', 'profile.service.ts'));
    expect(
      profile.includes("replace(/^\\+/, '')"),
      'paymentLinkFor() no longer strips the leading +, so a shared link can arrive broken',
    ).toBe(true);

    const landing = read(join(HERE, '[ref]', 'page.tsx'));
    expect(landing.includes('`+${ref}`'), 'the landing page does not restore the +').toBe(true);

    const wallet = read(join(API, 'wallet', 'wallet.service.ts'));
    expect(
      wallet.includes('`+${segment}`'),
      'payLinkTarget() does not restore the +, so a pasted link misses the account',
    ).toBe(true);
  });

  it('the landing page hands the identifier to the transfer screen, which reads it', () => {
    const landing = read(join(HERE, '[ref]', 'page.tsx'));
    const key = landing.match(/redirect\(`\/transfer\?([a-z]+)=/)?.[1];
    expect(key, 'the landing page no longer redirects to /transfer with a query key').toBeDefined();

    const transfer = read(join(HERE, '..', 'transfer', 'page.tsx'));
    expect(
      transfer.includes(`params.get('${key ?? ''}')`),
      `the landing page sends ?${key}= and the transfer screen does not read it, so a ` +
        'customer following a link lands on an empty form',
    ).toBe(true);
  });
});
