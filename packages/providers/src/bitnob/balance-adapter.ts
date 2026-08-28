import { z } from 'zod';
import type { Currency, Money } from '@xetral/shared';
import { CURRENCIES } from '@xetral/shared';
import type { ProviderBalancePort } from '../ports/balances.js';
import { ProviderContractError } from '../ports/errors.js';
import { BITNOB_ENDPOINTS, type BitnobClient } from './client.js';

/**
 * What Bitnob says it holds for us, per currency.
 *
 * ENDPOINT VERIFIED against their own Node SDK (npm `bitnob`, `lib/wallet.ts`):
 * `walletDetails()` is `GET /wallets`. The header comment on every constant in
 * this package says which SDK or document it came from, because each one that
 * was a plausible guess turned out to be wrong.
 *
 * THE RESPONSE SHAPE IS NOT SETTLED, and this adapter is written on that
 * assumption rather than against it. Their SDK returns the raw JSON and
 * declares no type, so the parser accepts the two shapes a wallets endpoint
 * plausibly returns — a single object, or a list — and reads a balance in
 * either minor units or a major-unit string. Being tolerant on a READ costs
 * nothing; being wrong costs the only check that can see money we never
 * recorded. The same lesson the card response shape taught.
 */

/** Bitnob expresses USD in micro-units on webhooks. A balance is read the same
 *  way when it arrives as an integer — see `amounts.ts` for the one conversion
 *  boundary this mirrors. */
const balanceEntry = z.object({
  currency: z.string().optional(),
  /** Minor units, as an integer or a numeric string. */
  balance: z.union([z.number(), z.string()]).optional(),
  balanceInMinorUnits: z.union([z.number(), z.string()]).optional(),
  /** Some payloads name it this way. */
  availableBalance: z.union([z.number(), z.string()]).optional(),
});

const walletsResponse = z.union([
  z.object({ data: z.array(balanceEntry) }),
  z.object({ data: balanceEntry }),
  z.array(balanceEntry),
  balanceEntry,
]);

function entriesOf(parsed: z.infer<typeof walletsResponse>): readonly z.infer<typeof balanceEntry>[] {
  if (Array.isArray(parsed)) return parsed;
  if ('data' in parsed) return Array.isArray(parsed.data) ? parsed.data : [parsed.data];
  return [parsed];
}

/**
 * A balance as an integer of minor units.
 *
 * REFUSES a JSON number beyond `MAX_SAFE_INTEGER` rather than coercing it, the
 * same rule `parseMicro` follows: by the time `JSON.parse` has rounded it the
 * lost unit is unrecoverable, and this value exists precisely to be compared to
 * the last unit.
 */
function minorUnitsOf(raw: number | string | undefined): bigint | undefined {
  if (raw === undefined) return undefined;

  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new ProviderContractError(
        'bitnob',
        `wallet balance ${raw} is not a safe integer; ask Bitnob for a string`,
      );
    }
    return BigInt(raw);
  }

  const text = raw.trim();
  if (!/^-?[0-9]+$/.test(text)) {
    throw new ProviderContractError('bitnob', `wallet balance '${raw}' is not an integer`);
  }
  return BigInt(text);
}

export class BitnobBalanceAdapter implements ProviderBalancePort {
  readonly provider = 'bitnob';

  constructor(private readonly client: BitnobClient) {}

  async floatBalances(): Promise<readonly Money<Currency>[]> {
    const raw = await this.client.request('GET', BITNOB_ENDPOINTS.wallets);

    const parsed = walletsResponse.safeParse(raw);
    if (!parsed.success) {
      throw new ProviderContractError('bitnob', 'unexpected shape from GET /wallets');
    }

    const balances: Money<Currency>[] = [];
    for (const entry of entriesOf(parsed.data)) {
      const code = entry.currency?.toUpperCase();
      // A currency we do not model is SKIPPED, not guessed at. Bitnob holds
      // assets this platform does not offer, and inventing an exponent for one
      // would produce a comparison in units nobody chose.
      if (code === undefined || !(code in CURRENCIES)) continue;

      const amount =
        minorUnitsOf(entry.balanceInMinorUnits) ??
        minorUnitsOf(entry.balance) ??
        minorUnitsOf(entry.availableBalance);
      if (amount === undefined) continue;

      balances.push({ amount, currency: code as Currency } as Money<Currency>);
    }

    return balances;
  }
}
