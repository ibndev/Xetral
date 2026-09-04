import { describe, expect, it, vi } from 'vitest';
import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@xetral/providers';
import { outcomeOf, watched } from './provider-health.service.js';
import type { ProviderHealthService } from './provider-health.service.js';

/**
 * The port wrapper.
 *
 * `watched()` is a Proxy rather than seven hand-written wrappers, and the
 * thing worth testing is exactly what that buys: a method the wrapper has
 * never heard of is still recorded. A hand-written wrapper would silently miss
 * one added later, which is the failure this whole file exists to prevent.
 */
function recorder(): {
  health: ProviderHealthService;
  calls: { provider: string; operation: string; outcome: string }[];
} {
  const calls: { provider: string; operation: string; outcome: string }[] = [];
  const health = {
    record: vi.fn(async (provider: string, operation: string, outcome: string) => {
      calls.push({ provider, operation, outcome });
    }),
  } as unknown as ProviderHealthService;
  return { health, calls };
}

describe('what a thrown error means for health', () => {
  it('does NOT treat a refusal as ill health', () => {
    // The distinction the whole feature rests on. A rejection is the provider
    // understanding the request and refusing it — insufficient float, a frozen
    // card. Counting it as an outage makes a busy decline rate look like one,
    // and an alert that fires on ordinary business is one people mute.
    expect(outcomeOf(new ProviderRejectedError('bitnob', 'declined', '51'))).toBe('rejected');
  });

  it('separates the three that do mean ill health', () => {
    expect(outcomeOf(new ProviderUnavailableError('bitnob', 'connection refused'))).toBe(
      'unavailable',
    );
    expect(outcomeOf(new ProviderTimeoutError('bitnob', 'timed out'))).toBe('timed_out');
    // The one that pages: they changed their API, and the same request will
    // fail for ever.
    expect(outcomeOf(new ProviderContractError('bitnob', 'unexpected card shape'))).toBe(
      'contract',
    );
  });

  it('records nothing for an error that is not the provider', () => {
    // A bug in our own code inside an adapter. Recording it as an outage puts
    // a number on the dashboard that is not about the provider, and recording
    // it as healthy is worse.
    expect(outcomeOf(new TypeError('cannot read property of undefined'))).toBeUndefined();
    expect(outcomeOf('a string')).toBeUndefined();
  });
});

describe('the wrapper', () => {
  it('records a method it has never heard of', async () => {
    // The reason it is a Proxy. Seven hand-written wrappers would each need
    // updating when a port gains a method, and the one nobody updates is the
    // one that stops being watched.
    const { health, calls } = recorder();
    const port = { somethingAddedLater: async (): Promise<string> => 'ok' };

    const guarded = watched(port, 'bitnob', health);
    await expect(guarded.somethingAddedLater()).resolves.toBe('ok');

    // The write is fire-and-forget, so let the microtask queue drain.
    await Promise.resolve();
    expect(calls).toEqual([
      { provider: 'bitnob', operation: 'somethingAddedLater', outcome: 'succeeded' },
    ]);
  });

  it('rethrows, having recorded', async () => {
    // The failure has to reach the caller unchanged: every flow above this
    // decides what to do from the error class, and swallowing one to record it
    // would turn an outage into a silent success.
    const { health, calls } = recorder();
    const port = {
      issueCard: async (): Promise<never> => {
        throw new ProviderUnavailableError('bitnob', 'connection refused');
      },
    };

    const guarded = watched(port, 'bitnob', health);
    await expect(guarded.issueCard()).rejects.toBeInstanceOf(ProviderUnavailableError);

    await Promise.resolve();
    expect(calls[0]).toMatchObject({ operation: 'issueCard', outcome: 'unavailable' });
  });

  it('passes the arguments and the answer through untouched', async () => {
    const { health } = recorder();
    const port = {
      fund: async (id: string, minor: bigint): Promise<string> => `${id}:${minor.toString()}`,
    };
    const guarded = watched(port, 'bitnob', health);
    await expect(guarded.fund('card-1', 500n)).resolves.toBe('card-1:500');
  });

  it('leaves a synchronous method alone', async () => {
    // `supportsVerification()` is a type guard, not a provider call. Recording
    // it as an instant success would make a healthy-looking figure out of
    // something that never touched the network.
    const { health, calls } = recorder();
    const port = { supportsVerification: (): boolean => true };

    const guarded = watched(port, 'vtpass', health);
    expect(guarded.supportsVerification()).toBe(true);

    await Promise.resolve();
    expect(calls).toEqual([]);
  });

  it('passes non-function properties through', async () => {
    const { health } = recorder();
    const guarded = watched({ provider: 'vtpass', send: async (): Promise<void> => {} }, 'vtpass', health);
    expect(guarded.provider).toBe('vtpass');
  });

  it('keeps `this` bound to the real port', async () => {
    // An adapter that reads its own private state would otherwise break the
    // moment it was wrapped — and it would break at runtime, in production,
    // rather than in the compiler.
    const { health } = recorder();
    class Adapter {
      readonly #base = 'https://api.example';
      async ping(): Promise<string> {
        return this.#base;
      }
    }
    const guarded = watched(new Adapter(), 'bitnob', health);
    await expect(guarded.ping()).resolves.toBe('https://api.example');
  });

  it('READS A GETTER OVER A PRIVATE FIELD, which is what broke every naira account', () => {
    /*
     * THE FAILURE THIS EXISTS FOR, and the two tests above are why it
     * survived: one covers a METHOD reading a private field, the other covers
     * `provider` as a plain PROPERTY. Neither covers the combination —
     * a GETTER over a private field — and that is what both switching ports
     * are.
     *
     * `Reflect.get(target, property, receiver)` runs a getter with `this`
     * bound to the receiver. Handed the proxy, which is what a `get` trap
     * receives and what every example forwards, the getter executes against
     * an object that has no such private field and JavaScript answers:
     *
     *   TypeError: Cannot read private member #fallback from an object whose
     *   class did not declare it
     *
     * `SwitchingFundingPort.provider` is exactly that shape, and it is read
     * while BUILDING the customer record — before Paystack is called at all.
     * So opening a naira account threw for every customer, and the failure
     * looked like the rail refusing, which pointed every investigation at the
     * provider dashboard.
     *
     * A private field is the one part of an object a proxy cannot forward, so
     * the only correct receiver is the target.
     */
    const { health } = recorder();
    class SwitchingPort {
      readonly #fallback = 'paystack';
      get provider(): string {
        return this.#fallback;
      }
      async createVirtualAccount(): Promise<string> {
        return this.#fallback;
      }
    }
    const guarded = watched(new SwitchingPort(), 'paystack', health);
    expect(guarded.provider).toBe('paystack');
  });
});
