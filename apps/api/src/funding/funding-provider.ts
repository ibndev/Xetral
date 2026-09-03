import { Logger } from '@nestjs/common';
import type {
  CreateVirtualAccountRequest,
  FundingPort,
  ProviderDeposit,
  VirtualAccount,
} from '@xetral/providers';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * Two naira rails, one port, and the choice read PER CALL.
 *
 * WHY A SETTING RATHER THAN A DEPLOYMENT VARIABLE. The reason to change rail
 * is almost always that the current one is having a bad afternoon, and 009's
 * whole argument is that an operational decision taken under pressure should
 * not be a release. Five seconds of settings cache is the delay; a deploy is
 * the alternative.
 *
 * WHY PAYSTACK IS THE DEFAULT. It opens an account from a name and an email
 * address. Bitnob refuses anybody it has not already verified a BVN for,
 * which is the wrong gate on the screen a customer opens in order to put
 * money in — CBN tier 1 permits the account, and `029_kyc_tiers.seed.sql` has
 * capped tier 0 at ₦50,000 a day since it landed.
 *
 * WHAT SWITCHING DOES NOT DO is move anybody. A dedicated account number is
 * permanent and saved in somebody's banking app as a beneficiary, so every
 * account already issued keeps working at the provider that issued it. That
 * is why `VirtualAccount` carries `provider` and the row records it: reading
 * the issuer off the currently-configured port would relabel every existing
 * account the moment an operator flipped this.
 *
 * READS ARE ROUTED BY THE ROW, NOT BY THE SETTING. `getVirtualAccount` and
 * `listDeposits` take a provider-side id that only ONE of these adapters can
 * make sense of, so they are dispatched on the provider recorded against the
 * account. Sending a Paystack customer code to Bitnob would not merely fail —
 * it would fail as "no such account", which reads as a customer's account
 * having disappeared.
 */
export class SwitchingFundingPort implements FundingPort {
  readonly #logger = new Logger('Funding');
  readonly #adapters: ReadonlyMap<string, FundingPort>;
  readonly #settings: SettingsService;
  readonly #fallback: string;

  constructor(options: {
    readonly adapters: ReadonlyMap<string, FundingPort>;
    readonly settings: SettingsService;
    /** Used when the setting names a rail this deployment has no adapter for. */
    readonly fallback: string;
  }) {
    this.#adapters = options.adapters;
    this.#settings = options.settings;
    this.#fallback = options.fallback;
  }

  /**
   * The DEFAULT, for anything that needs a name synchronously.
   *
   * Deliberately not "the active one": that is an async question and a
   * property that answered it from a cached read would be a lie the moment
   * the setting changed. Everything that must be right about which rail
   * served a request reads it off the `VirtualAccount` instead.
   */
  get provider(): string {
    return this.#fallback;
  }

  /** Which rail opens the NEXT account. */
  async activeProvider(): Promise<string> {
    const chosen = (await this.#settings.text('funding_provider', this.#fallback)).trim();
    if (this.#adapters.has(chosen)) return chosen;

    /*
     * A NAME WITH NO ADAPTER FALLS BACK, LOUDLY.
     *
     * The alternative is refusing every account request because a setting has
     * a typo in it, which turns a one-character mistake into an outage on the
     * screen customers use to put money in. Falling back keeps them served;
     * the warning is what makes the typo findable.
     */
    this.#logger.warn(
      `funding_provider is '${chosen}', which this deployment has no adapter for. ` +
        `Falling back to '${this.#fallback}'. Accounts will be opened with the ` +
        `fallback until the setting names a rail that exists.`,
    );
    return this.#fallback;
  }

  async createVirtualAccount(request: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    return this.#adapterFor(await this.activeProvider()).createVirtualAccount(request);
  }

  async getVirtualAccount(
    providerAccountId: string,
    provider?: string,
  ): Promise<VirtualAccount> {
    return this.#adapterFor(provider ?? (await this.activeProvider())).getVirtualAccount(
      providerAccountId,
    );
  }

  async listDeposits(
    providerAccountId: string,
    provider?: string,
  ): Promise<readonly ProviderDeposit[]> {
    return this.#adapterFor(provider ?? (await this.activeProvider())).listDeposits(
      providerAccountId,
    );
  }

  #adapterFor(provider: string): FundingPort {
    const adapter = this.#adapters.get(provider);
    if (adapter === undefined) {
      // Unreachable through `activeProvider`, which falls back. Reachable when
      // a ROW names a rail this deployment no longer builds — an account
      // issued before a provider was removed. Naming it beats a generic error
      // about an account the customer can see on their own screen.
      throw new Error(
        `no funding adapter for '${provider}': an account issued by it cannot be read ` +
          `by this deployment`,
      );
    }
    return adapter;
  }
}
