/**
 * The webhook endpoints this API actually serves, as data.
 *
 * WRITTEN OUT, AND EACH ONE IS A ROUTE THAT EXISTS. An operator configuring
 * Bitnob has to paste a URL somewhere, and the dashboard used to show none —
 * so the choice was to guess or to read the source. Both produce a value that
 * looks right and answers 404, and a webhook that 404s is a deposit that never
 * reaches a balance with nothing retrying.
 *
 * `webhook-endpoints.test.ts` compares this list against the route policy in
 * both directions, so an endpoint added to the API and not to this file — or
 * described here and since renamed — fails the build rather than being
 * discovered by a provider.
 */
export interface WebhookEndpoint {
  /** The path, exactly as the controller declares it. */
  readonly path: string;
  /** What a provider is being asked to send here. */
  readonly label: string;
  /** Which stored credential verifies its signature. */
  readonly secret: string;
}

export const WEBHOOK_ENDPOINTS: readonly WebhookEndpoint[] = [
  {
    path: '/v1/webhooks/bitnob/deposits',
    label: 'Deposits into dedicated Nigerian account numbers',
    secret: 'bitnob.webhook_secret',
  },
  {
    path: '/v1/webhooks/bitnob',
    label: 'Virtual card authorizations and settlements',
    secret: 'bitnob.webhook_secret',
  },
  {
    path: '/v1/webhooks/bitnob/crypto',
    label: 'On-chain deposits and withdrawals',
    secret: 'bitnob.webhook_secret',
  },
];

/**
 * The endpoints as a provider would be given them, or as bare paths.
 *
 * A NULL ORIGIN IS NOT AN ERROR HERE. `WEBHOOK_BASE_URL` is how an operator
 * says where a provider can reach this API, and until they have decided the
 * honest thing to show is the path with a note — never a hostname this code
 * invented, which is the one outcome that would be pasted into Bitnob and
 * quietly fail.
 */
export function webhookEndpoints(
  origin: string | undefined,
): readonly (WebhookEndpoint & { readonly url: string; readonly absolute: boolean })[] {
  return WEBHOOK_ENDPOINTS.map((endpoint) => ({
    ...endpoint,
    url: origin === undefined ? endpoint.path : `${origin}${endpoint.path}`,
    absolute: origin !== undefined,
  }));
}
