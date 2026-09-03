import { Logger } from '@nestjs/common';
import type { Currency } from '@xetral/shared';
import type {
  BeneficiaryLookup,
  PayoutBank,
  PayoutPort,
  PayoutReceipt,
  PayoutRequest,
} from '@xetral/providers';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * Two payout rails, one port, and the choice read PER CALL.
 *
 * WHY THIS EXISTS. The bank list had exactly ONE implementation and it was
 * Bitnob's, reached through a client built only when `BITNOB_BASE_URL` is
 * set. Paystack is the default FUNDING rail, so the ordinary shipped
 * deployment holds Paystack credentials and no Bitnob ones — and on that
 * deployment `createPayoutPort` returned a port whose every method refuses.
 * The Send screen asked for banks, got `payout_provider_not_configured`, and
 * told the customer the bank list could not be loaded.
 *
 * Nothing was broken except that the only adapter able to answer needed a
 * credential nobody had. So the rail is a SETTING, the same shape and for the
 * same reason as `funding_provider`: the reason to switch is almost always
 * that the current provider is having a bad afternoon, and 009's argument is
 * that an operational decision taken under pressure should not be a release.
 *
 * SENDING AND READING BACK MUST USE THE SAME RAIL. Unlike a dedicated account
 * number, a payout is not permanent — but `status()` takes a provider-side id
 * only the rail that issued it can resolve, so `bank_payouts.provider`
 * carries the issuer and the caller passes it. Reading the rail off the
 * setting would make a payout in flight unresolvable the moment an operator
 * flipped it, and an unresolvable payout is one nothing can settle or
 * reverse — the exact state `bank_payouts_stuck` exists to count.
 */
export class SwitchingPayoutPort implements PayoutPort {
  readonly #logger = new Logger('Payouts');
  readonly #adapters: ReadonlyMap<string, PayoutPort>;
  readonly #settings: SettingsService;
  readonly #fallback: string;

  constructor(options: {
    readonly adapters: ReadonlyMap<string, PayoutPort>;
    readonly settings: SettingsService;
    readonly fallback: string;
  }) {
    this.#adapters = options.adapters;
    this.#settings = options.settings;
    this.#fallback = options.fallback;
  }

  /** The DEFAULT, for anything needing a name synchronously — see the funding
   *  switch, which makes the same distinction for the same reason. */
  get provider(): string {
    return this.#fallback;
  }

  /** Which rail sends the NEXT payout. */
  async activeProvider(): Promise<string> {
    const chosen = (await this.#settings.text('payout_provider', this.#fallback)).trim();
    if (this.#adapters.has(chosen)) return chosen;

    // Falls back LOUDLY rather than refusing: a typo in a setting must not
    // take out the screen customers send money from, and the warning is what
    // makes the typo findable.
    this.#logger.warn(
      `payout_provider is '${chosen}', which this deployment has no adapter for. ` +
        `Falling back to '${this.#fallback}'.`,
    );
    return this.#fallback;
  }

  async banks(country: string): Promise<readonly PayoutBank[]> {
    return this.#adapterFor(await this.activeProvider()).banks(country);
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    return this.#adapterFor(await this.activeProvider()).lookup(country, bankCode, accountNumber);
  }

  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    return this.#adapterFor(await this.activeProvider()).send(request);
  }

  async status(providerPayoutId: string, provider?: string): Promise<PayoutReceipt> {
    return this.#adapterFor(provider ?? (await this.activeProvider())).status(providerPayoutId);
  }

  #adapterFor(provider: string): PayoutPort {
    const adapter = this.#adapters.get(provider);
    if (adapter === undefined) {
      // Unreachable through `activeProvider`, which falls back. Reachable when
      // a ROW names a rail this deployment no longer builds — a payout sent
      // before a provider was removed. Naming it beats a generic error about
      // money a customer can see leaving their account.
      throw new Error(
        `no payout adapter for '${provider}': a payout sent by it cannot be read ` +
          `by this deployment`,
      );
    }
    return adapter;
  }
}
