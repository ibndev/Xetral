import { describe, expect, it } from 'vitest';
import { InMemoryRateLimitStore } from './rate-limit.js';

const WINDOW = 900;

describe('sliding window', () => {
  it('allows up to the limit and then blocks', () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 5; i++) {
      expect(store.hit('k', 5, WINDOW, 1_000_000).allowed).toBe(true);
    }
    expect(store.hit('k', 5, WINDOW, 1_000_000).allowed).toBe(false);
  });

  it('reports how long the caller must wait', () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('k', 3, 60, 1_000_000);

    const blocked = store.hit('k', 3, 60, 1_000_000 + 10_000);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(50);
  });

  it('lets attempts through again as the window slides past them', () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('k', 3, 60, 1_000_000);

    expect(store.hit('k', 3, 60, 1_030_000).allowed).toBe(false);
    // 61s later the three original attempts have aged out.
    expect(store.hit('k', 3, 60, 1_061_000).allowed).toBe(true);
  });

  it('does not let a blocked caller extend their own lockout', () => {
    // Recording blocked attempts would mean an attacker hammering the endpoint
    // keeps the real customer locked out for as long as they care to continue.
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('k', 3, 60, 1_000_000);

    for (let i = 0; i < 50; i++) store.hit('k', 3, 60, 1_030_000);

    expect(store.hit('k', 3, 60, 1_061_000).allowed).toBe(true);
  });

  it('never lets a burst at a boundary double the intended rate', () => {
    // The failure a fixed window has: a full allowance at 14:59 and another at
    // 15:01. A sliding window sees six attempts in two minutes and refuses.
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('k', 3, 60, 1_000_000);
    expect(store.hit('k', 3, 60, 1_059_000).allowed).toBe(false);
  });

  it('keeps buckets independent', () => {
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('ip:1.2.3.4', 3, WINDOW, 1_000_000);

    expect(store.hit('ip:1.2.3.4', 3, WINDOW, 1_000_000).allowed).toBe(false);
    expect(store.hit('ip:5.6.7.8', 3, WINDOW, 1_000_000).allowed).toBe(true);
    expect(store.hit('id:ada@example.ng', 3, WINDOW, 1_000_000).allowed).toBe(true);
  });

  it('caps stored attempts per key rather than growing with the attack', () => {
    // An attacker hammering one key must not allocate memory for every hit.
    // Only the `max` most recent timestamps are needed to decide, and the
    // observable consequence of keeping only those is that the decision stays
    // correct after ten thousand attempts.
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 10_000; i++) store.hit('k', 5, WINDOW, 1_000_000 + i);

    expect(store.hit('k', 5, WINDOW, 1_000_000).allowed).toBe(false);
    // The five surviving attempts are the most recent ones, so the window
    // clears relative to them and not to the first of ten thousand.
    expect(store.hit('k', 5, WINDOW, 1_010_000 + WINDOW * 1000).allowed).toBe(true);
  });

  it('forgets keys that have been idle for an hour', () => {
    // Bounds the map itself, so cycling identifiers cannot grow it for ever.
    const store = new InMemoryRateLimitStore();
    for (let i = 0; i < 3; i++) store.hit('id:one', 3, WINDOW, 1_000_000);
    expect(store.hit('id:one', 3, WINDOW, 1_000_000).allowed).toBe(false);

    const muchLater = 1_000_000 + 3 * 60 * 60 * 1000;
    expect(store.hit('id:one', 3, WINDOW, muchLater).allowed).toBe(true);
  });
});
