import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { RedisRateLimitStore } from './rate-limit.js';
import { rateLimitContract } from './rate-limit.contract.js';

/**
 * The Redis store against the same contract the in-memory one satisfies.
 *
 * Run against a real Redis, not a mock. The behaviour under test lives inside a
 * Lua script that Redis executes — a mock would be asserting that the author's
 * mental model of ZREMRANGEBYSCORE matches itself.
 */
const REDIS_URL = process.env['REDIS_URL'];
if (REDIS_URL === undefined || REDIS_URL === '') {
  throw new Error('the Redis rate-limit suite needs REDIS_URL pointing at a live Redis');
}

const connections: Redis[] = [];

function makeStore(): RedisRateLimitStore {
  const redis = new Redis(REDIS_URL as string);
  connections.push(redis);
  // A fresh prefix per store, so a rerun cannot inherit buckets from the last
  // one and the contract's fixed timestamps stay meaningful.
  return new RedisRateLimitStore(redis, `test:${randomUUID()}:`);
}

afterAll(async () => {
  await Promise.all(connections.map(async (c) => c.quit()));
});

describe('RedisRateLimitStore', () => {
  rateLimitContract(makeStore);
});

describe('atomicity', () => {
  it('holds the limit when every attempt is issued concurrently', async () => {
    // The reason the decision is a Lua script rather than prune-count-add over
    // three round trips. Twenty simultaneous requests against a limit of five
    // must yield exactly five allowances; a read-modify-write would let most of
    // them read "room available" before any of them wrote.
    const store = makeStore();
    const now = 1_000_000;

    const results = await Promise.all(
      Array.from({ length: 20 }, async () => store.hit('burst', 5, 900, now)),
    );

    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    expect(results.filter((r) => !r.allowed)).toHaveLength(15);
  });

  it('holds the limit across separate connections', async () => {
    // Two stores on different connections stand in for two app instances --
    // the whole reason Redis is here. They must share one bucket.
    const a = new Redis(REDIS_URL as string);
    const b = new Redis(REDIS_URL as string);
    connections.push(a, b);

    const prefix = `test:${randomUUID()}:`;
    const instanceOne = new RedisRateLimitStore(a, prefix);
    const instanceTwo = new RedisRateLimitStore(b, prefix);

    const now = 1_000_000;
    expect((await instanceOne.hit('shared', 3, 900, now)).allowed).toBe(true);
    expect((await instanceTwo.hit('shared', 3, 900, now)).allowed).toBe(true);
    expect((await instanceOne.hit('shared', 3, 900, now)).allowed).toBe(true);

    // The fourth is refused regardless of which instance receives it.
    expect((await instanceTwo.hit('shared', 3, 900, now)).allowed).toBe(false);
    expect((await instanceOne.hit('shared', 3, 900, now)).allowed).toBe(false);
  });

  it('expires idle buckets instead of retaining every identifier tried', async () => {
    const redis = new Redis(REDIS_URL as string);
    connections.push(redis);
    const prefix = `test:${randomUUID()}:`;
    const store = new RedisRateLimitStore(redis, prefix);

    await store.hit('ttl-check', 5, 900, Date.now());

    const ttl = await redis.pttl(`${prefix}ttl-check`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900 * 1000);
  });
});
