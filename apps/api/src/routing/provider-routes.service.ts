import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { FundingPort, PayoutPort } from '@xetral/providers';
import { isCurrency } from '@xetral/shared';
import { FUNDING_PORT, PAYOUT_PORT } from '../tokens.js';
import { ProviderRouterService, ROUTED_OPERATIONS } from './provider-router.service.js';
import type { RoutedOperation } from './provider-router.service.js';

/**
 * Which companies COULD carry each kind of money, whatever this deployment
 * has configured.
 *
 * A statement about the adapters in this repository, not about credentials:
 * Paystack has no payout or account product outside naira, and nothing here
 * collects through Bitnob. Offering a rail that has no adapter for the
 * operation would be a toggle an operator flips that the switch then falls
 * back from — loudly in a log, silently on the screen.
 */
const CAPABLE: Readonly<Record<RoutedOperation, readonly string[]>> = {
  account: ['flutterwave', 'bitnob', 'paystack'],
  collect: ['paystack', 'flutterwave'],
  payout: ['flutterwave', 'bitnob', 'paystack'],
};

/** Naira-only rails. Their Nigerian registrations settle nothing else. */
const NAIRA_ONLY: ReadonlySet<string> = new Set(['paystack']);

export interface RouteRow {
  readonly operation: RoutedOperation;
  readonly currency: string;
  /** Null for a currency the platform is open in and nothing serves. */
  readonly provider: string | null;
  /** Who else could serve it on this deployment, in the order to offer them. */
  readonly options: readonly string[];
}

/**
 * The route table as the operations screen reads and changes it.
 *
 * WHY THERE WAS NO SCREEN. `ProviderRouterService.route()` has existed since
 * 059 and nothing called it, so moving a corridor was an UPDATE at a
 * production psql prompt — the install step 009 exists to abolish. The
 * product owner's request was a toggle: naira account numbers on Flutterwave
 * or Bitnob, cross-border payouts on Flutterwave or Bitnob, flipped by
 * whoever is on call rather than released.
 *
 * AN OPTION IS OFFERED ONLY IF THE SWITCH COULD USE IT. The funding and payout
 * switches fall back — loudly, in a log — when a route names a rail with no
 * adapter. A toggle that could select one would show the new rail on the
 * screen while the old one kept serving.
 */
@Injectable()
export class ProviderRoutesService {
  constructor(
    @Inject(ProviderRouterService) private readonly router: ProviderRouterService,
    @Inject(FUNDING_PORT) private readonly funding: FundingPort,
    @Inject(PAYOUT_PORT) private readonly payouts: PayoutPort,
  ) {}

  async list(): Promise<readonly RouteRow[]> {
    const rows = await this.router.all();
    return rows
      .filter((row): row is typeof row & { operation: RoutedOperation } =>
        (ROUTED_OPERATIONS as readonly string[]).includes(row.operation),
      )
      .map((row) => ({
        operation: row.operation,
        currency: row.currency,
        provider: row.provider,
        options: this.#options(row.operation, row.currency),
      }));
  }

  async set(options: {
    readonly operation: string;
    readonly currency: string;
    readonly provider: string;
    readonly byUserUuid: string;
  }): Promise<{ readonly was: string | null; readonly now: string }> {
    const operation = options.operation as RoutedOperation;
    if (!(ROUTED_OPERATIONS as readonly string[]).includes(operation)) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['operation'] });
    }
    const currency = options.currency.trim().toUpperCase();
    if (!isCurrency(currency)) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['currency'] });
    }
    if (!this.#options(operation, currency).includes(options.provider)) {
      // One code for "no such rail" and "not configured here", with the list
      // that WOULD work: the operator's next step is on the screen already.
      throw new BadRequestException({
        error: 'provider_not_available',
        options: this.#options(operation, currency),
      });
    }

    const before = (await this.router.all()).find(
      (r) => r.operation === operation && r.currency === currency,
    );
    await this.router.route({
      operation,
      currency,
      provider: options.provider,
      byUserUuid: options.byUserUuid,
    });
    return { was: before?.provider ?? null, now: options.provider };
  }

  #options(operation: RoutedOperation, currency: string): readonly string[] {
    const configured = this.#configured(operation);
    return CAPABLE[operation].filter(
      (provider) =>
        (configured === undefined || configured.includes(provider)) &&
        (currency === 'NGN' || !NAIRA_ONLY.has(provider)),
    );
  }

  /** Undefined where the port is a single adapter or the checkout, which
   *  this service cannot see into — the capability list is then the answer. */
  #configured(operation: RoutedOperation): readonly string[] | undefined {
    const port =
      operation === 'account'
        ? (this.funding as { providers?: readonly string[] })
        : operation === 'payout'
          ? (this.payouts as { providers?: readonly string[] })
          : undefined;
    return port?.providers;
  }
}
