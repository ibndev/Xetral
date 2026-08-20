import { expect, it } from 'vitest';
import { ProviderTimeoutError } from './errors.js';
import { supportsVerification } from './fulfilment.js';
import type { FulfilmentPort } from './fulfilment.js';

/**
 * What every FulfilmentPort must do, run against all three adapters.
 *
 * Written once and shared deliberately. Three hand-written suites would drift
 * into asserting three different contracts while all staying green — and the
 * entire value of the port is that a caller can swap one provider for another
 * without reading its adapter.
 */
export interface ContractHarness {
  /** A port wired to a scripted transport. */
  readonly port: FulfilmentPort;
  /** Replaces the next response the transport will return. */
  readonly script: (responses: { status?: number; json?: unknown; text?: string }[]) => void;
  /** A successful purchase response for this provider. */
  readonly deliveredPurchase: { status?: number; json?: unknown }[];
  /** Whatever `catalogue` needs to return at least one item. */
  readonly catalogueResponses: { status?: number; json?: unknown }[];
  /**
   * What the STATUS endpoint returns. Separate from `deliveredPurchase`
   * because a provider is free to answer "what happened to this?" in a
   * different shape from "do this" — Twilio returns a collection where the
   * others return the order.
   */
  readonly statusResponses: { status?: number; json?: unknown }[];
  readonly currency: 'NGN' | 'USD';
  readonly itemCode: string;
  readonly target: string;
}

export function fulfilmentContract(make: () => ContractHarness): void {
  it('names itself and the service it fulfils', () => {
    const { port } = make();
    expect(port.provider.length).toBeGreaterThan(0);
    expect(['airtime', 'data', 'utility', 'esim', 'number']).toContain(port.service);
  });

  it('returns catalogue prices as bigint minor units, never a float', async () => {
    const harness = make();
    harness.script(harness.catalogueResponses);

    const items = await harness.port.catalogue({ group: 'NG' });
    expect(items.length).toBeGreaterThan(0);

    for (const item of items) {
      expect(item.code.length).toBeGreaterThan(0);
      // null is the "customer names the amount" case; anything else must be a
      // bigint. A `number` price is a float in a money field.
      if (item.priceMinor !== null) expect(typeof item.priceMinor).toBe('bigint');
      expect(item.currency).toBe(harness.currency);
    }
  });

  it('reports a delivered purchase with a provider reference', async () => {
    const harness = make();
    harness.script(harness.deliveredPurchase);

    const result = await harness.port.purchase({
      reference: 'xetral-ref-1',
      itemCode: harness.itemCode,
      target: harness.target,
      amountMinor: 50_000n,
      currency: harness.currency,
    });

    expect(result.status).toBe('delivered');
    expect(result.providerReference.length).toBeGreaterThan(0);
  });

  it('refuses a purchase in the wrong currency rather than converting', async () => {
    // A provider settles in one currency. Silently accepting another is how an
    // amount in kobo gets sent as if it were cents.
    const harness = make();
    harness.script(harness.deliveredPurchase);

    const wrong = harness.currency === 'NGN' ? 'USD' : 'NGN';
    await expect(
      harness.port.purchase({
        reference: 'xetral-ref-2',
        itemCode: harness.itemCode,
        target: harness.target,
        amountMinor: 50_000n,
        currency: wrong,
      }),
    ).rejects.toThrow();
  });

  it('treats a timeout as NOT retryable', async () => {
    // A timeout means we do not know whether the provider acted. Re-sending a
    // purchase is how one airtime top-up becomes two; the recovery path is
    // `status`, which asks rather than repeats.
    const harness = make();
    harness.script([{ text: '__abort__' }]);

    await expect(
      harness.port.purchase({
        reference: 'xetral-ref-3',
        itemCode: harness.itemCode,
        target: harness.target,
        amountMinor: 50_000n,
        currency: harness.currency,
      }),
    ).rejects.toMatchObject({ name: 'ProviderTimeoutError', retryable: false });
  });

  it('exposes a status lookup keyed on OUR reference', async () => {
    // The whole point: after a timeout we can ask what happened using a value
    // we chose, without needing an id the provider never gave us.
    const harness = make();
    harness.script(harness.statusResponses);
    const result = await harness.port.status('xetral-ref-1');
    expect(['delivered', 'pending', 'failed']).toContain(result.status);
  });

  it('surfaces a gateway HTML page as a contract error, not a parse crash', async () => {
    const harness = make();
    harness.script([{ status: 200, text: '<html>504 Gateway Timeout</html>' }]);

    await expect(
      harness.port.purchase({
        reference: 'xetral-ref-4',
        itemCode: harness.itemCode,
        target: harness.target,
        amountMinor: 50_000n,
        currency: harness.currency,
      }),
    ).rejects.toMatchObject({ name: 'ProviderContractError', retryable: false });
  });

  it('declares verification support honestly', () => {
    // supportsVerification is a capability check, not a guess. An adapter that
    // claims it must actually have the method.
    const { port } = make();
    if (supportsVerification(port)) {
      expect(typeof port.verifyTarget).toBe('function');
    } else {
      expect((port as { verifyTarget?: unknown }).verifyTarget).toBeUndefined();
    }
  });
}

/** Shared scripted transport. `text: '__abort__'` simulates a timeout. */
export function scriptedFetch(): {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  script: (responses: { status?: number; json?: unknown; text?: string }[]) => void;
  calls: { url: string; init: RequestInit }[];
} {
  let queue: { status?: number; json?: unknown; text?: string }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];

  return {
    calls,
    script: (responses) => {
      queue = [...responses];
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = queue.length > 1 ? queue.shift() : queue[0];
      const response = next ?? {};

      if (response.text === '__abort__') {
        const error = new Error('aborted');
        error.name = 'AbortError';
        throw error;
      }

      const status = response.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () =>
          response.text ?? (response.json === undefined ? '' : JSON.stringify(response.json)),
      } as Response;
    },
  };
}

export { ProviderTimeoutError };
