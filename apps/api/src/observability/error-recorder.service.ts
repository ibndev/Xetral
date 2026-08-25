import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * Recording that something went wrong, so somebody can find out.
 *
 * THE RULE THAT SHAPES EVERY LINE HERE: recording an error must never be able
 * to fail the request that produced it, or to produce an error of its own that
 * something else then tries to record. Everything below is written to swallow.
 * A platform whose error reporting can take down the endpoint it is reporting
 * on has made its worst day worse.
 */

/** What the message becomes before it is hashed. */
export interface Fingerprintable {
  readonly message: string;
  /** The route PATTERN — `/v1/admin/users/:id`, never the resolved path. */
  readonly route?: string;
}

/**
 * Everything that varies between two occurrences of the SAME bug.
 *
 * This list is the whole design. Errors carry identifiers — "user 8814 not
 * found", "purchase 5521 timed out", "duplicate key ... (idempotency_key)=(...)"
 * — and left in, a thousand occurrences of one bug are a thousand rows and the
 * table is a log with extra steps. Removed, one bug is one row with a count,
 * which is what makes "this is new" answerable.
 *
 * Ordered deliberately: UUIDs before hex, because a UUID is also a hex run and
 * the more specific pattern has to win; quoted strings before bare numbers, so
 * a number inside a quoted value is replaced once rather than twice.
 */
const NOISE: readonly (readonly [RegExp, string])[] = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>'],
  [/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>'],
  [/'[^']*'/g, "'<v>'"],
  [/"[^"]*"/g, '"<v>"'],
  [/\b0x[0-9a-f]+\b/gi, '<hex>'],
  [/\b[0-9a-f]{16,}\b/gi, '<hex>'],
  [/\b\d[\d,._]*\b/g, '<n>'],
];

/**
 * A stable 16-hex-character identity for the SHAPE of a failure.
 *
 * Exported and pure so it can be tested directly — the normalisation is where
 * this design succeeds or fails, and it is not something to discover from a
 * production table that turned out to have forty thousand rows in it.
 */
export function fingerprintOf(input: Fingerprintable): string {
  let normalised = input.message.toLowerCase();
  for (const [pattern, replacement] of NOISE) {
    normalised = normalised.replace(pattern, replacement);
  }
  // Whitespace last, so a message broken across lines fingerprints the same as
  // the one-line version of itself.
  normalised = normalised.replace(/\s+/g, ' ').trim();

  // The route is part of the identity. The same "not found" thrown from two
  // different endpoints is two different bugs, and merging them would hide
  // whichever one appeared second.
  const material = `${input.route ?? '-'}|${normalised}`;
  return createHash('sha256').update(material, 'utf8').digest('hex').slice(0, 16);
}

export type ErrorSeverity = 'error' | 'critical';

export interface RecordableError {
  readonly message: string;
  readonly route?: string;
  readonly statusCode?: number;
  readonly severity?: ErrorSeverity;
}

/** Long enough to identify a failure, short enough not to be a log. */
const MAX_MESSAGE = 500;

@Injectable()
export class ErrorRecorder {
  readonly #logger = new Logger(ErrorRecorder.name);
  /**
   * Set while a recording attempt is in flight.
   *
   * If the database is the thing that is broken, recording an error will throw,
   * and the natural place to report THAT is here — which is a loop that ends
   * in a stack overflow during the exact outage it was meant to document.
   */
  #recording = false;

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Record a failure. Never throws, never rejects.
   *
   * The caller is usually an exception filter that is already handling
   * something; giving it a second failure to handle is not help.
   */
  async record(error: RecordableError): Promise<void> {
    if (this.#recording) return;

    this.#recording = true;
    try {
      const fingerprint = fingerprintOf({ message: error.message, ...(error.route === undefined ? {} : { route: error.route }) });

      await this.pool.query(`SELECT record_error($1, $2::error_severity, $3, $4, $5)`, [
        fingerprint,
        error.severity ?? 'error',
        truncate(error.message),
        error.route ?? null,
        error.statusCode ?? null,
      ]);
    } catch (cause) {
      // Logged and dropped. There is nowhere else for this to go, and the one
      // thing it must not do is propagate.
      this.#logger.error(
        `could not record an error: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    } finally {
      this.#recording = false;
    }
  }

  /** The operations dashboard's list. */
  async open(limit = 50): Promise<readonly Record<string, unknown>[]> {
    const result = await this.pool.query(
      `SELECT fingerprint, severity::text AS severity, message, route, status_code,
              occurrences::text AS occurrences, first_seen_at, last_seen_at, alerted_at
         FROM errors_open LIMIT $1`,
      [limit],
    );
    return result.rows as Record<string, unknown>[];
  }

  /** Marks a fingerprint dealt with. A recurrence reopens it — see
   *  `record_error`, which clears `resolved_at` on every new occurrence. */
  async resolve(fingerprint: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE error_events SET resolved_at = now()
        WHERE fingerprint = $1 AND resolved_at IS NULL`,
      [fingerprint],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function truncate(message: string): string {
  return message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE - 3)}...` : message;
}
