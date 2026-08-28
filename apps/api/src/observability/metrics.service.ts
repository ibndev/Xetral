import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * What the platform looks like from outside, in a form a scraper can read.
 *
 * `/health` says the process is alive and `/ready` says the database answers.
 * Neither says whether the ledger is moving, a worker has stopped, or a queue
 * has been growing for six hours — and the worker failures in this codebase
 * are silent by construction: `NOTIFICATION_INTERVAL_SECONDS` unset means rows
 * accumulate, the API keeps saying "check your email", and nothing is ever
 * sent.
 *
 * MEASURED FROM THE VIEWS THAT ALREADY EXIST rather than from counters this
 * service keeps. A counter is a second copy of the truth and drifts from it —
 * the reason balances are computed from postings and `entry_status` is a view.
 * It also means a queue added to `admin_work_queue` is scraped automatically,
 * which is the same guarantee 036 gives the dashboard.
 *
 * AND IT IS CACHED, because it is not free. The queue view aggregates
 * twenty-three sources and one of them scans postings; a scraper at fifteen
 * seconds would run that all day. The cache is what stops an observability
 * endpoint becoming a load problem, which is a way of taking a system down
 * while watching it.
 */
@Injectable()
export class MetricsService {
  #cached: { at: number; body: string } | undefined;

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  async render(cacheMs: number): Promise<string> {
    const now = Date.now();
    if (this.#cached !== undefined && now - this.#cached.at < cacheMs) {
      return this.#cached.body;
    }
    const body = await this.#collect();
    this.#cached = { at: now, body };
    return body;
  }

  async #collect(): Promise<string> {
    const [queues, liability, providers, outbox] = await Promise.all([
      this.pool.query<{ queue: string; waiting: string; oldest: Date | null }>(
        `SELECT queue, waiting::text, oldest FROM admin_work_queue`,
      ),
      this.pool.query<{ currency: string; owed: string }>(
        `SELECT a.currency,
                COALESCE(sum(b.balance_minor), 0)::text AS owed
           FROM accounts a
           LEFT JOIN account_balances b ON b.account_id = a.id
          WHERE a.kind IN ('customer_wallet', 'customer_card', 'customer_pending')
          GROUP BY a.currency`,
      ),
      this.pool.query<{
        provider: string;
        operation: string;
        attempts: string;
        failures: string;
      }>(
        `SELECT provider, operation, attempts::text, failures::text
           FROM provider_health_recent`,
      ),
      this.pool.query<{ pending: string; abandoned: string }>(
        `SELECT count(*) FILTER (WHERE status = 'pending')::text   AS pending,
                count(*) FILTER (WHERE status = 'abandoned')::text AS abandoned
           FROM notification_outbox`,
      ),
    ]);

    const lines: string[] = [];

    lines.push(
      '# HELP xetral_queue_waiting Items waiting in an operations queue.',
      '# TYPE xetral_queue_waiting gauge',
    );
    for (const row of queues.rows) {
      lines.push(`xetral_queue_waiting{queue="${escape(row.queue)}"} ${row.waiting}`);
    }

    /*
     * AGE, not just depth, and it is the more useful of the two. A queue of
     * three that has been three since Tuesday is a queue nobody is working; a
     * queue of forty that turns over hourly is a busy morning. Alerting on
     * depth alone gets both wrong.
     */
    lines.push(
      '# HELP xetral_queue_oldest_seconds Age of the oldest item in a queue.',
      '# TYPE xetral_queue_oldest_seconds gauge',
    );
    for (const row of queues.rows) {
      if (row.oldest === null) continue;
      const seconds = Math.max(0, Math.floor((Date.now() - row.oldest.getTime()) / 1000));
      lines.push(`xetral_queue_oldest_seconds{queue="${escape(row.queue)}"} ${String(seconds)}`);
    }

    /*
     * MINOR UNITS, never a decimal. Prometheus samples are floats, so a naira
     * balance rendered in major units would be a float holding money — the one
     * thing this codebase does not do. Kobo as an integer is exact until 2^53,
     * and the unit is in the name so nobody divides by a hundred twice.
     */
    lines.push(
      '# HELP xetral_customer_liability_minor What is owed to customers, in minor units.',
      '# TYPE xetral_customer_liability_minor gauge',
    );
    for (const row of liability.rows) {
      lines.push(
        `xetral_customer_liability_minor{currency="${escape(row.currency)}"} ${row.owed}`,
      );
    }

    lines.push(
      '# HELP xetral_provider_calls Provider calls in the health window.',
      '# TYPE xetral_provider_calls gauge',
      '# HELP xetral_provider_failures Calls that were unreachable, timed out or unparseable.',
      '# TYPE xetral_provider_failures gauge',
    );
    for (const row of providers.rows) {
      const labels = `{provider="${escape(row.provider)}",operation="${escape(row.operation)}"}`;
      lines.push(`xetral_provider_calls${labels} ${row.attempts}`);
      // REFUSALS ARE NOT IN THIS FIGURE. A declined card is the provider
      // working, and an alert that fires on ordinary business is one people
      // mute.
      lines.push(`xetral_provider_failures${labels} ${row.failures}`);
    }

    const outboxRow = outbox.rows[0];
    lines.push(
      '# HELP xetral_outbox_pending Messages written and not yet sent.',
      '# TYPE xetral_outbox_pending gauge',
      `xetral_outbox_pending ${outboxRow?.pending ?? '0'}`,
      // The number that says the worker has stopped. Rows accumulate, the API
      // keeps telling customers to check their email, and nothing else moves.
      '# HELP xetral_outbox_abandoned Messages nobody ever received.',
      '# TYPE xetral_outbox_abandoned gauge',
      `xetral_outbox_abandoned ${outboxRow?.abandoned ?? '0'}`,
    );

    lines.push(
      '# HELP xetral_uptime_seconds How long this instance has been up.',
      '# TYPE xetral_uptime_seconds gauge',
      `xetral_uptime_seconds ${String(Math.floor(process.uptime()))}`,
    );

    return `${lines.join('\n')}\n`;
  }
}

/** Prometheus label values are quoted; a backslash, a quote or a newline in one
 *  ends the sample early and corrupts everything after it. Queue names are
 *  ours, but provider and currency labels come from rows an operator sets. */
function escape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}
