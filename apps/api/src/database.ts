import pg from 'pg';
import type { Pool } from 'pg';
import type { ApiConfig } from './config.js';

/**
 * `pg` is CommonJS and does not provide named ESM exports, so the default
 * import is destructured rather than `import { Pool }`. The latter compiles and
 * fails at runtime with "Pool is not a constructor", which is a confusing five
 * minutes the first time.
 */
const { Pool: PgPool } = pg;

/**
 * BIGINT (OID 20) arrives as a string by default, and that default is correct
 * here — Postgres BIGINT exceeds what a JS number represents exactly, and the
 * ids in this schema are BIGINT. Left as numbers they would be silently wrong
 * above 2^53. Every id in this app is therefore a string, and stays one.
 *
 * This is the same reasoning that makes money `bigint` in @xetral/shared.
 */
export function createPool(config: ApiConfig): Pool {
  return new PgPool({
    connectionString: config.databaseUrl,
    // A bounded pool so a burst cannot open more connections than Postgres
    // will accept; exceeding max_connections takes the whole database down for
    // every client, not just the one that overshot.
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}
