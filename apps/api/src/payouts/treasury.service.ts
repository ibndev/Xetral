import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRouterService } from '../routing/provider-router.service.js';
import { ProviderLiquidityService } from './provider-liquidity.service.js';

/**
 * WHAT CUSTOMERS ARE OWED, WHAT THE LEDGER SAYS WE HOLD, AND WHAT EACH
 * PROVIDER ACTUALLY HOLDS — per currency, on one screen.
 *
 * THE THREE DISAGREE, AND THAT IS THE POINT OF PUTTING THEM SIDE BY SIDE. A
 * customer holding cedis is owed cedis; the ledger's `provider_float` says
 * how much the platform holds in cedis in total; and only the provider can
 * say whether IT, the rail that must pay them out, holds any. Cedis credited
 * by a conversion the platform priced itself, or naira that arrived through
 * Paystack, read as held in the ledger and are nowhere near Flutterwave. No
 * code can move money between providers — that is a bank transfer somebody
 * makes — so what this does is make the gap impossible to miss, and name the
 * rail and the balance that would close it.
 *
 * MINOR UNITS AS STRINGS throughout, because every figure is BIGINT and a
 * JSON number would be a float holding money.
 */
export interface TreasuryRail {
  readonly provider: string;
  /** False where the rail has no balance read this platform can use. */
  readonly readable: boolean;
}

export interface TreasuryLine {
  readonly currency: string;
  /** Wallets, pending holds and card balances — what customers could ask for. */
  readonly owed_minor: string;
  /** The ledger's `platform_float_positions.held_minor`, every provider together. */
  readonly ledger_held_minor: string;
  /** Each rail's own figure, null where it cannot be read. */
  readonly live: readonly { readonly provider: string; readonly available_minor: string | null }[];
  /** The rail payouts in this currency go out on, if any is routed. */
  readonly payout_rail: string | null;
  /** What that rail can spend, null where it cannot say. */
  readonly payout_rail_available_minor: string | null;
  /** Set by `payout_debit_currencies`: the balance that funds it instead. */
  readonly debit_currency: string | null;
  /**
   * How much more the payout rail needs to pay every customer out in full,
   * or null where its balance cannot be read. Zero when covered.
   */
  readonly payout_rail_short_minor: string | null;
}

export interface Treasury {
  readonly rails: readonly TreasuryRail[];
  readonly lines: readonly TreasuryLine[];
}

@Injectable()
export class TreasuryService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderRouterService) private readonly router: ProviderRouterService,
    @Inject(ProviderLiquidityService) private readonly liquidity: ProviderLiquidityService,
  ) {}

  async treasury(): Promise<Treasury> {
    const rails = this.liquidity.rails();
    const held = new Map<string, Map<string, bigint> | undefined>();
    await Promise.all(
      rails.map(async (rail) => {
        const balances = await this.liquidity.balancesOf(rail, true);
        held.set(
          rail,
          balances === undefined ? undefined : new Map(balances.map((m) => [m.currency, m.amount])),
        );
      }),
    );

    const figures = await this.pool.query<{ currency: string; owed: string; ledger_held: string }>(
      `WITH owed AS (
         SELECT a.currency, SUM(b.balance_minor) AS minor
           FROM accounts a JOIN account_balances b ON b.account_id = a.id
          WHERE a.kind IN ('customer_wallet', 'customer_pending', 'customer_card')
          GROUP BY a.currency
       )
       SELECT c.currency,
              COALESCE(o.minor, 0)::text AS owed,
              COALESCE(f.held_minor, 0)::text AS ledger_held
         FROM (SELECT currency FROM owed
               UNION SELECT currency FROM platform_float_positions) c
         LEFT JOIN owed o ON o.currency = c.currency
         LEFT JOIN platform_float_positions f ON f.currency = c.currency
        ORDER BY c.currency`,
    );

    const lines: TreasuryLine[] = [];
    for (const row of figures.rows) {
      const owed = BigInt(row.owed);
      const payoutRail = (await this.router.providerFor('payout', row.currency)) ?? null;
      const debit = (await this.settings.payoutDebitCurrency(row.currency)) ?? null;
      const funding = debit ?? row.currency;
      const railHeld = payoutRail === null ? undefined : held.get(payoutRail);
      const railAvailable =
        railHeld === undefined ? undefined : (railHeld.get(funding) ?? 0n);
      lines.push({
        currency: row.currency,
        owed_minor: owed.toString(),
        ledger_held_minor: row.ledger_held,
        live: rails.map((provider) => {
          const balances = held.get(provider);
          return {
            provider,
            available_minor:
              balances === undefined ? null : (balances.get(row.currency) ?? 0n).toString(),
          };
        }),
        payout_rail: payoutRail,
        payout_rail_available_minor: railAvailable === undefined ? null : railAvailable.toString(),
        debit_currency: debit,
        // Only comparable in the same currency: a naira balance paying cedis
        // does so at THEIR rate, which is not ours to compute here.
        payout_rail_short_minor:
          railAvailable === undefined || debit !== null
            ? null
            : (owed > railAvailable ? owed - railAvailable : 0n).toString(),
      });
    }

    return {
      rails: rails.map((provider) => ({ provider, readable: held.get(provider) !== undefined })),
      lines,
    };
  }
}
