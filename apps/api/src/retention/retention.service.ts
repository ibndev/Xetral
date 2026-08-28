import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * The sweep that deletes what has aged out.
 *
 * THE ONLY SCHEDULED PROCESS HERE WHOSE JOB IS TO DESTROY DATA, and it is
 * built to be as boring as possible. Every decision about WHAT is deleted and
 * for HOW LONG lives in `019_retention.sql` and in `platform_settings`; this
 * class calls one function and writes down what it did. There is deliberately
 * no logic here that could disagree with the schema, because the schema is
 * where the ledger is protected and a second opinion in TypeScript is a second
 * chance to be wrong about it.
 *
 * OFF BY DEFAULT, like every other worker. An operator sets
 * `RETENTION_INTERVAL_SECONDS` on exactly one instance. Unlike the others its
 * absence loses nothing — data simply accumulates — so bootstrap notes it
 * rather than warning, and the note says why accumulating is still wrong.
 */

/* Distinct from every other sweep's key, so two workers cannot lock each other
   out of unrelated work. */
const SWEEP_LOCK_KEY = 8_264_100_008;

export interface RetentionReport {
  readonly deleted: Readonly<Record<string, number>>;
  readonly total: number;
}

@Injectable()
export class RetentionService implements OnApplicationShutdown {
  readonly #logger = new Logger(RetentionService.name);
  #timer: NodeJS.Timeout | undefined;

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  start(): void {
    const everySeconds = this.config.retentionIntervalSeconds;
    if (everySeconds === undefined) {
      this.#logger.log(
        'RETENTION_INTERVAL_SECONDS is not set: nothing on this instance deletes ' +
          'aged data. Personal data will accumulate indefinitely, which the NDPA ' +
          'does not permit. Set it on exactly one instance.',
      );
      return;
    }

    this.#logger.log(`applying data retention every ${everySeconds}s`);
    this.#timer = setInterval(() => {
      void this.sweep().catch((error: unknown) => {
        // Loud, and not swallowed into a debug line. A retention sweep that
        // silently stops running is a table growing for years, and the only
        // evidence is a number nobody looks at.
        this.#logger.error(`retention sweep failed: ${describe(error)}`);
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
   * A session advisory lock, for the same reason every other sweep here holds
   * one: `pool.query` runs each statement in its own implicit transaction, so
   * `SELECT ... FOR UPDATE SKIP LOCKED` would release its locks before any
   * work happened while reading in review as though it guarded it. Duplicate
   * sweeps would be harmless — deleting an already-deleted row is a no-op —
   * but two racing produce two reports and neither is the truth.
   */
  async sweep(): Promise<RetentionReport> {
    const lock = await this.pool.connect();
    try {
      const acquired = await lock.query<{ ok: boolean }>(
        `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
        [SWEEP_LOCK_KEY],
      );
      if (acquired.rows[0]?.ok !== true) return { deleted: {}, total: 0 };

      try {
        const result = await lock.query<{ table_name: string; deleted: string }>(
          `SELECT table_name, deleted FROM apply_retention()`,
        );

        const deleted: Record<string, number> = {};
        let total = 0;
        for (const row of result.rows) {
          const n = Number(row.deleted);
          deleted[row.table_name] = n;
          total += n;
        }

        if (total > 0) {
          // Recorded PER TABLE rather than as one number. "Retention deleted
          // 40,000 rows" is not something anybody can check; naming the tables
          // is what makes an unexpected one visible the first time.
          this.#logger.log(
            `retention deleted ${total} row(s): ` +
              Object.entries(deleted)
                .filter(([, n]) => n > 0)
                .map(([table, n]) => `${table}=${n}`)
                .join(' '),
          );
        }

        return { deleted, total };
      } finally {
        await lock.query(`SELECT pg_advisory_unlock($1::bigint)`, [SWEEP_LOCK_KEY]);
      }
    } finally {
      lock.release();
    }
  }

  /** What the schema says about every table. Read from the view, so it cannot
   *  describe a policy the database does not have. */
  async coverage(): Promise<
    readonly { table_name: string; decision: string; rationale: string | null }[]
  > {
    const result = await this.pool.query<{
      table_name: string;
      decision: string;
      rationale: string | null;
    }>(`SELECT table_name, decision, rationale FROM retention_coverage`);
    return result.rows;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
