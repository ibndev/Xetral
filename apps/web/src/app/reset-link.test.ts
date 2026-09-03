import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE RESET EMAIL'S LINK POINTS AT A PAGE THAT EXISTS.
 *
 * `PasswordResetService.#resetUrl` builds `${APP_BASE_URL}/<segment>?token=…`
 * and the page that answers it is a DIRECTORY NAME in another workspace.
 * Nothing compares those two: one is a string literal in the API, the other is
 * a folder on disk in the web app, and no compiler has an opinion about either.
 *
 * That is not hypothetical here. `ProfileService` built `${appBaseUrl}/pay/…`,
 * both apps showed the link with a Copy button and told the customer it was
 * safe to post publicly, and `apps/web` had no `/pay` route at all — every one
 * of those links answered 404 for the whole life of the feature. This is the
 * same contract in the flow where breaking it means a customer who has
 * forgotten their password has no way back to their money.
 *
 * The query parameter is checked too: the page reads `token`, and a link
 * carrying `t` would render the "this link is missing its token" state for a
 * link that is perfectly good.
 */

const HERE = new URL('.', import.meta.url).pathname;
const SERVICE = join(HERE, '..', '..', '..', 'api', 'src', 'auth', 'password-reset.service.ts');

describe('the password reset link', () => {
  it('names a route this app actually serves', () => {
    const source = readFileSync(SERVICE, 'utf8');
    const built = /\$\{base\}\/([a-z-]+)\?token=/.exec(source);
    expect(built, 'the reset URL is no longer built the way this test reads it').not.toBeNull();

    const segment = built?.[1] ?? '';
    expect(
      existsSync(join(HERE, segment, 'page.tsx')),
      `the reset email links to /${segment} and apps/web has no such page — ` +
        'a customer who forgot their password would land on a 404',
    ).toBe(true);
  });

  it('uses the query parameter the page reads', () => {
    const service = readFileSync(SERVICE, 'utf8');
    const built = /\$\{base\}\/([a-z-]+)\?([a-z_]+)=/.exec(service);
    const segment = built?.[1] ?? '';
    const parameter = built?.[2] ?? '';

    const page = readFileSync(join(HERE, segment, 'page.tsx'), 'utf8');
    expect(
      page.includes(`params.get('${parameter}')`),
      `the email sends ?${parameter}= and the page does not read it`,
    ).toBe(true);
  });
});
