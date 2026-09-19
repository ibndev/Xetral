#!/usr/bin/env node
/**
 * Probe a real Flutterwave key, and check this repo's constants against it.
 *
 * WHY THIS EXISTS, and why it is the first thing to run before Ghana or Kenya
 * takes a real payment. Every endpoint, field name and vocabulary in
 * `packages/providers/src/flutterwave/` was written from Flutterwave's
 * published v3 API in September 2026. That is a source AND a date, and this
 * repo has now been bitten twice by a table of plausible constants that
 * passed every test written from the same assumptions and failed on the first
 * live call — Bitnob's card paths, and its webhook hash.
 *
 *   FLUTTERWAVE_SECRET_KEY=FLWSECK_TEST-... node scripts/verify-flutterwave-sandbox.mjs
 *
 * IT MOVES NO MONEY. Every probe is a read, or a checkout initialise that is
 * never paid — the two things that can be asked of a test key without leaving
 * anything behind. There is deliberately no transfer probe: a verification
 * with a side effect is one somebody has to reconcile afterwards.
 *
 * WHAT THE FIRST REAL RUN FOUND, and both halves are worth recording.
 *
 *   THE CHECKOUT PROBE HAD NEVER WORKED. `POST /v3/payments` answered
 *   `400 "One or more required parameters missing"` — which names no
 *   parameter — because the body carried no `redirect_url`. The same request
 *   with one answers 200 and a checkout link. So the probe that exists to
 *   prove money can come in had been failing on the script's own body, and
 *   the script reported it as the API being wrong.
 *
 *   AND IT CALLED THREE PROBES FAILURES THAT WERE CORRECT ANSWERS. It found
 *   the Ghanaian telcos by matching their NAMES and then asked each for its
 *   branches, and all three answered `404 "No branches found for specified
 *   bank id"`. A wallet has no branches; that IS the answer. The script
 *   counted three provider-contract failures and told an operator the
 *   constants in `packages/providers/src/flutterwave` were wrong, about an
 *   integration behaving exactly as the adapter already assumes — it fills in
 *   `destination_branch_code` only where EXACTLY ONE branch comes back, so
 *   none changes nothing.
 *
 * A VERIFICATION SCRIPT THAT REPORTS FALSE FAILURES IS THE ONE PEOPLE LEARN
 * TO SKIP, which is the same argument this repo makes about a generic ruleset
 * and about an alert that fires on every declined card. So the decisions are
 * now in `flutterwave-verify.mjs` with a test beside them, and the summary
 * separates four things that were one number: what passed, whether the
 * checkout initialised, what legitimately has no branches, and what actually
 * went wrong.
 */
import {
  branchCodeForTransfer,
  branchSupportFromListing,
  checkoutPayload,
  classifyBranchResponse,
  summarise,
} from './flutterwave-verify.mjs';

const KEY = process.env['FLUTTERWAVE_SECRET_KEY'];
const BASE = process.env['FLUTTERWAVE_BASE_URL'] ?? 'https://api.flutterwave.com';

if (KEY === undefined || KEY === '') {
  console.error('set FLUTTERWAVE_SECRET_KEY (a TEST key — FLWSECK_TEST-...)');
  process.exit(2);
}
if (!KEY.includes('TEST')) {
  // A live key here would issue a real checkout link against real money. The
  // refusal is the same shape as the staging guard in `config.ts`.
  console.error('that does not look like a TEST key. Refusing to probe with a live one.');
  process.exit(2);
}

let passed = 0;
let failed = 0;
/** Institutions that answered "no branches", which is not a failure. */
const noBranches = [];

/** One request, returning the status and the parsed body — never throwing. */
async function call(method, path, body) {
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    try {
      return { httpStatus: response.status, payload: JSON.parse(text) };
    } catch {
      return { httpStatus: response.status, payload: undefined, raw: text };
    }
  } catch (error) {
    return {
      httpStatus: 0,
      payload: undefined,
      raw: error instanceof Error ? error.message : String(error),
    };
  }
}

async function probe(name, method, path, body) {
  process.stdout.write(`${name} … `);
  const { httpStatus, payload, raw } = await call(method, path, body);

  if (payload === undefined) {
    console.log(`FAIL — ${String(httpStatus)}, and the body is not JSON: ${String(raw).slice(0, 120)}`);
    failed += 1;
    return undefined;
  }
  /*
   * THE ENVELOPE IS A STRING, NOT A BOOLEAN — the single most likely way a
   * refusal is recorded as a success in this adapter, because the Paystack
   * client one directory away tests `status === false` and every non-empty
   * string is truthy.
   */
  if (payload.status !== 'success') {
    console.log(`FAIL — ${String(httpStatus)} ${JSON.stringify(payload.message ?? payload)}`);
    failed += 1;
    return undefined;
  }
  console.log('ok');
  passed += 1;
  return payload.data;
}

// 1. The key is accepted at all, and the path shape is right. `/v3` is on the
//    PATH, not on the base URL — a base ending in /v3 gives /v3/v3/banks/GH,
//    which is the doubling 042 records about Bitnob.
const ghanaBanks = await probe('GET /v3/banks/GH', 'GET', '/v3/banks/GH');

