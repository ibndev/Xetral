import { describe, expect, it } from 'vitest';
import type { PayoutBank, PayoutPort } from '@xetral/providers';
import { SwitchingPayoutPort } from './payout-provider.js';

/**
 * WHERE A CUSTOMER'S SEND SCREEN GETS ITS LIST FROM.
 *
 * THE FAILURE THIS PINS. `payout_provider` is ONE NAME, and it said
 * `paystack` — so every payout question went to Paystack, including "what can
 * a customer in Accra send to?". Paystack answers that with GHANAIAN BANKS,
 * and in Ghana and Kenya money does not move to a bank account for most
 * people: it moves to a wallet on a phone number, whose code is a NETWORK
 * code no bank list contains.
 *
 * So the Send screen showed a customer in Accra a list of banks under a label
 * saying Mobile Money, and the Flutterwave payout adapter — written for
 * exactly this — was registered nowhere and asked nothing. 046 put
 * `payout_method` on the country so the SCREEN would stop offering a product
 * the customer's money cannot reach; this is the half that stops the SERVER
 * doing it.
 *
 * These are unit tests against fakes on purpose: the real thing needs two
 * provider accounts in two countries, and what has to be true is which
 * ADAPTER is asked, which is a routing decision this class makes alone.
 */
function fake(name: string, banks: readonly PayoutBank[]): PayoutPort {
  return {
    provider: name,
    banks: async () => banks,
    lookup: async (_c, bankCode, accountNumber) => ({
      accountNumber,
      bankCode,
      accountName: `${name} says who`,
    }),
    send: async () => ({ providerPayoutId: `${name}-1`, state: 'sent' }),
    status: async () => ({ providerPayoutId: `${name}-1`, state: 'sent' }),
  };
}

const PAYSTACK = fake('paystack', [{ code: '044', name: 'Access Bank' }]);
const FLUTTERWAVE = fake('flutterwave', [{ code: 'MTN', name: 'MTN Mobile Money' }]);

function port(options: {
  readonly routes?: Readonly<Record<string, string>>;
  readonly setting?: string;
  readonly currencies?: Readonly<Record<string, string>>;
  readonly adapters?: ReadonlyMap<string, PayoutPort>;
}) {
  return new SwitchingPayoutPort({
    adapters:
      options.adapters ??
      new Map([
        ['paystack', PAYSTACK],
        ['flutterwave', FLUTTERWAVE],
      ]),
    settings: {
      text: async (_key: string, fallback: string) => options.setting ?? fallback,
    } as never,
    fallback: 'paystack',
    router: {
      providerFor: async (_op: string, currency: string) => options.routes?.[currency],
    } as never,
    currencyOf: async (country: string) =>
      (options.currencies ?? { NG: 'NGN', GH: 'GHS', KE: 'KES' })[country],
  });
}

/** The seed 059 ships. Shared, because both blocks reason about it. */
const routes = { NGN: 'paystack', GHS: 'flutterwave', KES: 'flutterwave' };

describe('which rail answers a customer in which country', () => {
  it('offers a customer in Ghana MOBILE MONEY NETWORKS, not banks', async () => {
    const banks = await port({ routes }).banks('GH');
    expect(banks.map((b) => b.code)).toEqual(['MTN']);
  });

  it('offers a customer in Kenya the same rail', async () => {
    expect((await port({ routes }).banks('KE'))[0]?.code).toBe('MTN');
  });

  it('leaves NIGERIA exactly where it was', async () => {
    // The corridor that has always worked. A fix for the broken one that
    // moved this would be a worse bug than the one it fixed.
    expect((await port({ routes }).banks('NG'))[0]?.code).toBe('044');
  });

  it('sends on the rail that answered the list', async () => {
    /*
     * `bankCode` came from `banks()`, so it is THAT provider's code and means
     * nothing to another one — an MTN network code sent to Paystack is not a
     * bank. Routing the three calls together is what keeps them coherent.
     */
    const p = port({ routes });
    const receipt = await p.send({
      country: 'GH',
      bankCode: 'MTN',
      accountNumber: '0244123456',
      accountName: 'Ama Mensah',
      amount: { amount: 100n, currency: 'GHS' },
      reference: 'r',
    });
    expect(receipt.providerPayoutId).toBe('flutterwave-1');
  });

  it('asks the same rail who holds the destination', async () => {
    const found = await port({ routes }).lookup('GH', 'MTN', '0244123456');
    expect(found.accountName).toBe('flutterwave says who');
  });
});

describe('when routing cannot answer', () => {
  it('falls back to the setting for an unrouted currency', async () => {
    // A corridor nobody has routed must not take out the Send screen.
    const banks = await port({ routes: {}, setting: 'paystack' }).banks('GH');
    expect(banks[0]?.code).toBe('044');
  });

  it('falls back on a deployment behind the migration', async () => {
    // No `provider_routes` table means the router answers undefined for
    // everything, which is exactly how this behaved before routing existed.
    const banks = await port({ setting: 'paystack' }).banks('GH');
    expect(banks[0]?.code).toBe('044');
  });

  it('falls back when a route names a rail this build has no adapter for', async () => {
    /*
     * An operator's typo, or a row written by a newer deployment. Refusing
     * would turn one wrong word into an outage on the screen customers send
     * money from; falling back keeps them served and the warning is what makes
     * the typo findable — the same argument `activeProvider` already makes.
     */
    const banks = await port({
      routes: { GHS: 'stripe' },
      setting: 'paystack',
      adapters: new Map([['paystack', PAYSTACK]]),
    }).banks('GH');
    expect(banks[0]?.code).toBe('044');
  });

  it('falls back for a country whose currency it cannot resolve', async () => {
    // A country row missing, or a deployment behind 040.
    const banks = await port({ routes, currencies: {}, setting: 'paystack' }).banks('GH');
    expect(banks[0]?.code).toBe('044');
  });
});
