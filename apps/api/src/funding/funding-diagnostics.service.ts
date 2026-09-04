import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  PAYSTACK_ENDPOINTS,
  PaystackClient,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@xetral/providers';
import { DATABASE, API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';

/**
 * WHY "ACTIVATE ACCOUNT" FAILED, ANSWERED WITHOUT A SHELL.
 *
 * THE FAILURE THIS EXISTS FOR, and it is a failure of DIAGNOSIS rather than
 * of any one flow. Opening a naira account can be refused by at least six
 * unrelated things: no key, a key from the wrong Paystack domain, dedicated
 * accounts not enabled on the integration, a `preferred_bank` slug this
 * business is not approved for, a migration that has not been applied, or a
 * customer code minted under the other domain. Every one of them reaches the
 * customer as the same sentence — and reaches the operator as the same
 * sentence, because the refusal is written to a log nobody is tailing at the
 * moment somebody presses the button.
 *
 * So an operator's only move was to change something and try again, which is
 * how a correct live key gets replaced during an incident.
 *
 * This asks each question SEPARATELY and says which one answered no. It is
 * the shape the reference WordPress integration reached for the same reason
 * — it grew a Diagnostics page — and the shape `GET /v1/admin/readiness`
 * already has for configuration.
 *
 * WHAT IT WILL NOT DO:
 *
 * It never returns a credential, not masked and not truncated — the rule 026
 * makes structural, and a diagnostics page is exactly where somebody would be
 * tempted. It reports whether a key is present and which DOMAIN it belongs
 * to, both of which are readable from the prefix and neither of which is the
 * secret.
 *
 * It never opens an account. Every call here is a READ, so an operator can
 * press it repeatedly during an incident without creating anything — a
 * diagnostic that has side effects is one people are afraid to run.
 *
 * It DOES relay the provider's own sentence. That sentence names our
 * integration, so it never reaches a customer; a staff route is exactly where
 * it belongs, and it is the whole reason this is worth building.
 */

export type CheckState = 'pass' | 'fail' | 'warn' | 'skip';

export interface DiagnosticCheck {
  readonly name: string;
  readonly state: CheckState;
  /** One sentence an operator can act on. Never a credential. */
  readonly detail: string;
}

export interface FundingDiagnosis {
  readonly rail: string;
  readonly checks: readonly DiagnosticCheck[];
}

@Injectable()
export class FundingDiagnosticsService {
  readonly #logger = new Logger('FundingDiagnostics');

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderCredentialService)
    private readonly credentials: ProviderCredentialService,
  ) {}

  async diagnose(): Promise<FundingDiagnosis> {
    const rail = (await this.settings.text('funding_provider', 'paystack')).trim();
    const checks: DiagnosticCheck[] = [];

    checks.push(await this.#schemaCheck());
    checks.push({
      name: 'Which rail opens the next account',
      state: 'pass',
      detail:
        `funding_provider is '${rail}'. Accounts already issued keep working at the ` +
        `provider that issued them; this only decides the next one.`,
    });

    if (rail !== 'paystack') {
      checks.push({
        name: 'Paystack checks',
        state: 'skip',
        detail: `Skipped: the active rail is '${rail}', not paystack.`,
      });
      return { rail, checks };
    }

    checks.push(...(await this.#paystackChecks()));
    return { rail, checks };
  }

  /* ------------------------------------------------------------------ */

  /**
   * IS THE SCHEMA THE CODE EXPECTS ACTUALLY THERE?
   *
   * First, deliberately. A missing 044 makes every account request fail after
   * Paystack has already been asked and answered — so the provider is fine,
   * the credential is fine, and every other check on this page passes while
   * the button still does not work. Asked before anything is sent, an
   * operator reads the one line that names the file to apply.
   */
  async #schemaCheck(): Promise<DiagnosticCheck> {
    const missing: string[] = [];
    for (const [table, column, file] of [
      ['virtual_accounts', 'provider', '044_paystack_funding.sql'],
      ['virtual_accounts', 'provider_customer_ref', '044_paystack_funding.sql'],
      ['cards', 'colour', '045_card_fee_split.sql'],
      ['bank_payouts', 'provider', '046_payout_provider.sql'],
      ['countries', 'payout_method', '046_payout_provider.sql'],
    ] as const) {
      const found = await this.pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_name = $1 AND column_name = $2`,
        [table, column],
      );
      if (found.rowCount === 0) missing.push(`${table}.${column} (${file})`);
    }

    return missing.length === 0
      ? {
          name: 'Database schema',
          state: 'pass',
          detail: 'Every column this build writes exists. Migrations 044–046 are applied.',
        }
      : {
          name: 'Database schema',
          state: 'fail',
          detail:
            `The database is behind this build and that alone will fail every account ` +
            `request, whatever Paystack says. Missing: ${missing.join('; ')}. Apply those ` +
            `files from packages/ledger/sql in order.`,
        };
  }

  async #paystackChecks(): Promise<readonly DiagnosticCheck[]> {
    const { paystackBaseUrl } = this.config;
    if (paystackBaseUrl === undefined) {
      return [
        {
          name: 'Paystack base URL',
          state: 'fail',
          detail:
            'PAYSTACK_BASE_URL is not set, so no Paystack adapter is built at all and the ' +
            'rail falls back. Set it to https://api.paystack.co and redeploy.',
        },
      ];
    }

    const secretKey = await this.#secretKey();
    if (secretKey === undefined || secretKey === '') {
      return [
        {
          name: 'Paystack secret key',
          state: 'fail',
          detail:
            'No secret key is configured. Paste one on Provider keys, or set ' +
            'PAYSTACK_SECRET_KEY. Nothing else here can be checked without it.',
        },
      ];
    }

    const live = !secretKey.startsWith('sk_test');
    const checks: DiagnosticCheck[] = [
      {
        name: 'Paystack secret key',
        state: 'pass',
        // The DOMAIN, never the key. Which domain a key belongs to is readable
        // from its prefix and is not the secret; it is also the single fact
        // most likely to be wrong after a go-live.
        detail: live
          ? 'A LIVE key is configured (sk_live…). Test-domain customer codes will be ' +
            'refused for it — the adapter discards and recreates one when that happens.'
          : 'A TEST key is configured (sk_test…). Dedicated accounts will be issued at ' +
            "'test-bank' whatever paystack_preferred_bank says, because the test domain " +
            'has no other provider.',
      },
    ];

    const client = new PaystackClient({ baseUrl: paystackBaseUrl, secretKey });

    // DOES THE KEY WORK AT ALL? The bank list is the cheapest authenticated
    // read there is, and it is the same call the Send screen makes — so a
    // failure here explains two reported symptoms at once.
    const banks = await this.#probe(() =>
      client.request('GET', PAYSTACK_ENDPOINTS.banks('nigeria', 'NGN')),
    );
    checks.push({
      name: 'The key is accepted',
      state: banks.ok ? 'pass' : 'fail',
      detail: banks.ok
        ? `Paystack answered the bank list, so the credential reaches them and is valid.`
        : `Paystack refused an ordinary authenticated read: ${banks.detail}`,
    });

    if (!banks.ok) return checks;

    // IS THE DEDICATED ACCOUNT PRODUCT ENABLED, and which slugs may be named?
    // This is the check that separates "not approved for this product" from
    // "wrong preferred_bank", which on the customer's screen look identical.
    const providers = await this.#probe(() =>
      client.request('GET', PAYSTACK_ENDPOINTS.dedicatedAccountProviders),
    );
    const slugs = providers.ok ? providerSlugs(providers.value) : [];

    checks.push({
      name: 'Dedicated accounts are enabled',
      state: providers.ok ? (slugs.length > 0 ? 'pass' : 'warn') : 'fail',
      detail: providers.ok
        ? slugs.length > 0
          ? `Enabled. This integration may name: ${slugs.join(', ')}.`
          : 'Paystack answered, and named no NUBAN provider. Ask them to enable dedicated ' +
            'virtual accounts on this business.'
        : `Paystack refused the available-providers read: ${providers.detail} This is ` +
          'usually the dedicated virtual account product not being enabled on the ' +
          'business — it is requested from the Paystack dashboard and approved by them.',
    });

    // AND IS THE SETTING ONE OF THEM? A slug outside the approved set is the
    // refusal an operator is most likely to have caused themselves, and the
    // one that reads as a broken key.
    const configured = (
      await this.settings.paystackPreferredBank(this.config.paystackPreferredBank)
    )?.trim();

    if (!live) {
      checks.push({
        name: 'Preferred bank',
        state: 'pass',
        detail:
          `Overridden to 'test-bank' because this is a test key. The setting ` +
          `(${configured === undefined || configured === '' ? 'empty' : configured}) ` +
          `applies on a live key.`,
      });
    } else if (configured === undefined || configured === '') {
      checks.push({
        name: 'Preferred bank',
        state: slugs.length > 1 ? 'fail' : 'warn',
        detail:
          slugs.length > 1
            ? `paystack_preferred_bank is empty and this integration has more than one ` +
              `NUBAN provider (${slugs.join(', ')}). Paystack refuses a create that names ` +
              `none. Set it on Settings.`
            : 'paystack_preferred_bank is empty. With a single NUBAN provider Paystack ' +
              'picks it, so this is survivable — set it anyway so the choice is recorded.',
      });
    } else if (slugs.length > 0 && !slugs.includes(configured)) {
      checks.push({
        name: 'Preferred bank',
        state: 'fail',
        detail:
          `paystack_preferred_bank is '${configured}', which this integration is not ` +
          `approved for. Paystack refuses every create naming it. Use one of: ` +
          `${slugs.join(', ')} — these are SLUGS, so 'Wema Bank' is not 'wema-bank'.`,
      });
    } else {
      checks.push({
        name: 'Preferred bank',
        state: 'pass',
        detail: `paystack_preferred_bank is '${configured}', and this integration may name it.`,
      });
    }

    checks.push({
      name: 'Deposit webhook',
      state: 'warn',
      detail:
        `Paystack must be given ${this.config.webhookBaseUrl ?? '<WEBHOOK_BASE_URL unset>'}` +
        `/v1/webhooks/paystack/deposits on their dashboard. Nothing here can verify they ` +
        `have it — an account can be opened and still never credit anybody.`,
    });

    return checks;
  }

  async #secretKey(): Promise<string | undefined> {
    try {
      const stored = await this.credentials.secretFor('paystack', 'secret_key');
      if (stored !== undefined && stored !== '') return stored;
    } catch (error) {
      // A credential store that cannot be read is itself a finding, and the
      // environment fallback below is the documented order. Logged rather
      // than surfaced, because the caller gets the same answer either way.
      this.#logger.warn(`could not read the stored Paystack key: ${String(error)}`);
    }
    return this.config.paystackSecretKey;
  }

  /**
   * Runs one read and turns whatever happened into a sentence.
   *
   * Never throws. A diagnostics page whose own failure is a 500 tells an
   * operator nothing at exactly the moment they need everything.
   */
  async #probe(
    call: () => Promise<unknown>,
  ): Promise<{ ok: true; value: unknown } | { ok: false; detail: string }> {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (error instanceof ProviderRejectedError) {
        return { ok: false, detail: `${error.message} (a refusal, not an outage).` };
      }
      if (error instanceof ProviderTimeoutError) {
        return { ok: false, detail: 'they did not answer in time.' };
      }
      if (error instanceof ProviderUnavailableError) {
        return { ok: false, detail: `${error.message} — they could not be reached.` };
      }
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * The slugs out of an available-providers body, without trusting its shape.
 *
 * Paystack names the field `provider_slug`. Read defensively because this is
 * the one endpoint here whose response shape is not exercised by a money path
 * — and a diagnostics page that throws on an unexpected key is worse than one
 * that says it found nothing.
 */
function providerSlugs(payload: unknown): readonly string[] {
  if (typeof payload !== 'object' || payload === null) return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((row) =>
      typeof row === 'object' && row !== null
        ? (row as { provider_slug?: unknown }).provider_slug
        : undefined,
    )
    .filter((slug): slug is string => typeof slug === 'string' && slug !== '');
}
