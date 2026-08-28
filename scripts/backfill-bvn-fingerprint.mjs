#!/usr/bin/env node
/**
 * Fills `kyc_submissions.bvn_fingerprint` for rows that have none, and
 * rewrites every row when the blind index key is rotated.
 *
 * WHY A SCRIPT AND NOT A MIGRATION. The BVNs are sealed with an AES-GCM
 * envelope and only the application holds the keys, so no amount of SQL can
 * compute the fingerprints. `025_bvn_uniqueness.sql` therefore REFUSES to
 * apply to a database that already holds submissions, naming this file — a
 * refusal costs a deploy, and the alternative is a nullable column, which is
 * the silent-off failure: one submission written without a fingerprint slips
 * past `kyc_one_approved_per_bvn` and nothing anywhere fails.
 *
 * ROTATION. A blind index cannot have two live keys — matching requires
 * exactly one — so changing `KYC_BLIND_INDEX_KEY` means recomputing every
 * fingerprint. Until that finishes the table holds two populations that cannot
 * see each other, and the uniqueness rule cannot see across the boundary.
 * `kyc_blind_index_versions` reports more than one version while that is true,
 * and the invariant suite fails on it.
 *
 * Run with the same environment the API runs with:
 *
 *   DATABASE_URL=... ENCRYPTION_KEYS=... ENCRYPTION_CURRENT_VERSION=... \
 *   KYC_BLIND_INDEX_KEY=v1:... node scripts/backfill-bvn-fingerprint.mjs [--all]
 *
 * Without `--all` it fills only the rows that have none. With it, every row is
 * rewritten — which is what a rotation needs.
 *
 * IT NEVER PRINTS A BVN, and never writes one anywhere. The plaintext exists
 * for the length of one HMAC and is not logged, not counted by value, and not
 * included in the summary.
 */
import { createHmac, createDecipheriv } from 'node:crypto';
import { Buffer } from 'node:buffer';
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL;
const KEY = process.env.KYC_BLIND_INDEX_KEY;
const KEYS = process.env.ENCRYPTION_KEYS;

function die(message) {
  console.error(`backfill-bvn-fingerprint: ${message}`);
  process.exit(1);
}

if (!DATABASE_URL) die('DATABASE_URL is not set');
if (!KEY) die('KYC_BLIND_INDEX_KEY is not set');
if (!KEYS) die('ENCRYPTION_KEYS is not set; the BVNs cannot be opened without it');

const separator = KEY.indexOf(':');
if (separator === -1) die(`KYC_BLIND_INDEX_KEY must look like 'v1:<base64>'`);
const indexVersion = KEY.slice(0, separator);
if (!/^v[0-9]+$/.test(indexVersion)) die(`KYC_BLIND_INDEX_KEY version must look like 'v1'`);
const indexKey = Buffer.from(KEY.slice(separator + 1), 'base64');
if (indexKey.length < 32) die('KYC_BLIND_INDEX_KEY must decode to at least 32 bytes');

/** Every key still able to open existing data, by version. */
const keyring = new Map();
for (const entry of KEYS.split(',')) {
  const trimmed = entry.trim();
  if (trimmed === '') continue;
  const at = trimmed.indexOf(':');
  if (at === -1) die(`ENCRYPTION_KEYS entries must look like 'v1:<base64>'`);
  keyring.set(trimmed.slice(0, at), Buffer.from(trimmed.slice(at + 1), 'base64'));
}

/** `v1:<iv>:<tag>:<ciphertext>`, each part base64url — the format `envelope.ts`
 *  writes. Reimplemented here rather than imported so this script runs against
 *  a built or an unbuilt tree; the format is asserted by envelope.test.ts. */
function open(envelope) {
  const parts = envelope.split(':');
  if (parts.length !== 4) throw new Error('malformed envelope');
  const [version, iv, tag, ciphertext] = parts;
  const key = keyring.get(version);
  if (key === undefined) throw new Error(`no key for ${version}`);

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(version, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return (
    decipher.update(Buffer.from(ciphertext, 'base64url'), undefined, 'utf8') +
    decipher.final('utf8')
  );
}

function fingerprint(value) {
  const normalised = value.replace(/\s+/g, '');
  if (normalised === '') throw new Error('refusing to fingerprint an empty value');
  const digest = createHmac('sha256', indexKey)
    .update(`${indexVersion}:${normalised}`, 'utf8')
    .digest('hex');
  return `${indexVersion}:${digest}`;
}

const all = process.argv.includes('--all');
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });

try {
  const rows = await pool.query(
    all
      ? `SELECT id, bvn_sealed FROM kyc_submissions ORDER BY id`
      : `SELECT id, bvn_sealed FROM kyc_submissions WHERE bvn_fingerprint IS NULL ORDER BY id`,
  );

  let written = 0;
  const failed = [];
  for (const row of rows.rows) {
    try {
      await pool.query(`UPDATE kyc_submissions SET bvn_fingerprint = $2 WHERE id = $1`, [
        row.id,
        fingerprint(open(row.bvn_sealed)),
      ]);
      written += 1;
    } catch (error) {
      // The ID, never the value. A row that cannot be opened is an operator
      // problem — a retired key, usually — and printing what is in it would
      // put a BVN in a terminal scrollback.
      failed.push(`${row.id}: ${error instanceof Error ? error.message : 'unknown'}`);
    }
  }

  console.log(`fingerprinted ${written} submission(s) under ${indexVersion}`);
  if (failed.length > 0) {
    console.error(`FAILED on ${failed.length} row(s):`);
    for (const line of failed) console.error(`  ${line}`);
    process.exitCode = 1;
  }

  const versions = await pool.query(`SELECT * FROM kyc_blind_index_versions`);
  if (versions.rows.length > 1) {
    // Said out loud, because while it is true two accounts on one BVN can both
    // be approved: the unique index cannot see across a version boundary.
    console.error(
      'MORE THAN ONE KEY VERSION IS IN USE. The duplicate-BVN rule is not ' +
        'enforced across the boundary until this is one. Re-run with --all.',
    );
    for (const row of versions.rows) {
      console.error(`  ${row.version}: ${row.submissions} submission(s)`);
    }
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
