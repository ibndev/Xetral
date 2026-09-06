import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { parseFlutterwaveEvent, verifyFlutterwaveWebhook } from '@xetral/providers';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { flutterwaveWebhookHash } from '../app.module.js';
import { PaymentLinkService } from '../pay/payment-link.service.js';

/**
 * Money arriving through Flutterwave.
 *
 * WHAT THIS HANDLER TRUSTS IS ALMOST NOTHING, and that is not caution for its
 * own sake — it is forced by how Flutterwave authenticates. There is no
 * signature over the body: they send back, verbatim, a secret string the
 * operator typed into their dashboard. So a valid header proves WHO sent the
 * request and says nothing whatever about WHAT they sent.
 *
 * The header therefore decides only whether to listen. Everything that moves
 * money is re-read from Flutterwave by OUR OWN reference, through the same
 * `settle` the payer's return calls — which is the rule 058 already applies
 * to the Paystack checkout for a different reason, arrived at here from a
 * stronger one.
 *
 * A FORGED EVENT ANSWERS 401 AND IS DROPPED, never 500 and never retried.
 * 008's finding: a 500 pages somebody over a stranger's probe and tells the
 * sender we are broken rather than that they are unauthorised.
 *
 * AN UNKNOWN REFERENCE IS ACKNOWLEDGED, not refused. Flutterwave fires
 * `charge.completed` for everything on the integration, and most of those
 * will not be link payments — refusing would make them retry an event that
 * will never become ours.
 */
@Injectable()
export class FlutterwaveWebhookService {
  readonly #logger = new Logger(FlutterwaveWebhookService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ProviderCredentialService)
    private readonly credentials: ProviderCredentialService,
    @Inject(PaymentLinkService) private readonly links: PaymentLinkService,
  ) {}

  async handle(rawBody: string, headers: Record<string, string | undefined>): Promise<void> {
    const secretHash = await flutterwaveWebhookHash(this.config, this.credentials)();

    if (
      !verifyFlutterwaveWebhook({
        // Their header, lowercased by Node like every other inbound header.
        header: headers['verif-hash'],
        secretHash,
      })
    ) {
      /*
       * NO HASH CONFIGURED LANDS HERE TOO, and it must.
       *
       * `verifyFlutterwaveWebhook` answers false for an unset secret rather
       * than treating verification as switched off — an endpoint that
       * credited wallets on anybody's say-so because a box was empty is the
       * one failure mode this whole file exists to avoid.
       */
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new UnauthorizedException({ error: 'invalid_payload' });
    }

    const event = parseFlutterwaveEvent(payload);
    if (event?.reference === undefined) {
      this.#logger.warn('a Flutterwave event carried no reference; nothing to settle');
      return;
    }

    /*
     * THE SAME `settle` THE PAYER'S RETURN CALLS.
     *
     * Two copies of "how a payment is credited" would be two sets of
     * assumptions about the ledger, and the copy that drifts is the one that
     * only runs against money nobody is watching — `purchase-outcome.ts`
     * records the rule. It verifies with Flutterwave itself, so this handler
     * passing on a reference is the whole of its authority.
     */
    const outcome = await this.links.settle(event.reference);
    if (outcome === 'credited' || outcome === 'replayed') {
      this.#logger.log(`flutterwave ${event.reference}: ${outcome}`);
    }
  }
}
