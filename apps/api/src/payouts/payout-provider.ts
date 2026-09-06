import { Logger } from '@nestjs/common';
import type { Currency } from '@xetral/shared';
import type { ProviderRouterService } from '../routing/provider-router.service.js';
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
 * ROUTED BY THE DESTINATION'S CURRENCY, NOT BY ONE GLOBAL NAME — and that
 * correction is the whole reason this class changed.
 *
 * `payout_provider` is ONE NAME. It said `paystack`, so EVERY payout question
 * went to Paystack, including "what can a customer in Accra send to?" — and
 * Paystack answers that with GHANAIAN BANKS. In Ghana and Kenya money does not
 * move to a bank account for most people; it moves to a wallet on a phone
 * number, whose `account_bank` is a NETWORK code (MTN, VOD, ATL, MPS) that no
 * bank list contains.
 *
 * So the Send screen showed a customer in Accra a list of banks under a label
 * saying Mobile Money, and the Flutterwave payout adapter — written for
 * exactly this and registered nowhere — was never asked anything. 046 put
 * `payout_method` on the country so the SCREEN would stop offering a product
 * the customer's money cannot reach; this is the other half, which stops the
 * SERVER doing the same thing.
 *
 * `provider_routes` (059) already answers "who serves this currency" for
 * collection. Payouts ask the same question and now read the same table.
 *
 * THE GLOBAL SETTING IS STILL THE FALLBACK, deliberately. A deployment behind
 * 059 has no route table, and naira — the corridor that has always worked —
 * must keep working exactly as it did. An unrouted currency falls through to
 * the setting rather than refusing, because refusing here would take out the
 * screen customers send money from on the strength of a missing row.
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

  readonly #router: ProviderRouterService | undefined;
  readonly #currencyOf: (country: string) => Promise<string | undefined>;

  constructor(options: {
    readonly adapters: ReadonlyMap<string, PayoutPort>;
    readonly settings: SettingsService;
    readonly fallback: string;
    /** 059's route table. Absent in the unit fixtures, which test the
     *  fallback behaviour this class had before routing existed. */
    readonly router?: ProviderRouterService;
    /** What a country settles in. Its own function rather than a table here,
     *  because 040's rule is that a fact about a country is a ROW. */
    readonly currencyOf?: (country: string) => Promise<string | undefined>;
  }) {
    this.#adapters = options.adapters;
    this.#settings = options.settings;
    this.#fallback = options.fallback;
    this.#router = options.router;
    this.#currencyOf = options.currencyOf ?? (async () => undefined);
  }

  /**
   * Which rail serves payouts to this COUNTRY.
   *
   * The country is resolved to its currency first, because the route table is
   * keyed on currency — a payout to Ghana is a payout in cedis, and it is the
   * currency that decides which provider can actually move it.
   *
   * Falls back to `activeProvider()` for an unrouted currency, a deployment
   * behind 059, or a route naming an adapter this build does not have.
   */
  async providerForCountry(country: string): Promise<string> {
    if (this.#router !== undefined) {
      const currency = await this.#currencyOf(country.trim().toUpperCase());
      if (currency !== undefined) {
        const routed = await this.#router.providerFor('payout', currency);
        if (routed !== undefined && this.#adapters.has(routed)) return routed;
        if (routed !== undefined) {
          this.#logger.warn(
            `provider_routes sends ${currency} payouts to '${routed}', which this ` +
              `deployment has no adapter for. Falling back.`,
          );
        }
      }
    }
    return this.activeProvider();
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
    return this.#adapterFor(await this.providerForCountry(country)).banks(country);
  }

  async lookup(
    country: string,
    bankCode: string,
    accountNumber: string,
  ): Promise<BeneficiaryLookup> {
    return this.#adapterFor(await this.providerForCountry(country)).lookup(
      country,
      bankCode,
      accountNumber,
    );
  }

  async send<C extends Currency>(request: PayoutRequest<C>): Promise<PayoutReceipt> {
    /*
     * THE SAME RAIL THAT ANSWERED THE LIST MUST TAKE THE PAYOUT.
     *
     * `bankCode` came from `banks()`, so it is that provider's code and means
     * nothing to another one — an MTN network code sent to Paystack is not a
     * bank, and a Paystack bank code sent to Flutterwave is not a network.
     * Routing on the destination country keeps the three calls on one rail.
     */
    return this.#adapterFor(await this.providerForCountry(request.country)).send(request);
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
