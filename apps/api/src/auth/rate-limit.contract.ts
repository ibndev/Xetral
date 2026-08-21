import { expect, it } from 'vitest';
import type { RateLimitStore } from './rate-limit.js';

/**
 * The contract every RateLimitStore must satisfy, run against each
 * implementation.
 *
 * Written once and shared deliberately. The point of the Redis store is that it
 * gives the same answer the in-memory one would, from any instance; asserting
 * that with two hand-written suites would let them drift into testing two
 * different behaviours while both stayed green.
 *
 * Every case drives time through the `nowMs` argument rather than sleeping, so
 * the suite is deterministic and takes milliseconds against both backends.
 */
export const WINDOW = 900;

export function rateLimitContract(makeStore: () => RateLimitStore | Promise<RateLimitStore>): void {
  const store = async (): Promise<RateLimitStore> => makeStore();

  it('allows up to the limit and then blocks', async () => {
    const s = await store();
    for (let i = 0; i < 5; i++) {
      expect((await s.hit('k', 5, WINDOW, 1_000_000)).allowed).toBe(true);
    }
    expect((await s.hit('k', 5, WINDOW, 1_000_000)).allowed).toBe(false);
  });

  it('reports how long the caller must wait', async () => {
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('k', 3, 60, 1_000_000);

    const blocked = await s.hit('k', 3, 60, 1_000_000 + 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(50);
  });

  it('lets attempts through again as the window slides past them', async () => {
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('k', 3, 60, 1_000_000);

    expect((await s.hit('k', 3, 60, 1_030_000)).allowed).toBe(false);
    // 61s later the three original attempts have aged out.
    expect((await s.hit('k', 3, 60, 1_061_000)).allowed).toBe(true);
  });

  it('does not let a blocked caller extend their own lockout', async () => {
    // Recording blocked attempts would mean an attacker hammering the endpoint
    // keeps the real customer locked out for as long as they care to continue.
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('k', 3, 60, 1_000_000);
    for (let i = 0; i < 50; i++) await s.hit('k', 3, 60, 1_030_000);

    expect((await s.hit('k', 3, 60, 1_061_000)).allowed).toBe(true);
  });

  it('never lets a burst at a boundary double the intended rate', async () => {
    // The failure a fixed window has: a full allowance at 14:59 and another at
    // 15:01. A sliding window sees six attempts in two minutes and refuses.
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('k', 3, 60, 1_000_000);
    expect((await s.hit('k', 3, 60, 1_059_000)).allowed).toBe(false);
  });

  it('keeps buckets independent', async () => {
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('ip:1.2.3.4', 3, WINDOW, 1_000_000);

    expect((await s.hit('ip:1.2.3.4', 3, WINDOW, 1_000_000)).allowed).toBe(false);
    expect((await s.hit('ip:5.6.7.8', 3, WINDOW, 1_000_000)).allowed).toBe(true);
    expect((await s.hit('id:ada@example.ng', 3, WINDOW, 1_000_000)).allowed).toBe(true);
  });

  it('counts two attempts in the same millisecond as two', async () => {
    // A sorted set keyed on the timestamp alone would treat the second as an
    // update of the first, handing out a free retry under exactly the
    // concurrency this is meant to survive.
    const s = await store();
    for (let i = 0; i < 3; i++) {
      expect((await s.hit('same-ms', 3, WINDOW, 1_000_000)).allowed).toBe(true);
    }
    expect((await s.hit('same-ms', 3, WINDOW, 1_000_000)).allowed).toBe(false);
  });

  it('caps stored attempts per key rather than growing with the attack', async () => {
    // An attacker hammering one key must not allocate storage for every hit.
    // Only the `max` most recent timestamps are needed to decide, and the
    // observable consequence of keeping only those is that the decision stays
    // correct after ten thousand attempts.
    const s = await store();
    for (let i = 0; i < 10_000; i++) await s.hit('k', 5, WINDOW, 1_000_000 + i);

    expect((await s.hit('k', 5, WINDOW, 1_000_000)).allowed).toBe(false);
    // The five surviving attempts are the earliest accepted ones, so the window
    // clears relative to them and not to the last of ten thousand.
    expect((await s.hit('k', 5, WINDOW, 1_010_000 + WINDOW * 1000)).allowed).toBe(true);
  });

  it('forgets a key that has been idle for hours', async () => {
    const s = await store();
    for (let i = 0; i < 3; i++) await s.hit('id:one', 3, WINDOW, 1_000_000);
    expect((await s.hit('id:one', 3, WINDOW, 1_000_000)).allowed).toBe(false);

    const muchLater = 1_000_000 + 3 * 60 * 60 * 1000;
    expect((await s.hit('id:one', 3, WINDOW, muchLater)).allowed).toBe(true);
  });
}
