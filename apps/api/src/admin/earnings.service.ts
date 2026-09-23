import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * WHAT THE PLATFORM HAS ACTUALLY EARNED, and why it might be nothing.
 *
 * Both revenue accounts have existed since `001_ledger.sql` and both are
 * posted to correctly — `revenue_fees` by every transfer, purchase and payout
 * that charges one, `revenue_fx_spread` by every conversion. What was missing
 * is that NOTHING SHOWED THE FIGURES, and the two defaults mean the honest
 * answer for a fresh deployment is zero:
 *
 *   - `transfer_fee_basis_points` ships at 0, deliberately. CLAUDE.md's rule
 *     is that a fee nobody configured is money taken from a customer because
 *     of a default.
 *   - An FX pair with no published `fx_spread_policies` row is REFUSED rather
 *     than quoted from a default, so an unpublished pair earns nothing
 *     because it converts nothing.
 *
 * Both are correct, and together they make "the platform is earning nothing"
 * indistinguishable from "the platform is broken" — with no screen able to
 * tell an operator which. So this reports the earnings AND the reason they
 * are what they are.
 *
 * READ FROM `account_balances`, never from a counter this service keeps. A
 * counter is a second copy of the truth and it is the copy that drifts — the
 * same argument `metrics.service.ts` makes for measuring from the views that
 * already exist.
 */
export interface EarningsLine {
  readonly currency: string;
  /** Minor units, as a string. Revenue accounts are credit-normal, so a
   *  healthy figure is POSITIVE. */
  readonly fees_minor: string;
  readonly fx_spread_minor: string;
  /** Collected for a revenue authority and owed onward. NOT earnings — it is
   *  here because an operator reading a fee figure will otherwise assume it
   *  includes the tax, and 032's whole point is that it does not. */
  readonly tax_payable_minor: string;
}

export interface PublishedPair {
  readonly base: string;
  readonly quote: string;
  readonly spread_basis_points: number;
}

/**
 * What was earned RECENTLY, per currency. The balances above are lifetime
 * totals, which answer "what have we made" and not "are we making anything";
 * the second is what somebody opening this screen on a Monday is asking.
 * Read from POSTINGS in the window, never from a counter.
 */
export interface RecentEarnings {
  readonly currency: string;
  readonly fees_24h_minor: string;
  readonly fx_spread_24h_minor: string;
  readonly fees_7d_minor: string;
  readonly fx_spread_7d_minor: string;
  /** Fees plus spread per day, OLDEST FIRST, seven entries, today last. */
  readonly daily_minor: readonly string[];
  /** The seven days before those, summed, so a change can be stated. */
  readonly previous_7d_minor: string;
}

export interface EarningsReport {
  readonly lines: readonly EarningsLine[];
  readonly recent: readonly RecentEarnings[];
  /** Basis points. 0 means every transfer is free, which is the shipped
   *  default and a decision an operator has to make rather than inherit. */
  readonly transfer_fee_basis_points: number;
  /** Every live FX policy. An empty list means no conversion can happen at
   *  all, so the spread column below it is necessarily zero. */
  readonly published_pairs: readonly PublishedPair[];
}