// 2. The hosted checkout, in cedis, WITH a redirect URL — see the header.
process.stdout.write('POST /v3/payments (GHS, major units, redirect_url) … ');
const checkoutCall = await call('POST', '/v3/payments', checkoutPayload());
let checkout;
if (checkoutCall.payload?.status === 'success' && checkoutCall.payload.data?.link !== undefined) {
  checkout = { ok: true, link: checkoutCall.payload.data.link };
  passed += 1;
  console.log('ok');
} else {
  const detail =
    checkoutCall.payload?.message ?? `HTTP ${String(checkoutCall.httpStatus)}`;
  checkout = { ok: false, detail };
  failed += 1;
  console.log(`FAIL — ${String(checkoutCall.httpStatus)} ${JSON.stringify(detail)}`);
  if (/required parameters missing/i.test(String(detail))) {
    console.log(
      '    That message names no parameter. It is what /v3/payments answers ' +
        'with no redirect_url — check checkoutPayload() in flutterwave-verify.mjs.',
    );
  }
}

// 3. Verifying by OUR reference rather than by their id — the call the whole
//    settle path depends on. A reference nobody paid must REFUSE rather than
//    answering a zero-amount success.
process.stdout.write('GET /v3/transactions/verify_by_reference (unknown ref) … ');
const unknown = await call(
  'GET',
  '/v3/transactions/verify_by_reference?tx_ref=xetral-does-not-exist',
);
if (unknown.payload?.status === 'success') {
  console.log('FAIL — an unknown reference answered success; settle would credit nothing safely');
  failed += 1;
} else {
  console.log(`ok (refused: ${String(unknown.payload?.message ?? unknown.httpStatus)})`);
  passed += 1;
}

/*
 * 4. THE TRANSFER CONTRACT — what the transfer is BUILT from, read rather
 *    than assumed, and still without sending anything.
 *
 *    WHICH `account_bank` a wallet transfer takes is the thing this repo held
 *    as `MTN`, `VOD`, `ATL` and `MPS` — constants no vendor document
 *    produces. The adapter reads them out of THEIR OWN list now, and this
 *    prints what that list says so an operator can see it.
 *
 *    BOTH CORRIDORS, because probing Ghana alone is the same shape as the bug
 *    it exists to catch: the first version of the adapter's fix read a
 *    Ghana-only table, so cedis were repaired and shillings went on sending
 *    an unsourced `MPS` with nothing failing.
 *
 *    The hints mirror `NETWORK_NAME_HINTS` in the adapter and are used ONLY
 *    to decide what to print. They no longer decide whether to call the
 *    branches endpoint — the listing's own fields do that, and where the
 *    listing is silent the endpoint is asked and its answer believed.
 */
const CORRIDORS = [
  {
    iso: 'GH',
    name: 'Ghana',
    banks: ghanaBanks,
    hints: ['MTN', 'VODAFONE', 'TELECEL', 'AIRTELTIGO', 'TIGO', 'AIRTEL'],
    ours: 'MTN/VOD/ATL',
  },
  {
    iso: 'KE',
    name: 'Kenya',
    banks: undefined,
    hints: ['M-PESA', 'MPESA', 'SAFARICOM'],
    ours: 'MPS',
  },
];

for (const corridor of CORRIDORS) {
  const list =
    corridor.banks ??
    (await probe(`GET /v3/banks/${corridor.iso}`, 'GET', `/v3/banks/${corridor.iso}`));
  if (!Array.isArray(list)) continue;

  const telcos = list.filter((b) =>
    corridor.hints.some((hint) => String(b?.name ?? '').toUpperCase().includes(hint)),
  );
  console.log('');
  console.log(`${corridor.name} list: ${list.length} entries, ${telcos.length} look like a telco.`);
  if (telcos.length === 0) {
    console.log(
      `FAIL — no mobile money network is in Flutterwave's ${corridor.name} list. The ` +
        `adapter falls back to ${corridor.ours}, which nothing here sources from ` +
        'Flutterwave. Ask their support for the account_bank values a wallet transfer ' +
        `takes in ${corridor.name}.`,
    );
    failed += 1;
  }

  for (const telco of telcos) {
    console.log(`  account_bank=${String(telco.code)}  id=${String(telco.id)}  ${String(telco.name)}`);
    if (telco?.id === undefined) continue;

    /*
     * ASK THE LISTING FIRST. Where it states whether this institution has
     * branches, that is their answer and there is nothing to probe.
     */
    const stated = branchSupportFromListing(telco);
    if (stated.known && !stated.supported) {
      console.log(`    no branches — the list says so (${stated.field}); not asking`);
      noBranches.push(`${corridor.name}/${String(telco.name)}`);
      continue;
    }

    process.stdout.write(`    GET /v3/banks/${String(telco.id)}/branches … `);
    const branchCall = await call('GET', `/v3/banks/${String(telco.id)}/branches`);
    const verdict = classifyBranchResponse(branchCall);

    if (verdict.kind === 'branches') {
      passed += 1;
      const code = branchCodeForTransfer(verdict.branches);
      console.log(
        code === undefined
          ? `${String(verdict.branches.length)} branches — the adapter sends NONE, because choosing would be inventing one`
          : `1 branch — the adapter sends destination_branch_code=${String(code)}`,
      );
    } else if (verdict.kind === 'none') {
      /*
       * NOT A FAILURE, and this is the whole correction. A wallet has no
       * branch; the adapter fills in `destination_branch_code` only where
       * exactly one comes back, so this changes nothing about what it sends.
       */
      console.log(`no branches (expected) — ${String(verdict.reason)}`);
      noBranches.push(`${corridor.name}/${String(telco.name)}`);
    } else {
      console.log(`FAIL — ${String(verdict.detail)}`);
      failed += 1;
    }
  }
}

console.log('');
const { lines, exitCode } = summarise({ passed, failed, checkout, noBranches });
for (const line of lines) console.log(line);
if (checkout?.ok) {
  console.log('Open the link and confirm the amount reads 1.00 cedi, NOT 100 or 0.01.');
}
process.exit(exitCode);
