import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { parseKoraEvent, verifyKoraWebhook } from '@xetral/providers';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { koraSecretKey } from '../app.module.js';
import { PaymentLinkService } from '../pay/payment-link.service.js';
import { PayoutService } from '../payouts/payout.service.js';
import { KoraDepositService } from './kora-deposit.service.js';

/**
 * Everything Kora tells us, on one URL.
 *
 * VERIFIED FIRST, and against Kora's own scheme (Webhooks guide, read 3
 * October 2026): `x-korapay-signature` is an HMAC-SHA256 of ONLY the `data`
 * object, keyed by our secret key. A request that fails it answers 401 and is
 * dropped — never 500 and never retried. A 500 pages somebody over a
 * stranger's probe and tells the sender we are broken rather than that they
 * are unauthorised (008's finding).
 *
 * THEN TRUSTED FOR ALMOST NOTHING. The signature covers `data` and not the
 * event name beside it, and even a genuine `data` is a claim about money
 * rather than money. So every outcome is RE-READ from Kora by reference before
 * a posting exists — a payout through `confirmWithRail`, a deposit through the
 * Charge Query, a checkout through the same `settle` the payer's return calls
 * — and processed IDEMPOTENTLY BY THAT REFERENCE: each path posts under a key
 * derived from it, so a redelivery is a replay at the ledger.
 *
 * MONEY IN AND MONEY OUT ARRIVE HERE TOGETHER, and telling them apart is the
 * first thing done: a payout event handed to the link settler would be
 * acknowledged as a reference it never heard of, and the final status of every
 * payout dropped.
 */
@Injectable()
export class KoraWebhookService {
  readonly #logger = new Logger(KoraWebhookService.name);

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ProviderCredentialService)
    private readonly credentials: ProviderCredentialService,
    @Inject(PaymentLinkService) private readonly links: PaymentLinkService,
    @Inject(PayoutService) private readonly payouts: PayoutService,
    @Inject(KoraDepositService) private readonly deposits: KoraDepositService,
  ) {}

  async handle(rawBody: string, headers: Record<string, string | undefined>): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new UnauthorizedException({ error: 'invalid_payload' });
    }

    const key = koraSecretKey(this.config, this.credentials);
    const secretKey = typeof key === 'string' ? key : await key();
    if (
      !verifyKoraWebhook({
        // Lowercased by Node like every other inbound header.
        header: headers['x-korapay-signature'],
        payload,
        secretKey,
      })
    ) {
      /* NO KEY CONFIGURED LANDS HERE TOO, and must: an endpoint that
       * credited wallets because a box was empty is the failure this whole
       * file exists to avoid. */
      throw new UnauthorizedException({ error: 'invalid_signature' });
    }

    const event = parseKoraEvent(payload);
    if (event === undefined) {
      this.#logger.warn('a Kora event did not have the expected shape; nothing to do');
      return;
    }

    /* MONEY OUT. Kora's payout events are `transfer.success` and
     * `transfer.failed`, and the reference is ours. */
    if (event.kind.startsWith('transfer.')) {
      if (event.reference === undefined) {
        this.#logger.warn(`a Kora ${event.kind} event carried no reference`);
        return;
      }
      const outcome = await this.payouts.resolveByReference(event.reference, event.reference);
      this.#logger.log(`kora transfer ${event.reference}: ${outcome}`);
      return;
    }

    /* Refunds are initiated from Kora's dashboard, not by this platform, and
     * a virtual account's number arriving later is a KES product this
     * platform does not open. Acknowledged, so they are not retried for ever. */
    if (!event.kind.startsWith('charge.')) {
      this.#logger.log(`kora ${event.kind || 'event'} acknowledged; nothing here acts on it`);
      return;
    }

    if (event.reference === undefined) {
      this.#logger.warn('a Kora charge event carried no reference; nothing to settle');
      return;
    }

    /*
     * MONEY INTO A CUSTOMER'S OWN ACCOUNT NUMBER. The account's reference
     * decides only whether to ASK; the deposit is re-read by the payment's
     * reference and credited on Kora's answer.
     *
     * AN UNSETTLED ONE IS RETHROWN AS A 500 SO KORA RETRIES ("we retry the
     * request periodically within 72 hours"). Acknowledging a deposit in
     * flight would drop real money with nothing but a sweep ever asking again.
     */
    if (
      event.accountReference !== undefined &&
      (await this.deposits.isAccountReference(event.accountReference))
    ) {
      if (event.kind !== 'charge.success') {
        this.#logger.log(`kora deposit event ${event.reference}: ${event.kind}`);
        return;
      }
      const outcome = await this.deposits.credit(event.reference);
      this.#logger.log(`kora deposit ${event.reference}: ${outcome}`);
      if (outcome === 'not_settled') {
        throw new Error(`kora deposit ${event.reference} is not settled at Kora yet`);
      }
      return;
    }

    /*
     * A CHECKOUT — a payment link, or a customer topping up their own wallet.
     * The same `settle` the payer's return calls, which verifies with Kora
     * itself; this handler passing on a reference is the whole of its
     * authority. An unknown reference is acknowledged: Kora sends events for
     * everything on the integration and most will not be link payments.
     */
    const outcome = await this.links.settle(event.reference);
    this.#logger.log(`kora ${event.reference}: ${outcome}`);
    /* OURS, and Kora did not call it successful when asked. Refusing the
       delivery is what makes Kora send it again; nothing else ever asks about
       a link payment. */
    if (outcome === 'pending') {
      throw new ServiceUnavailableException({ error: 'payment_unconfirmed' });
    }
  }
}