@Injectable()
export class EarningsService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(SettingsService) private readonly settings: SettingsService,
  ) {}

  async report(): Promise<EarningsReport> {
    const [lines, fee, pairs, recent] = await Promise.all([
      this.#lines(),
      this.settings.transferFeeBasisPoints(),
      this.#pairs(),
      this.#recent(),
    ]);
    return { lines, recent, transfer_fee_basis_points: fee, published_pairs: pairs };
  }

  /**
   * Fourteen days of revenue postings, bucketed by day in Lagos — the same
   * "today" the daily ceiling uses, so a figure here and a limit there cannot
   * disagree about when a day ended.
   */
  async #recent(): Promise<readonly RecentEarnings[]> {
    const rows = await this.pool.query<{
      currency: string;
      d: number;
      fees: string;
      fx: string;
      fees_24h: string;
      fx_24h: string;
    }>(
      `SELECT p.currency,
              ((now() AT TIME ZONE 'Africa/Lagos')::date
                 - (p.created_at AT TIME ZONE 'Africa/Lagos')::date)::int AS d,
              COALESCE(SUM(p.amount_minor) FILTER (WHERE a.kind = 'revenue_fees'), 0)::text AS fees,
              COALESCE(SUM(p.amount_minor) FILTER (WHERE a.kind = 'revenue_fx_spread'), 0)::text AS fx,
              COALESCE(SUM(p.amount_minor) FILTER (
                WHERE a.kind = 'revenue_fees' AND p.created_at > now() - interval '24 hours'), 0)::text
                AS fees_24h,
              COALESCE(SUM(p.amount_minor) FILTER (
                WHERE a.kind = 'revenue_fx_spread' AND p.created_at > now() - interval '24 hours'), 0)::text
                AS fx_24h
         FROM postings p JOIN accounts a ON a.id = p.account_id
        WHERE a.kind IN ('revenue_fees', 'revenue_fx_spread')
          AND p.created_at > now() - interval '15 days'
        GROUP BY 1, 2`,
    );
    const by = new Map<
      string,
      { fees24: bigint; fx24: bigint; fees7: bigint; fx7: bigint; daily: bigint[]; prev: bigint }
    >();
    for (const row of rows.rows) {
      const at = by.get(row.currency) ?? {
        fees24: 0n, fx24: 0n, fees7: 0n, fx7: 0n, daily: new Array<bigint>(7).fill(0n), prev: 0n,
      };
      at.fees24 += BigInt(row.fees_24h);
      at.fx24 += BigInt(row.fx_24h);
      const both = BigInt(row.fees) + BigInt(row.fx);
      if (row.d >= 0 && row.d < 7) {
        at.fees7 += BigInt(row.fees);
        at.fx7 += BigInt(row.fx);
        at.daily[6 - row.d] = (at.daily[6 - row.d] ?? 0n) + both;
      } else if (row.d >= 7 && row.d < 14) {
        at.prev += both;
      }
      by.set(row.currency, at);
    }
    return [...by.entries()]
      .map(([currency, v]) => ({
        currency,
        fees_24h_minor: v.fees24.toString(),
        fx_spread_24h_minor: v.fx24.toString(),
        fees_7d_minor: v.fees7.toString(),
        fx_spread_7d_minor: v.fx7.toString(),
        daily_minor: v.daily.map((x) => x.toString()),
        previous_7d_minor: v.prev.toString(),
      }))
      // The currency that earned most this week leads — it is the headline.
      .sort((a, b) => {
        const x = BigInt(a.fees_7d_minor) + BigInt(a.fx_spread_7d_minor);
        const y = BigInt(b.fees_7d_minor) + BigInt(b.fx_spread_7d_minor);
        return x === y ? a.currency.localeCompare(b.currency) : x > y ? -1 : 1;
      });
  }

  /**
   * One row per currency, with a row even where the figure is zero.
   *
   * FULL OUTER over the three account kinds rather than three queries, so a
   * currency that has earned a spread and no fees still appears — and so the
   * three figures for one currency are read from one consistent moment
   * rather than from three.
   */
  async #lines(): Promise<readonly EarningsLine[]> {
    const rows = await this.pool.query<{
      currency: string;
      fees_minor: string;
      fx_spread_minor: string;
      tax_payable_minor: string;
    }>(
      `SELECT a.currency,
              COALESCE(SUM(b.balance_minor)
                       FILTER (WHERE a.kind = 'revenue_fees'), 0)::text        AS fees_minor,
              COALESCE(SUM(b.balance_minor)
                       FILTER (WHERE a.kind = 'revenue_fx_spread'), 0)::text   AS fx_spread_minor,
              COALESCE(SUM(b.balance_minor)
                       FILTER (WHERE a.kind = 'liability_tax_payable'), 0)::text
                                                                              AS tax_payable_minor
         FROM accounts a
         JOIN account_balances b ON b.account_id = a.id
        WHERE a.kind IN ('revenue_fees', 'revenue_fx_spread', 'liability_tax_payable')
        GROUP BY a.currency
        ORDER BY a.currency`,
    );
    return rows.rows;
  }

  /**
   * What can be converted today, in the direction it was published.
   *
   * EACH DIRECTION IS ITS OWN ROW, because a rate is a ratio and 035 records
   * that publishing NGN→USD says nothing about USD→NGN. An operator who has
   * published one and not the other learns it here rather than from a
   * customer whose conversion was refused.
   */
  async #pairs(): Promise<readonly PublishedPair[]> {
    const rows = await this.pool.query<{
      base: string;
      quote: string;
      spread_basis_points: number;
    }>(
      `SELECT base_currency AS base, quote_currency AS quote, spread_basis_points
         FROM fx_spread_policies
        WHERE retired_at IS NULL
        ORDER BY base_currency, quote_currency`,
    );
    return rows.rows;
  }
}
