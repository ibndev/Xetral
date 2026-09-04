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

/**
 * A failure this deployment has actually had, in the exception's own words.
 *
 * `error_events` has carried these since 015 and NOTHING EVER RENDERED THEM.
 * So the sentence explaining a 500 was in the database the whole time and the
 * only way to read it was a psql prompt — which is why "Something went wrong"
 * was, in practice, the entire diagnostic surface of this platform.
 *
 * `reference` is what makes one answerable: the six characters a person read
 * off their screen name the row that says what they hit.
 */
export interface RecentFailure {
  readonly route: string | null;
  readonly status: number | null;
  /** The exception's own sentence. Staff-only, for the reason every provider
   *  refusal here is: it names our tables and our integrations. */
  readonly message: string;
  readonly occurrences: string;
  readonly lastSeen: string;
  readonly reference: string | null;
}

export interface FundingDiagnosis {
  readonly rail: string;
  readonly checks: readonly DiagnosticCheck[];
  /** Most recent first. Empty is the good answer. */
  readonly failures: readonly RecentFailure[];
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
      return { rail, checks, failures: await this.#recentFailures() };
    }

    checks.push(...(await this.#paystackChecks()));
    return { rail, checks, failures: await this.#recentFailures() };
  }

  /**
   * What has actually been failing, in the exception's own words.
   *
   * NOT a Paystack question, and it lives here rather than on its own screen
   * because this is where somebody arrives holding a reference and a
   * complaint. The checks above answer "is the rail configured correctly?";
   * this answers "and what actually threw?", which no amount of configuration
   * checking can reach — a null column, a constraint, a typo in a SQL string.
   * Every one of those has happened in this codebase and every one presented
   * as the same sentence.
   */
  async #recentFailures(): Promise<readonly RecentFailure[]> {
    try {
      const rows = await this.pool.query<{
        route: string | null;
        status_code: number | null;
        message: string;
        occurrences: string;
        last_seen_at: Date;
        last_reference: string | null;
      }>(
        `SELECT route, status_code, message, occurrences::text AS occurrences,
                last_seen_at, last_reference
           FROM errors_open
          ORDER BY last_seen_at DESC
          LIMIT 20`,
      );
      return rows.rows.map((row) => ({
        route: row.route,
        status: row.status_code,
        message: row.message,
        occurrences: row.occurrences,
        lastSeen: row.last_seen_at.toISOString(),
        reference: row.last_reference,
      }));
    } catch (error) {
      /*
       * SWALLOWED, because 047 adds `last_reference` and this page is the
       * first thing an operator opens on a deployment whose schema is behind.
       * A diagnostics screen that 500s over a migration it exists to tell you
       * about is the joke writing itself.
       */
      this.#logger.warn(`could not read recent failures: ${String(error)}`);
      return [];
    }
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
    /*
     * COLUMNS **AND** RELATIONS, because a migration behind shows up as both.
     *
     * The first version of this check named five COLUMNS from 044 to 046 —
     * the ones the account-issuance INSERT writes — and that was too narrow
     * by exactly the amount that matters. A deployment can be behind by a
     * whole migration, and then it is a TABLE or a VIEW that is absent: the
     * customer view reads `card_history` and `kyc_tier_limits`, the admin
     * queues read a dozen views, and any one of them missing is a 500 on a
     * screen whose other panels work perfectly.
     *
     * Written out rather than derived from the SQL directory, for the reason
     * `INTRODUCED_BY` is: a list built at runtime from files shipped beside
     * the bundle reports whatever the bundle carries, which is the thing
     * already in doubt.
     */
    const REQUIRED: readonly (readonly [string, string])[] = [
      // Relations, named as `<relation>` with no dot.
      ['virtual_accounts', '006_funding.sql'],
      ['deposits', '006_funding.sql'],
      ['error_events', '015_error_events.sql'],
      ['notification_outbox', '012_notifications.sql'],
      ['kyc_submissions', '009_admin.sql'],
      ['platform_settings', '009_admin.sql'],
      ['provider_credentials', '026_provider_credentials.sql'],
      ['kyc_tier_limits', '029_kyc_tiers.sql'],
      ['card_history', '030_card_lifecycle.sql'],
      ['countries', '040_countries.sql'],
      ['bank_payouts', '043_bank_payouts.sql'],
      ['entry_status', '023_entry_status.sql'],
      ['admin_work_queue', '036_attention.sql'],
      // Columns, named as `<table>.<column>`.
      ['users.full_name', '040_countries.sql'],
      ['users.country', '040_countries.sql'],
      ['users.handle', '039_profile_handles.sql'],
      ['virtual_accounts.provider', '044_paystack_funding.sql'],
      ['virtual_accounts.provider_customer_ref', '044_paystack_funding.sql'],
      ['cards.colour', '045_card_fee_split.sql'],
      ['bank_payouts.provider', '046_payout_provider.sql'],
      ['countries.payout_method', '046_payout_provider.sql'],
      ['error_events.last_reference', '047_error_reference.sql'],
    ];

    const missing: string[] = [];
    for (const [name, file] of REQUIRED) {
      const [table, column] = name.split('.');
      if (table === undefined) continue;

      const found =
        column === undefined
          ? // A TABLE OR A VIEW. `to_regclass` answers for both and returns
            // NULL rather than raising, which is the only form that does not
            // need its own error handling per relation.
            await this.pool.query(`SELECT to_regclass($1) IS NOT NULL AS present`, [table])
          : await this.pool.query(
              `SELECT true AS present FROM information_schema.columns
                WHERE table_name = $1 AND column_name = $2`,
              [table, column],
            );

      const present =
        column === undefined
          ? (found.rows[0] as { present?: boolean } | undefined)?.present === true
          : (found.rowCount ?? 0) > 0;

      if (!present) missing.push(`${name} (${file})`);
    }

    if (missing.length === 0) {
      return {
        name: 'Database schema',
        state: 'pass',
        detail: `All ${REQUIRED.length} relations and columns this build reads exist.`,
      };
    }

    // The FILES, deduplicated and in order — because the action is "apply
    // these", and a list of twenty columns is a list somebody has to turn
    // into that themselves.
    const files = [...new Set(missing.map((entry) => entry.slice(entry.indexOf('(') + 1, -1)))]
      .sort()
      .join(', ');

    return {
      name: 'Database schema',
      state: 'fail',
      detail:
        `The database is behind this build, and that alone will fail requests whatever ` +
        `the provider says. Apply ${files} from packages/ledger/sql, in order. Missing: ` +
        `${missing.join('; ')}.`,
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

    checks.push(await this.#webhookCheck());

    return checks;
  }

  /**
   * THE WEBHOOK, ANSWERED FROM EVIDENCE RATHER THAN LEFT AMBER FOR EVER.
   *
   * This used to be a permanent warning saying "nothing here can verify
   * Paystack has the URL". True of the DASHBOARD SETTING, and the wrong thing
   * to report: an operator who has pasted it correctly is left staring at an
   * amber row that will never go green, next to rows that do. A check whose
   * answer cannot change is not a check, and one that stays amber when
   * everything is right is exactly how people learn to ignore amber.
   *
   * Two questions, separated:
   *
   * WHAT WE CONTROL is `WEBHOOK_BASE_URL`. Unset, the API cannot even tell an
   * operator which URL to paste — that is ours and it is a real failure.
   *
   * WHAT WE CAN OBSERVE is whether a Paystack deposit has ever arrived. A
   * delivered webhook is proof the whole path works: their dashboard, DNS,
   * the edge, the route and the signature. Nothing else can prove it, and no
   * amount of configuration checking substitutes — which is why the answer
   * comes from `deposits` rather than from a setting.
   *
   * Not-yet-delivered is a `warn` and says WHY: on a deployment where nobody
   * has transferred money in, no webhook can have arrived, and that is not a
   * fault. It is the honest state, and it clears itself on the first deposit.
   */
  async #webhookCheck(): Promise<DiagnosticCheck> {
    const base = this.config.webhookBaseUrl;
    if (base === undefined || base === '') {
      return {
        name: 'Deposit webhook',
        state: 'fail',
        detail:
          'WEBHOOK_BASE_URL is not set, so this deployment cannot even tell you which URL ' +
          'to give Paystack. Set it to the public API origin and redeploy.',
      };
    }

    const url = `${base.replace(/\/+$/, '')}/v1/webhooks/paystack/deposits`;

    let delivered = 0;
    try {
      const rows = await this.pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM deposits WHERE provider = 'paystack'`,
      );
      delivered = Number(rows.rows[0]?.n ?? '0');
    } catch (error) {
      this.#logger.warn(`could not count Paystack deposits: ${String(error)}`);
    }

    return delivered > 0
      ? {
          name: 'Deposit webhook',
          state: 'pass',
          detail:
            `Confirmed by delivery: ${delivered} Paystack deposit(s) have arrived at ${url}. ` +
            'That proves their dashboard, the edge, the route and the signature all work.',
        }
      : {
          name: 'Deposit webhook',
          state: 'warn',
          detail:
            `Give Paystack ${url} on their dashboard. Nothing has been delivered yet, which ` +
            'is expected until somebody transfers money in — this turns green on the first ' +
            'deposit, and only a real delivery can prove the path end to end.',
        };
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
