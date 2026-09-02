import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE LINK THE API BUILDS MUST BE A PAGE THIS APP SERVES.
 *
 * `ProfileService.#view()` returns `${appBaseUrl}/pay/${handle}`. The settings
 * screen shows it with a Copy button and tells the customer it is safe to post
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

describe('the payment link', () => {
  it('the segment the API generates is the directory this app serves', () => {
    const profile = read(join(API, 'auth', 'profile.service.ts'));

    // The literal the service builds, e.g. `${origin}/pay/${handle}`.
    const built = profile.match(/`\$\{origin\}\/([a-z-]+)\/\$\{handle\}`/);
    expect(built, 'profile.service.ts no longer builds a link of a shape this test knows')
      .not.toBeNull();

    const segment = built?.[1] ?? '';
    expect(
      existsSync(join(HERE, '..', segment, '[handle]', 'page.tsx')),
      `the API hands customers /${segment}/<handle> and apps/web has no page for it — ` +
        'every payment link answers 404',
    ).toBe(true);
  });

  it('the parser accepts the link the service produces', () => {
    // `handleIn` is what turns a pasted link back into a handle on the
    // transfer path. It matches on the same segment, in its own regex, in a
    // third file — so the two can disagree without either one being wrong on
    // its own.
    const wallet = read(join(API, 'wallet', 'wallet.service.ts'));
    const profile = read(join(API, 'auth', 'profile.service.ts'));

    const segment = profile.match(/`\$\{origin\}\/([a-z-]+)\/\$\{handle\}`/)?.[1] ?? '';
    expect(
      wallet.includes(`\\/${segment}\\/`),
      `handleIn() does not parse /${segment}/ links, so a customer pasting one is told ` +
        'there is no such recipient',
    ).toBe(true);
  });

  it('the landing page hands the handle to the transfer screen, which reads it', () => {
    const landing = read(join(HERE, '[handle]', 'page.tsx'));
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
