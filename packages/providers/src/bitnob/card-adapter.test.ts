import { describe, expect, it } from 'vitest';
import { usd } from '@xetral/shared';
import { BitnobCardAdapter } from './card-adapter.js';
import { BitnobClient } from './client.js';
import type { FetchLike } from './client.js';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';

interface Call {
  url: string;
  init: RequestInit;
}

/**
 * A scripted response. `json` is the parsed body we want the adapter to see,
 * not Response's own `json()` method — hence the Omit, without which the
 * intersection silently resolves to the method type and every literal below
 * fails to typecheck.
 */
interface ScriptedResponse {
  status?: number;
  json?: unknown;
}

/** Scripts responses so real adapter code runs against them. */
function stub(responses: ScriptedResponse[]): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(index++, responses.length - 1)] ?? {};
    const status = next.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => (next.json === undefined ? '' : JSON.stringify(next.json)),
    } as Response;
  };
  return { fetch, calls };
}

const cardBody = (overrides: Record<string, unknown> = {}) => ({
  data: {
    id: 'card_77',
    status: 'active',
    last4: '4242',
    expiry_month: 11,
    expiry_year: 2030,
    balance: '25000000',
    ...overrides,
  },
});

function adapterWith(responses: Parameters<typeof stub>[0]): {
  adapter: BitnobCardAdapter;
  calls: Call[];
} {
  const { fetch, calls } = stub(responses);
  const client = new BitnobClient({ baseUrl: 'https://api.bitnob.test/', apiKey: 'sk', fetch });
  return { adapter: new BitnobCardAdapter(client), calls };
}

describe('reading a card', () => {
  it('returns domain types, with the balance converted from micro-units', () => {
    return (async () => {
      const { adapter } = adapterWith([{ json: cardBody() }]);
      const card = await adapter.get('card_77');

      expect(card.providerCardId).toBe('card_77');
      expect(card.status).toBe('active');
      expect(card.last4).toBe('4242');
      // 25,000,000 micro = $25.00 = 2500 cents.
      expect(card.balance.amount).toBe(2500n);
      expect(card.balance.currency).toBe('USD');
    })();
  });

  it('leaks no provider fields past the port', async () => {
    const { adapter } = adapterWith([
      { json: cardBody({ bitnob_internal_ref: 'xyz', card_brand: 'visa' }) },
    ]);
    const card = await adapter.get('card_77');

    // The rest of the system sees the port's shape and nothing else. A field
    // leaking through here is how the next issuer becomes impossible to add.
    expect(Object.keys(card).sort()).toEqual([
      'balance',
      'expiryMonth',
      'expiryYear',
      'last4',
      'providerCardId',
      'status',
    ]);
  });

  it('refuses an unrecognised status instead of guessing', async () => {
    // Defaulting to 'active' would let a card Bitnob froze keep spending;
    // defaulting to 'frozen' would strand a working one. Neither is safe.
    const { adapter } = adapterWith([{ json: cardBody({ status: 'quarantined' }) }]);
    await expect(adapter.get('card_77')).rejects.toThrow(ProviderContractError);
  });

  it('refuses a response missing fields it needs', async () => {
    const { adapter } = adapterWith([{ json: { data: { id: 'card_77' } } }]);
    await expect(adapter.get('card_77')).rejects.toThrow(ProviderContractError);
  });
});

describe('issuing', () => {
  it('sends the amount in micro-units', async () => {
    const { adapter, calls } = adapterWith([{ json: cardBody() }]);
    await adapter.issue({
      ownerId: 'u1',
      providerCustomerId: 'cus_5',
      nameOnCard: 'Ada Obi',
      initialFunding: usd(2500),
    });

    const sent = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    // 2500 cents must leave as 25,000,000 micro. Sending cents would fund the
    // card with a ten-thousandth of the intended amount.
    expect(sent['amount']).toBe('25000000');
    expect(sent['currency']).toBe('USD');
  });

  it('authenticates the request', async () => {
    const { adapter, calls } = adapterWith([{ json: cardBody() }]);
    await adapter.get('card_77');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk');
  });
});

