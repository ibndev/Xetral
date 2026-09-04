import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECKLIST, silentMisses, singleInstanceWorkers } from './go-live-checklist.js';

/**
 * THE CHECKLIST CANNOT DRIFT FROM THE SYSTEM IT DESCRIBES.
 *
 * A go-live list is exactly the artifact whose gaps are invisible. It is
 * written once, it reads as complete, and it stays trusted while the code
 * underneath it grows a tenth worker interval and a fifty-fifth setting. The
 * six "an operator must" paragraphs this file replaces were each correct on
 * the day they were written; what none of them could do is notice a
 * seventh.
 *
 * So this compares the checklist against the code IN BOTH DIRECTIONS, the same
 * shape as `route-coverage.test.ts` and `retention_coverage`:
 *
 *   - a variable `config.ts` reads that the checklist does not name is a
 *     prerequisite nobody has written down;
 *   - a checklist entry naming something that no longer exists is worse,
 *     because an operator following it is being told to set a variable that
 *     does nothing, and will reasonably conclude the rest is stale too.
 *
 * It reads the sources AS TEXT rather than importing them, for the reason
 * `retention-table.test.ts` does: the files are what a reviewer reads in a
 * diff, and nothing here should need a database to check a list.
 */
const HERE = new URL('.', import.meta.url).pathname;
const read = (p: string): string => readFileSync(join(HERE, p), 'utf8');

const CONFIG = read('../config.ts');
const CREDENTIAL_SEED = read(
  '../../../../packages/ledger/sql/026_provider_credentials.seed.sql',
);

/**
 * EVERY migration, because the settings are not in one file.
 *
 * The obvious reader here scanned `009_admin.seed.sql` and found nineteen
 * keys, which looked plausible and is a third of them: fourteen migrations
 * seed a `platform_settings` row, from 009 through 037. That spread is
 * exactly why nobody had a complete list to begin with, and reading one file
 * would have reproduced the problem inside the test meant to prevent it.
 */
const MIGRATIONS: readonly string[] = ['ledger', 'identity'].flatMap((pkg) => {
  const dir = join(HERE, `../../../../packages/${pkg}/sql`);
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql') && !f.endsWith('.test.sql'))
    .map((f) => readFileSync(join(dir, f), 'utf8'));
});

const named = (kind: string): Set<string> =>
  new Set(CHECKLIST.filter((i) => i.kind === kind).map((i) => i.name));

/**
 * Every environment variable `config.ts` reads.
 *
 * `PORT` is deliberately absent: it is read in `main.ts` by the process rather
 * than parsed as configuration, and it is set by whatever runs the container.
 */
