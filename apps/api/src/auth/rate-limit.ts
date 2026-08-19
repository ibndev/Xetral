/**
 * Rate limiting for the login path.
 *
 * WHY TWO BUCKETS, NOT ONE
 * ------------------------
 * Limiting by IP alone lets a botnet spray one account from a thousand
 * addresses, each staying under the limit. Limiting by account alone lets one
 * address walk a list of accounts, one guess each, without ever tripping.
 * Neither attack is exotic; both are what credential-stuffing tooling does by
 * default. Both buckets must pass.
 *
 * A sliding window rather than a fixed one, because a fixed window lets an
 * attacker send a full allowance at 14:59 and another at 15:01 — double the
 * intended rate across the boundary, precisely when they are trying hardest.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the next attempt would be permitted. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

export interface RateLimitStore {
  hit(key: string, max: number, windowSeconds: number, nowMs: number): RateLimitDecision;
}

/**
 * In-memory sliding window.
 *
 * DEPLOYMENT LIMITATION, stated because it is invisible from the code: this
 * counts per PROCESS. Run two instances behind a load balancer and the
 * effective limit is doubled; run ten and the limit is meaningless. It is
 * adequate for a single box and is not adequate for the topology this platform
 * has to reach, so it sits behind `RateLimitStore` — swapping in a Redis
 * implementation touches this file and nothing else.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  /** Most recent attempt timestamps per key, oldest first, capped at `max`. */
  readonly #attempts = new Map<string, number[]>();

  /** Keys with no activity for this long are dropped, so an attacker cycling
   *  identifiers cannot grow this map without bound. */
  static readonly #SWEEP_AFTER_MS = 60 * 60 * 1000;
  #lastSweepMs = 0;

  hit(key: string, max: number, windowSeconds: number, nowMs: number): RateLimitDecision {
    this.#sweep(nowMs);

    const windowMs = windowSeconds * 1000;
    const cutoff = nowMs - windowMs;

    const recent = (this.#attempts.get(key) ?? []).filter((at) => at > cutoff);

    if (recent.length >= max) {
      // Blocked attempts are deliberately NOT recorded. Recording them would
      // extend the lockout every time the attacker retries, which also locks
      // out the real customer for as long as an attacker cares to keep going.
      const oldest = recent[0] ?? nowMs;
      const retryAfterMs = Math.max(0, oldest + windowMs - nowMs);
      this.#attempts.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }

    recent.push(nowMs);
    // Only the `max` most recent matter: the decision needs the count and the
    // oldest surviving attempt, so anything beyond that is memory an attacker
    // gets to allocate for free.
    this.#attempts.set(key, recent.slice(-max));
    return { allowed: true, retryAfterSeconds: 0 };
  }

  #sweep(nowMs: number): void {
    if (nowMs - this.#lastSweepMs < InMemoryRateLimitStore.#SWEEP_AFTER_MS) return;
    this.#lastSweepMs = nowMs;

    for (const [key, attempts] of this.#attempts) {
      const newest = attempts[attempts.length - 1];
      if (newest === undefined || newest < nowMs - InMemoryRateLimitStore.#SWEEP_AFTER_MS) {
        this.#attempts.delete(key);
      }
    }
  }
}
