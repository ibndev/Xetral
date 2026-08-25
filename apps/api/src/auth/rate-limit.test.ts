import { describe, expect, it } from 'vitest';
import type { RateLimitStore } from './rate-limit.js';
import { InMemoryRateLimitStore, ResilientRateLimitStore } from './rate-limit.js';
import { rateLimitContract } from './rate-limit.contract.js';

/**
 * The in-memory store against the shared contract. The Redis store is held to
 * the same one in `rate-limit.redis.e2e.test.ts`, which needs a live Redis and
 * therefore runs under `npm run test:e2e`.
 */
describe('InMemoryRateLimitStore', () => {
  rateLimitContract(() => new InMemoryRateLimitStore());
});

/**
 * The resilient wrapper, held to the SAME contract as the two stores it sits
 * between. A wrapper that quietly changed the limiting behaviour would be a
 * third implementation nobody had tested, sitting in front of the only two
 * that were.
 */
describe('ResilientRateLimitStore', () => {
  rateLimitContract(() => new ResilientRateLimitStore(new InMemoryRateLimitStore()));

  it('keeps limiting when the primary store throws', async () => {
    // The failure this exists for. Before the wrapper, a Redis outage made the
    // limiter throw and took the request with it: every login answered 500,
    // so a cache being down locked every customer out of their own money and
    // an attacker who could knock over one Redis had a denial of service
    // against authentication. Verified by stopping Redis and curling the login
    // endpoint — it typechecks either way, and every test has a Redis or none.
    const broken: RateLimitStore = {
      hit: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:6379')),
    };
    const store = new ResilientRateLimitStore(broken, new InMemoryRateLimitStore());

    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await store.hit('k', 2, 60, 1_000 + i));
    }

    // Still ANSWERING — not throwing — and still counting.
    expect(results.map((r) => r.allowed)).toEqual([true, true, false, false]);
    expect(store.degraded).toBe(true);
  });

  it('returns to the primary store once it recovers', async () => {
    let failing = true;
    const inner = new InMemoryRateLimitStore();
    const flaky: RateLimitStore = {
      hit: (key, max, window, now) =>
        failing ? Promise.reject(new Error('down')) : inner.hit(key, max, window, now),
    };
    const store = new ResilientRateLimitStore(flaky, new InMemoryRateLimitStore());

    await store.hit('k', 5, 60, 1_000);
    expect(store.degraded).toBe(true);

    failing = false;
    await store.hit('k', 5, 60, 2_000);
    // Latching degraded for ever would mean one blip permanently downgrading a
    // fleet to per-instance limits, with nothing in the logs to say so.
    expect(store.degraded).toBe(false);
  });
});