function environmentVariables(): Set<string> {
  const found = new Set<string>();
  for (const match of CONFIG.matchAll(/env(?:,\s*|\[)'([A-Z][A-Z_0-9]{2,})'/g)) {
    found.add(match[1] as string);
  }
  // Built by interpolation, one per chain, so no literal appears in the file.
  // The checklist names the family; this is the one place that mapping lives.
  if (/CRYPTO_CONFIRMATIONS_\$\{/.test(CONFIG)) found.add('CRYPTO_CONFIRMATIONS_*');
  return found;
}

/** Every `platform_settings` key any migration inserts. */
function settingKeys(): Set<string> {
  const found = new Set<string>();
  for (const sql of MIGRATIONS) {
    // Scoped to the INSERT, because the same files seed risk thresholds,
    // consent documents and KYC tiers, and an unscoped `('key',` would sweep
    // those in as settings that do not exist.
    //
    // The region ends at the NEXT statement, not at the next semicolon. The
    // first reader here stopped at `;`, and one setting's description contains
    // the words "product; every payout is approved by a human" — so it found
    // thirty-two of fifty-four keys and reported the other twenty-two as
    // settings that had been removed. A confident wrong answer, from prose.
    for (const statement of sql.matchAll(
      /INSERT INTO platform_settings[\s\S]*?(?=\nINSERT INTO |\nCOMMIT|$)/g,
    )) {
      // Anchored to the start of a line: every tuple in these files begins
      // one, and parentheses appear inside the descriptions.
      for (const row of (statement[0] as string).matchAll(
        /^\s*\('([a-z][a-z_0-9]+)'\s*,/gm,
      )) {
        found.add(row[1] as string);
      }
    }
  }
  return found;
}

/**
 * Every credential slot, as `provider.name`, from EVERY migration.
 *
 * It read 026's seed alone, which was true when 026 was the only file that
 * wrote this table and stopped being true the moment a later migration added
 * one: 042 added both Bitnob v2 credentials, 044 added Paystack's, 048 added
 * Brevo's, and NONE of the four was visible to this guard in either
 * direction. So the two secrets that authorise every Bitnob call and the one
 * that authorises the DEFAULT naira funding rail were simply absent from the
 * checklist an operator works through before taking money.
 *
 * That is the `settingKeys()` lesson exactly — nineteen keys of fifty-four,
 * from reading one file — repeated one function further down.
 *
 * Scoped to the INSERT for the reason that one is: these files are full of
 * parenthesised prose, and an unscoped tuple match sweeps in sentences.
 */
function credentialSlots(): Set<string> {
  const found = new Set<string>();
  for (const sql of MIGRATIONS) {
    for (const statement of sql.matchAll(
      /INSERT INTO provider_credential_slots[\s\S]*?(?=\nINSERT INTO |\nUPDATE |\nCOMMIT|$)/g,
    )) {
      for (const row of (statement[0] as string).matchAll(
        /^\s*\('([a-z]+)'\s*,\s*'([a-z_]+)'\s*,/gm,
      )) {
        found.add(`${row[1] as string}.${row[2] as string}`);
      }
    }
  }
  return found;
}

describe('the go-live checklist covers what the system actually needs', () => {
  it('finds the sources it is meant to be checking', () => {
    // Guards the readers themselves. A moved file would otherwise make every
    // assertion below pass against an empty string — the failure mode this
    // whole file exists to prevent, one level up.
    expect(CONFIG).toContain("required(env, 'DATABASE_URL')");
    expect(CREDENTIAL_SEED).toContain('provider_credential_slots');
    // A slot from a MIGRATION rather than from the seed, so the reader above
    // cannot narrow back to one file and still pass. 044 adds this one;
    // 026's seed has never mentioned Paystack.
    expect(credentialSlots()).toContain('paystack.secret_key');
    expect(MIGRATIONS.length).toBeGreaterThan(30);
    expect(MIGRATIONS.filter((s) => s.includes('INSERT INTO platform_settings')).length)
      .toBeGreaterThan(10);

    expect(environmentVariables().size).toBeGreaterThan(40);
    expect(settingKeys().size).toBeGreaterThan(40);
    expect(credentialSlots().size).toBeGreaterThan(8);
  });

  it('names every environment variable the API reads', () => {
    const missing = [...environmentVariables()].filter((v) => !named('env').has(v)).sort();
    expect(
      missing,
      `config.ts reads these and the checklist does not name them:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('names no environment variable the API no longer reads', () => {
    const surplus = [...named('env')].filter((v) => !environmentVariables().has(v)).sort();
    expect(
      surplus,
      `the checklist names these and config.ts does not read them:\n  ${surplus.join('\n  ')}`,
    ).toEqual([]);
  });

  it('names every platform setting, and no setting that has gone', () => {
    const keys = settingKeys();
    const missing = [...keys].filter((k) => !named('setting').has(k)).sort();
    const surplus = [...named('setting')].filter((k) => !keys.has(k)).sort();
    expect(missing, `settings the checklist does not name:\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
    expect(surplus, `settings that no longer exist:\n  ${surplus.join('\n  ')}`).toEqual([]);
  });

  it('names every credential slot, and no slot that has gone', () => {
    const slots = credentialSlots();
    const missing = [...slots].filter((s) => !named('credential').has(s)).sort();
    const surplus = [...named('credential')].filter((s) => !slots.has(s)).sort();
    expect(missing, `slots the checklist does not name:\n  ${missing.join('\n  ')}`).toEqual([]);
    expect(surplus, `slots that no longer exist:\n  ${surplus.join('\n  ')}`).toEqual([]);
  });
});

describe('the checklist says something useful about each entry', () => {
  it('has no duplicate names', () => {
    // Two entries for one variable means one of them is the stale opinion, and
    // an operator has no way to tell which.
    const seen = new Map<string, number>();
    for (const item of CHECKLIST) seen.set(item.name, (seen.get(item.name) ?? 0) + 1);
    const repeated = [...seen].filter(([, n]) => n > 1).map(([name]) => name);
    expect(repeated).toEqual([]);
  });

  it('states a CONSEQUENCE, not a restatement of the name', () => {
    // The failure this guards is an entry reading "notifications are not
    // configured" — true, unhelpful, and indistinguishable from an entry
    // somebody thought about. Length is a crude proxy and it is the same one
    // `attention_sources` uses for its rationale, for the same reason.
    for (const item of CHECKLIST) {
      expect(item.ifMissed.length, `${item.name} says too little`).toBeGreaterThan(30);
    }
  });

  it('marks every worker interval as single-instance', () => {
    // The rule is in `docker-compose.app.yml` and in three phase documents.
    // Here it is a property of the row, so a worker added later cannot be
    // documented as though it were safe to run everywhere.
    const intervals = CHECKLIST.filter(
      (i) => i.name.endsWith('_INTERVAL_SECONDS') && i.kind === 'env',
    );
    expect(intervals.length).toBeGreaterThan(8);
    const unmarked = intervals.filter((i) => i.singleInstance !== true).map((i) => i.name);
    expect(
      unmarked,
      `these schedule a worker and are not marked single-instance:\n  ${unmarked.join('\n  ')}`,
    ).toEqual([]);
  });

  it('still knows which misses are silent', () => {
    // The category that justifies the document. If this ever emptied, either
    // the silent failures had been fixed — worth celebrating and worth
    // noticing — or somebody had reclassified them away.
    expect(silentMisses().length).toBeGreaterThan(8);
    expect(singleInstanceWorkers().length).toBeGreaterThan(8);

    // The one the deployment guide singles out, asserted by name because it is
    // the miss that leaves a locked-out customer waiting on an email that will
    // never be sent.
    expect(silentMisses().map((i) => i.name)).toContain('NOTIFICATION_INTERVAL_SECONDS');
  });
});
