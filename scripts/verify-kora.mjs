#!/usr/bin/env node
/**
 * Asks Kora, with YOUR key, the questions the adapter's constants rest on —
 * and moves no money. Every call here is a GET.
 *
 *   KORA_SECRET_KEY=sk_test_... node scripts/verify-kora.mjs
 *
 * Prints: whether the key authorises at all (the balance read), the Ghanaian
 * mobile money operators (the names `NETWORK_NAME_HINTS` must match and the
 * slugs a payout sends), and how many Nigerian and Kenyan banks the payout
 * list returns. The key is never printed.
 */
const key = process.env.KORA_SECRET_KEY;
const base = (process.env.KORA_BASE_URL ?? 'https://api.korapay.com/merchant').replace(/\/+$/, '');
if (!key) {
  console.error('set KORA_SECRET_KEY');
  process.exit(2);
}

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${key}` } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body };
}

let failed = false;
const report = (ok, what, detail) => {
  if (!ok) failed = true;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${what}${detail ? ` — ${detail}` : ''}`);
};

const balances = await get('/api/v1/balances');
report(
  balances.body?.status === true,
  'GET /api/v1/balances (the key authorises)',
  balances.body?.status === true
    ? Object.keys(balances.body.data ?? {}).join(', ')
    : `${balances.status} ${balances.body?.message ?? ''}`,
);

const operators = await get('/api/v1/misc/mobile-money?countryCode=GH');
report(operators.body?.status === true, 'GET /api/v1/misc/mobile-money?countryCode=GH');
for (const row of operators.body?.data ?? []) {
  console.log(`       ${row.name}  slug=${row.slug}  code=${row.code}  min=${row.min} max=${row.max}`);
}

for (const country of ['NG', 'KE']) {
  const banks = await get(`/api/v1/misc/banks?countryCode=${country}`);
  report(
    banks.body?.status === true,
    `GET /api/v1/misc/banks?countryCode=${country}`,
    `${(banks.body?.data ?? []).length} banks`,
  );
}

process.exit(failed ? 1 : 0);
