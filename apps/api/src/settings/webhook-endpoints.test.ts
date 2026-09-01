import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WEBHOOK_ENDPOINTS, webhookEndpoints } from './webhook-endpoints.js';

/**
 * EVERY URL THE DASHBOARD HANDS AN OPERATOR IS A ROUTE THAT EXISTS.
 *
 * The failure this prevents is silent at both ends. A webhook URL that 404s
 * looks fine in Bitnob's dashboard — they will happily keep POSTing to it —
 * and on our side it is simply an absence: no deposit, no error, nothing to
 * alert on. That is the shape `006_funding.sql` calls the failure a bank rail
 * cannot otherwise detect.
 *
 * Both directions, deliberately. A path listed here that the API does not
 * serve is a URL somebody pastes and waits on; a webhook route the API serves
 * that is NOT listed is an event nobody was told to send, which is the same
 * outcome reached from the other side.
 */

const ROUTES = join(import.meta.dirname, '..', 'auth', 'routes.ts');

/** Every public POST route in the policy whose path names a webhook. */
function declaredWebhookRoutes(): readonly string[] {
  const source = readFileSync(ROUTES, 'utf8');
  // `.public('POST', '<path>', '<why>')`, across the line breaks the
  // justifications force. Only paths under `/v1/webhooks` — that prefix is
  // what makes a route a provider's entry point rather than a customer's.
  return Array.from(
    source.matchAll(/\.public\(\s*'POST',\s*'(\/v1\/webhooks[^']*)'/g),
    (m) => m[1] as string,
  );
}

describe('the webhook endpoints the dashboard publishes', () => {
  it('are all routes this API actually declares', () => {
    const declared = new Set(declaredWebhookRoutes());
    const missing = WEBHOOK_ENDPOINTS.filter((e) => !declared.has(e.path)).map((e) => e.path);
    expect(
      missing,
      `published to operators and not served by the API — a provider would ` +
        `POST to a 404 for ever:\n${missing.join('\n')}`,
    ).toEqual([]);
  });

  it('cover every webhook route the API declares', () => {
    const published = new Set(WEBHOOK_ENDPOINTS.map((e) => e.path));
    const unlisted = declaredWebhookRoutes().filter((p) => !published.has(p));
    expect(
      unlisted,
      `served by the API and never shown to an operator, so nothing is ` +
        `configured to send them:\n${unlisted.join('\n')}`,
    ).toEqual([]);
  });

  it('shows a bare path rather than inventing an origin', () => {
    // The one thing worse than no URL is a plausible wrong one: it gets pasted
    // into Bitnob and fails in a way neither side reports.
    const unset = webhookEndpoints(undefined);
    expect(unset.every((e) => !e.absolute)).toBe(true);
    expect(unset[0]?.url).toBe(WEBHOOK_ENDPOINTS[0]?.path);

    const set = webhookEndpoints('https://api.example.com');
    expect(set[0]?.url).toBe(`https://api.example.com${WEBHOOK_ENDPOINTS[0]?.path ?? ''}`);
    expect(set.every((e) => e.absolute)).toBe(true);
  });
});
