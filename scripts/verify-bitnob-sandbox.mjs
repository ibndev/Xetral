/**
 * Ask Bitnob's sandbox what is actually true.
 *
 * WHY THIS EXISTS. Every constant in `packages/providers/src/bitnob/` was
 * verified against Bitnob's own Node SDK, and that is the best evidence
 * available without a live call — but the SDK does not define the WEBHOOK EVENT
 * NAMES, and it says nothing about response SHAPES. Both have already been
 * wrong once: the webhook hash was SHA-256 on the strength of "everyone uses
 * SHA-256", every card path was a plausible REST guess, and the card response
 * shape required three fields the SDK does not send. Each passed its tests,
 * because the tests were written from the same assumptions as the code.
 *
 * A stub cannot catch that. Only the provider can. This script asks.
 *
 * IT IS READ-ONLY, and that is enforced by construction rather than by
 * intention: the request table below contains only GETs, and `request()`
 * refuses any other method. A verification script that could issue a POST is
 * one that could issue a POST against production credentials by accident.
 *
 * THE KEY IS NEVER PRINTED, never written to a file, and never included in the
 * report. It is read from BITNOB_API_KEY and used for the Authorization header
 * only.
 *
 *   BITNOB_API_KEY=… node scripts/verify-bitnob-sandbox.mjs
 *   BITNOB_API_KEY=… BITNOB_BASE_URL=https://sandboxapi.bitnob.co/api/v1 node …
 */
import { writeFileSync } from 'node:fs';

const BASE = (process.env.BITNOB_BASE_URL ?? 'https://sandboxapi.bitnob.co/api/v1').replace(/\/+$/, '');
const KEY = process.env.BITNOB_API_KEY;

if (!KEY) {
  console.error('BITNOB_API_KEY is not set. Nothing to verify.');
  process.exit(2);
}

/**
 * A live host refuses to run, whatever the key looks like.
 *
 * The mistake this prevents is the one the staging guard prevents at boot: a
 * person copying a production value to get something working quickly. A
 * read-only script against production is still an authenticated call into a
 * system holding customer money, and there is no reason to make one from here.
 */
if (!/sandbox/i.test(BASE)) {
  console.error(`refusing to run against ${BASE}: this script is for the SANDBOX only.`);
  process.exit(2);
}

/** Every path this script will touch. GET only — see the header. */
const PROBES = [
  { name: 'wallets',            path: '/wallets',            source: 'SDK lib/wallet.ts walletDetails()' },
  { name: 'transactions',       path: '/transactions',       source: 'SDK lib/wallet.ts listTransactions()' },
  { name: 'virtualcards',       path: '/virtualcards',       source: 'inferred; confirm' },
  { name: 'customers',          path: '/customers',          source: 'SDK lib/customer.ts' },
  { name: 'addresses',          path: '/addresses',          source: 'inferred; confirm' },
  { name: 'stablecoin_rates',   path: '/wallets/payout/rate', source: 'inferred; confirm' },
];

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    });
    const text = await response.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 400); }
    return { status: response.status, body };
  } catch (cause) {
    return { status: 0, body: String(cause?.message ?? cause) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The SHAPE of a response, without any of its values.
 *
 * Values are the thing that must not leave this script — a sandbox wallet still
 * has an id, and a customer record still has a name. The keys are what the
 * adapters parse and the only thing worth reporting.
 */
function shapeOf(value, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : [shapeOf(value[0], depth + 1)];
  if (value === null) return 'null';
  if (typeof value !== 'object') return typeof value;
  return Object.fromEntries(
    Object.keys(value).slice(0, 40).map((k) => [k, shapeOf(value[k], depth + 1)]),
  );
}

const findings = [];
for (const probe of PROBES) {
  const { status, body } = await request(probe.path);
  const ok = status >= 200 && status < 300;
  findings.push({
    name: probe.name,
    path: probe.path,
    source: probe.source,
    status,
    reachable: status !== 0,
    ok,
    // Keys only. Never values.
    shape: ok ? shapeOf(body) : undefined,
    error: ok ? undefined : (typeof body === 'object' ? shapeOf(body) : String(body).slice(0, 200)),
  });
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${String(status).padStart(3)}  GET ${probe.path}`);
}

const report = {
  base: BASE,
  checkedAt: new Date().toISOString(),
  // Deliberately absent: the key, and every value from every response.
  findings,
};
writeFileSync('bitnob-sandbox-report.json', JSON.stringify(report, null, 2));

console.log('\nwrote bitnob-sandbox-report.json (keys only — no values, no credential)');

// A path that answers 404 is a path in our endpoint table that does not exist,
// which is the exact failure this script is for. Non-zero so CI shows it.
const missing = findings.filter((f) => f.status === 404);
if (missing.length > 0) {
  console.error(`\n${missing.length} path(s) answered 404: ${missing.map((f) => f.path).join(', ')}`);
  process.exit(1);
}
