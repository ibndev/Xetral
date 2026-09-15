import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { parseFlutterwaveEvent, verifyFlutterwaveWebhook } from '@xetral/providers';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { flutterwaveWebhookHash } from '../app.module.js';
import { PaymentLinkService } from '../pay/payment-link.service.js';
import { PayoutService } from '../payouts/payout.service.js';

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
    @Inject(PayoutService) private readonly payouts: PayoutService,
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
     * MONEY IN AND MONEY OUT ARRIVE ON ONE URL, and telling them apart was
     * the whole of what was missing.
     *
     * Flutterwave posts `charge.completed` for a collection and
     * `transfer.completed` for a payout to the same endpoint. Every event
     * used to go to the payment-link settler, which knows about collections
     * and quite correctly acknowledged a transfer event as a reference it had
     * never heard of. So the FINAL STATUS OF EVERY GHANAIAN AND KENYAN
     * PAYOUT was delivered to this platform and dropped: their API answers
     * `NEW` when a transfer is accepted, this platform records that as `sent`
     * rather than guessing, and the outcome only ever comes in the event.
     * A failed transfer therefore stayed `sent`, the customer's money stayed
     * in `customer_pending`, and nothing but a sweep that is off by default
     * would ever ask.
     *
     * THE PREFIX IS WHAT IS MATCHED, not the exact name. Flutterwave has
     * spelled these `transfer.completed` and `transfer.failed`, and the cost
     * of being wrong in each direction is not symmetrical: an unrecognised
     * transfer event handed to the link settler is silently dropped, while a
     * charge event handed to the payout resolver finds no payout and answers
     * `unknown`. The second is harmless, so the match is deliberately loose.
     */
    if (event.kind.startsWith('transfer')) {
      const outcome = await this.payouts.resolveByReference(event.reference);
      this.#logger.log(`flutterwave transfer ${event.reference}: ${outcome}`);
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
