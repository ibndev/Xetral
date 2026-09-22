import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Runs the transaction monitoring rules, and does nothing else.
 *
 * ALL THE LOGIC IS IN `detect_risk_signals()`, deliberately. This class starts
 * a timer, takes a lock and reports what happened; it holds no opinion about
 * what is suspicious. That division matters because the rules read POSTINGS
 * and postings are the database's — a rule half in SQL and half here would be
 * two places to look when somebody asks why an account was not flagged, and
 * the half in TypeScript would be the one that quietly stopped matching.
 *
 * IT NEVER ACTS. No freeze, no refusal, no hold. Monitoring runs after the
 * fact by construction, so anything that must decide before money moves
 * belongs in a ledger precondition where the daily ceiling and the velocity
 * rules already are. What this produces is a queue for a person.
 */

/* Distinct from every other sweep's key, so two sweeps never block each other. */
const SWEEP_LOCK_KEY = 8_264_100_027;

export interface MonitoringReport {
  /** How many signals each rule raised on this pass. */
  readonly raised: Readonly<Record<string, number>>;
  readonly total: number;
  /** Cases the sweep opened because a customer's signals had become a
   *  pattern. */
  readonly casesOpened: number;
}

@Injectable()
export class MonitoringService implements OnApplicationShutdown {
  readonly #logger = new Logger(MonitoringService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.riskMonitorIntervalSeconds;
    if (everySeconds === undefined) {
      // Loud, because this failure is silent in the worst way: nothing breaks,
      // no request fails, and the compliance queue is simply empty for ever.
      // An AML programme that stopped observing and nobody noticed is the
      // finding that costs a licence.
      this.#logger.warn(
        'RISK_MONITOR_INTERVAL_SECONDS is not set: NO TRANSACTION MONITORING IS ' +
          'RUNNING. Nothing will appear in the compliance queue, which looks ' +
          'exactly like a quiet week. Set it on exactly one instance.',
      );
      return;
    }

    this.#logger.log(`monitoring transactions every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        this.#logger.error(`monitoring sweep failed: ${describe(error)}`);
      });
    }, everySeconds * 1000);
    this.#timer.unref();
  }

  onApplicationShutdown(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
  }

  /**
   * One pass.
   *
   * The advisory lock is an OPTIMISATION here rather than a correctness
   * requirement, unlike the purchase reconciler's — every insert in
   * `detect_risk_signals()` is `ON CONFLICT (signal_key) DO NOTHING`, so two
   * concurrent sweeps produce the same rows. It is held anyway because the
   * rules scan a day of postings per currency, and four instances doing that
   * on a schedule is work nobody needs.
   */
  async sweep(): Promise<MonitoringReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { raised: {}, total: 0, casesOpened: 0 };

      try {
        const result = await lock.query<{ rule: string; raised: string }>(
          `SELECT rule, raised FROM detect_risk_signals()`,
        );

        const raised: Record<string, number> = {};
        let total = 0;
        for (const row of result.rows) {
          const count = Number(row.raised);
          raised[row.rule] = count;
          total += count;
        }

        // AFTER the rules, on the same lock and the same pass.
        //
        // A customer with several open signals is already a pattern, and
        // noticing it otherwise means somebody sorting the queue by customer
        // and counting — the work nobody does at four in the afternoon. A case
        // opening itself is what turns several rows into one thing with a
        // deadline on it.
        const cases = await lock.query<{ opened: string }>(
          `SELECT opened FROM open_risk_cases_for_patterns()`,
        );
        const casesOpened = Number(cases.rows[0]?.opened ?? 0);

        if (total > 0) {
          // The counts, never the customers. This line goes to whatever
          // aggregates logs, and a compliance queue's contents are not
          // something to scatter across it.
          this.#logger.log(
            `monitoring raised ${total} signal(s): ` +
              Object.entries(raised)
                .filter(([, n]) => n > 0)
                .map(([rule, n]) => `${rule}=${n}`)
                .join(' '),
          );
        }
        if (casesOpened > 0) {
          this.#logger.log(`monitoring opened ${casesOpened} case(s) on repeated signals`);
        }
        return { raised, total, casesOpened };
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  /** The open queue, oldest first. */
  async queue(limit: number): Promise<readonly Record<string, unknown>[]> {
    const result = await this.pool.query<{
      id: string;
      rule: string;
      detail: unknown;
      observed_at: Date;
      user_uuid: string;
      email: string | null;
      user_status: string;
      other_open_signals: string;
      name: string | null;
      in_case: boolean;
    }>(
      `SELECT o.uuid AS id, o.rule, o.detail, o.observed_at, o.user_uuid, o.email,
              o.user_status, o.other_open_signals, u.full_name AS name,
              EXISTS (SELECT 1 FROM risk_case_signals cs
                        JOIN risk_signals rs ON rs.id = cs.signal_id
                        JOIN risk_cases c ON c.id = cs.case_id AND c.status = 'open'
                       WHERE rs.uuid = o.uuid) AS in_case
         FROM risk_signals_open o
         JOIN users u ON u.id = o.user_id
        ORDER BY o.observed_at
        LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      rule: row.rule,
      detail: row.detail,
      observed_at: row.observed_at.toISOString(),
      user_uuid: row.user_uuid,
      email: row.email,
      user_status: row.user_status,
      // `count(*)` is a bigint, so node-postgres hands it over as a string.
      // Safe to narrow HERE and nowhere near an amount: this is a count of
      // rows in a queue, which carries no units and cannot exceed anything a
      // number can hold. The amounts inside `detail` stay strings, for the
      // reason every amount on this platform does.
      other_open_signals: Number(row.other_open_signals),
      name: row.name,
      in_case: row.in_case,
    }));
  }

  /**
   * The three figures over the compliance queue.
   *
   * The comp's middle tile is "high severity", and the monitoring rules have
   * no severity — every one is an observation, never a verdict (027). What
   * this platform DOES have that a severity would stand for is a case: a
   * person looked at a pattern and opened an investigation. So the tile
   * counts open cases, which is a fact rather than a label invented for it.
   */
  async summary(): Promise<{ open_signals: number; open_cases: number; cleared_7d: number }> {
    const result = await this.pool.query<{
      open_signals: string;
      open_cases: string;
      cleared_7d: string;
    }>(
      `SELECT (SELECT count(*) FROM risk_signals WHERE resolved_at IS NULL) AS open_signals,
              (SELECT count(*) FROM risk_cases WHERE status = 'open')       AS open_cases,
              (SELECT count(*) FROM risk_signals
                WHERE resolved_at > now() - interval '7 days')              AS cleared_7d`,
    );
    const row = result.rows[0];
    return {
      open_signals: Number(row?.open_signals ?? 0),
      open_cases: Number(row?.open_cases ?? 0),
      cleared_7d: Number(row?.cleared_7d ?? 0),
    };
  }

  /**
   * Closes one, with a person and a reason.
   *
   * Both are required by a CHECK as well as here — a signal closed with no
   * explanation is a queue that was cleared rather than worked, and that
   * distinction is the only thing a regulator can actually inspect.
   */
  async resolve(
    signalUuid: string,
    reviewerUuid: string,
    resolution: string,
  ): Promise<{ readonly id: string; readonly resolved_at: string } | undefined> {
    const result = await this.pool.query<{ uuid: string; resolved_at: Date }>(
      `UPDATE risk_signals s
          SET resolved_at = now(), resolved_by = r.id, resolution = $3
         FROM users r
        WHERE r.uuid = $2::uuid AND s.uuid = $1::uuid AND s.resolved_at IS NULL
       RETURNING s.uuid, s.resolved_at`,
      [signalUuid, reviewerUuid, resolution],
    );
    const row = result.rows[0];
    if (row === undefined) return undefined;
    return { id: row.uuid, resolved_at: row.resolved_at.toISOString() };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