describe('funding is asynchronous', () => {
  it('does not report success when the balance has not moved', async () => {
    // THE documented trap. Bitnob answers immediately with pending and
    // balance_before === balance_after. Reading that as done means the ledger
    // records money that has not arrived.
    const { adapter } = adapterWith([
      {
        json: {
          data: {
            id: 'txn_1',
            status: 'pending',
            balance_before: '25000000',
            balance_after: '25000000',
          },
        },
      },
    ]);

    const outcome = await adapter.fund({
      providerCardId: 'card_77',
      amount: usd(1000),
      idempotencyKey: 'fund-1',
    });

    expect(outcome.state).toBe('pending');
    if (outcome.state === 'pending') expect(outcome.providerReference).toBe('txn_1');
  });

  it('distrusts a claimed success whose balance did not change', async () => {
    // The subtler version: status says success but the numbers disagree. The
    // numbers win.
    const { adapter } = adapterWith([
      {
        json: {
          data: {
            id: 'txn_2',
            status: 'success',
            balance_before: '25000000',
            balance_after: '25000000',
          },
        },
      },
    ]);
    expect(
      (
        await adapter.fund({
          providerCardId: 'card_77',
          amount: usd(1000),
          idempotencyKey: 'fund-2',
        })
      ).state,
    ).toBe('pending');
  });

  it('reports settled only when the balance actually moved', async () => {
    const { adapter } = adapterWith([
      {
        json: {
          data: {
            id: 'txn_3',
            status: 'success',
            balance_before: '25000000',
            balance_after: '26000000',
          },
        },
      },
    ]);
    expect(
      (
        await adapter.fund({
          providerCardId: 'card_77',
          amount: usd(1000),
          idempotencyKey: 'fund-3',
        })
      ).state,
    ).toBe('settled');
  });

  it('sends the caller idempotency key so a retry cannot double-fund', async () => {
    const { adapter, calls } = adapterWith([
      {
        json: {
          data: { id: 't', status: 'success', balance_before: '0', balance_after: '1000000' },
        },
      },
    ]);
    await adapter.fund({
      providerCardId: 'card_77',
      amount: usd(1000),
      idempotencyKey: 'fund-stable-key',
    });
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBe('fund-stable-key');
  });
});

describe('failures are classified by what to do about them', () => {
  it('treats 5xx as retryable', async () => {
    const { adapter } = adapterWith([{ status: 503, json: { message: 'upstream down' } }]);
    await expect(adapter.get('card_77')).rejects.toMatchObject({
      name: 'ProviderUnavailableError',
      retryable: true,
    });
    await expect(adapter.get('card_77')).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('treats a 4xx refusal as not retryable', async () => {
    // Retrying sends the same refusal back; the caller needs to surface it.
    const { adapter } = adapterWith([
      { status: 400, json: { message: 'insufficient float', code: 'INSUFFICIENT_FUNDS' } },
    ]);
    await expect(adapter.get('card_77')).rejects.toMatchObject({
      name: 'ProviderRejectedError',
      retryable: false,
      providerCode: 'INSUFFICIENT_FUNDS',
    });
    await expect(adapter.get('card_77')).rejects.toBeInstanceOf(ProviderRejectedError);
  });

  it('treats a timeout as NOT retryable, deliberately', async () => {
    // A timeout means we do not know whether it was applied. For "fund this
    // card" the naive retry is exactly how one funding becomes two; the
    // recovery path is to reconcile.
    const abort: FetchLike = async () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    };
    const client = new BitnobClient({
      baseUrl: 'https://api.bitnob.test',
      apiKey: 'sk',
      fetch: abort,
      timeoutMs: 5,
    });
    const adapter = new BitnobCardAdapter(client);

    await expect(adapter.get('card_77')).rejects.toMatchObject({
      name: 'ProviderTimeoutError',
      retryable: false,
    });
    await expect(adapter.get('card_77')).rejects.toBeInstanceOf(ProviderTimeoutError);
    await expect(adapter.get('card_77')).rejects.toThrow(/reconcile rather than retry/);
  });

  it('surfaces a gateway HTML page as a contract error, not a parse crash', async () => {
    const html: FetchLike = async () =>
      ({ ok: true, status: 200, text: async () => '<html>504</html>' }) as Response;
    const client = new BitnobClient({ baseUrl: 'https://api.bitnob.test', apiKey: 'sk', fetch: html });
    await expect(new BitnobCardAdapter(client).get('c')).rejects.toBeInstanceOf(
      ProviderContractError,
    );
  });

  it('recovers the true state after a partial failure', async () => {
    // The reconciliation path the provider rules require: the provider acted,
    // our write did not. Asking again must return the real state rather than
    // leaving the two sides permanently disagreeing.
    const { adapter } = adapterWith([
      { json: cardBody({ status: 'frozen', balance: '26000000' }) },
    ]);
    const actual = await adapter.get('card_77');
    expect(actual.status).toBe('frozen');
    expect(actual.balance.amount).toBe(2600n);
  });
});

describe('lifecycle operations', () => {
  it('freezes, unfreezes and terminates through their own endpoints', async () => {
    const { adapter, calls } = adapterWith([
      { json: cardBody({ status: 'frozen' }) },
      { json: cardBody({ status: 'active' }) },
      { json: cardBody({ status: 'terminated' }) },
    ]);

    expect((await adapter.freeze('card_77')).status).toBe('frozen');
    expect((await adapter.unfreeze('card_77')).status).toBe('active');
    expect((await adapter.terminate('card_77')).status).toBe('terminated');

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.bitnob.test/api/v1/virtualcards/card_77/freeze',
      'https://api.bitnob.test/api/v1/virtualcards/card_77/unfreeze',
      'https://api.bitnob.test/api/v1/virtualcards/card_77/terminate',
    ]);
  });

  it('does not double up the slash between base url and path', async () => {
    const { adapter, calls } = adapterWith([{ json: cardBody() }]);
    await adapter.get('card_77');
    expect(calls[0]?.url).toBe('https://api.bitnob.test/api/v1/virtualcards/card_77');
  });
});
