/**
 * Ask Bitnob's sandbox what is actually true.
 *
 * WHY THIS EXISTS, and why its first run would have been worth everything.
 * Every constant in `packages/providers/src/bitnob/` was verified against
 * Bitnob's own Node SDK, which was the best evidence available without a live
 * call. It has now been wrong FOUR times: the webhook hash was SHA-256 on the
 * strength of "everyone uses SHA-256"; every card path was a plausible REST
 * guess; the card response shape required three fields the SDK does not send;
 * and then Bitnob retired the whole v1 surface the SDK describes, along with
 * the bearer token it authenticates with — so the SDK on npm became a correct
 * description of an API that no longer answers.
 *
 * Each of those passed its tests, because the tests were written from the
 * same assumptions as the code. A stub cannot catch that. Only the provider
 * can. This script asks, and had it ever been RUN it would have said so.
 *
 * IT IS READ-ONLY, enforced by construction rather than by intention: the
 * table below contains only GETs and `request()` refuses any other method. A
 * verification script that could issue a POST is one that could issue a POST
 * against production credentials by accident.
 *
 * THE SECRET IS NEVER PRINTED, never written to a file, and never included in
 * the report — and under v2 it is never transmitted either. It signs.
 *
 *   BITNOB_CLIENT_ID=… BITNOB_CLIENT_SECRET=… node scripts/verify-bitnob-sandbox.mjs
 */
import { writeFileSync } from 'node:fs';

import { createHmac, randomBytes } from 'node:crypto';

const BASE = (process.env.BITNOB_BASE_URL ?? 'https://api.bitnob.com').replace(/\/+$/, '');
const CLIENT_ID = process.env.BITNOB_CLIENT_ID;
const CLIENT_SECRET = process.env.BITNOB_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'BITNOB_CLIENT_ID and BITNOB_CLIENT_SECRET must both be set. Bitnob v2 ' +
      'signs each request rather than bearing a token, so the old ' +
      'BITNOB_API_KEY cannot be used here.',
  );
  process.exit(2);
}

/*
 * THE HOST CAN NO LONGER TELL US WHICH ENVIRONMENT THIS IS.
 *
 * This script used to refuse any base URL without "sandbox" in it, which was
 * right when Bitnob had two hosts. v2 has one — sandbox and production are
 * the same address and the SECRET selects between them — so that check would
 * now refuse every correct configuration while catching nothing.
 *
 * So the environment is the FIRST PROBE, below, and a `live` answer aborts
 * before any other path is touched. That is a stronger guarantee than the
 * string test ever gave: it asks the provider rather than pattern-matching a
 * URL somebody typed.
 */

/**
 * Every path this script will touch. GET only — see the header.
 *
 * `source` says WHERE each path came from, and after this round that column
 * carries a date as well as a citation: a correct constant decays, and
 * "verified against the vendor's SDK" is a claim about the day it was made.
 */
const PROBES = [
  { name: 'whoami',           path: '/api/whoami',           source: 'stealthdocs api-reference/authentication (2026-09)' },
  { name: 'balances',         path: '/api/balances',         source: 'stealthdocs docs.json (2026-09)' },
  { name: 'transactions',     path: '/api/transactions',     source: 'stealthdocs docs.json (2026-09)' },
  { name: 'cards',            path: '/api/cards',            source: 'stealthdocs docs/card-issuing (2026-09)' },
  { name: 'customers',        path: '/api/customers',        source: 'stealthdocs docs.json (2026-09)' },
  { name: 'addresses',        path: '/api/addresses',        source: 'stealthdocs docs/stablecoins (2026-09)' },
  { name: 'virtual_accounts', path: '/api/virtual-accounts', source: 'stealthdocs docs/virtual-accounts (2026-09)' },
  { name: 'trading_prices',   path: '/api/trading/prices',   source: 'stealthdocs docs/trading (2026-09)' },
  { name: 'payout_banks_ng',  path: '/api/payouts/banks/NG', source: 'stealthdocs docs/payouts (2026-09)' },
];

/**
 * The four headers, built here rather than imported.
 *
 * Deliberately a SECOND implementation of the same scheme. If this script
 * imported `signing.ts` it would agree with the adapter by construction, and
 * a shared mistake would look like a passing verification — which is the
 * exact failure mode ("the tests agreed with the code because the same person
 * wrote both") that this whole script exists to break.
 *
 * A GET signs the empty string.
 */
function signedHeaders(payload) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomBytes(16).toString('hex');
  return {
    'x-auth-client': CLIENT_ID,
    'x-auth-timestamp': timestamp,
    'x-auth-nonce': nonce,
    'x-auth-signature': createHmac('sha256', CLIENT_SECRET)
      .update(`${CLIENT_ID}:${timestamp}:${nonce}:${payload}`, 'utf8')
      .digest('hex'),
  };
}

async function request(path) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(`${BASE}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { ...signedHeaders(''), 'content-type': 'application/json' },
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

/*
 * THE ENVIRONMENT CHECK, BEFORE ANY OTHER PATH IS TOUCHED.
 *
 * Also the clearest possible signal that signing works at all: a 401 here
 * means the signature, the timestamp or the client id is wrong, and their
 * docs name exactly those three.
 */
const identity = await request('/api/whoami');
if (identity.status === 401) {
  console.error(
    'GET /api/whoami answered 401. The signature did not verify. Check that ' +
      'the timestamp is in SECONDS rather than milliseconds, that the nonce ' +
      'is hex, and that the client id matches the secret.',
  );
  process.exit(2);
}
const environment = identity.body?.data?.environment;
if (environment !== 'sandbox') {
  console.error(
    `refusing to run: /api/whoami reports environment ${JSON.stringify(environment)}. ` +
      'This script is for the SANDBOX only — a read-only script against ' +
      'production is still an authenticated call into a system holding ' +
      'customer money. Use the sandbox BITNOB_CLIENT_SECRET.',
  );
  process.exit(2);
}
console.log('OK   200  GET /api/whoami  (environment: sandbox)\n');

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
