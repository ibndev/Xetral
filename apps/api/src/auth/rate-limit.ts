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
 *
 * Two implementations live here and are held to ONE contract by a shared test
 * suite (`rate-limit.contract.ts`). That matters more than it looks: the whole
 * reason to run Redis is to get the same answer from every instance, and an
 * implementation that merely looks equivalent is how a limit quietly stops
 * applying under load.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the next attempt would be permitted. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * Asynchronous even for the in-memory implementation, which could answer
 * synchronously. A union return type (`RateLimitDecision | Promise<...>`) would
 * let a caller forget to await and get a truthy Promise back — which reads as
 * "allowed" and disables the limit entirely. One shape, always awaited.
 */
export interface RateLimitStore {
  hit(
    key: string,
    max: number,
    windowSeconds: number,
    nowMs: number,
  ): Promise<RateLimitDecision>;
}

/**
 * In-memory sliding window.
 *
 * DEPLOYMENT LIMITATION, stated because it is invisible from the code: this
 * counts per PROCESS. Run two instances behind a load balancer and the
 * effective limit is doubled; run ten and the limit is meaningless. It is
 * adequate for a single box and is not adequate for the topology this platform
 * has to reach. `RedisRateLimitStore` below is what a multi-instance deployment
 * uses; this one stays for local development and tests, where a Redis
 * dependency would buy nothing.
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  /** Most recent attempt timestamps per key, oldest first, capped at `max`. */
  readonly #attempts = new Map<string, number[]>();

  /** Keys with no activity for this long are dropped, so an attacker cycling
   *  identifiers cannot grow this map without bound. */
  static readonly #SWEEP_AFTER_MS = 60 * 60 * 1000;
  #lastSweepMs = 0;

  async hit(
    key: string,
    max: number,
    windowSeconds: number,
    nowMs: number,
  ): Promise<RateLimitDecision> {
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

/**
 * Redis-backed sliding window, for any deployment running more than one
 * instance.
 *
 * WHY THIS IS A LUA SCRIPT AND NOT THREE COMMANDS
 * -----------------------------------------------
 * The obvious implementation is: prune old entries, count what is left, and add
 * one if there is room. Written as three round trips that is a
 * read-modify-write, and the moment there is genuinely concurrent traffic — the
 * only reason to reach for Redis at all — several instances all read "four
 * attempts", all decide there is room, and all write a fifth. The limit becomes
 * "five per instance per round trip".
 *
 * The in-memory store never had that race because JavaScript gave it one
 * thread for free. Moving to Redis is precisely the step that takes that
 * guarantee away, so it has to be replaced deliberately: Redis runs a script to
 * completion without interleaving, which makes prune-count-add a single atomic
 * decision again.
 *
 * This is the same reasoning that put reuse detection inside
 * `rotate_refresh_token()` rather than in service code.
 */
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local max    = tonumber(ARGV[3])
local member = ARGV[4]

-- Drop attempts that have aged out of the window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)

local count = redis.call('ZCARD', key)

if count >= max then
  -- Blocked attempts are deliberately NOT recorded, matching the in-memory
  -- store: recording them would let an attacker extend the real customer's
  -- lockout indefinitely just by continuing to try.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = 0
  if oldest[2] ~= nil then
    retry = math.ceil((tonumber(oldest[2]) + window - now) / 1000)
    if retry < 0 then retry = 0 end
  end
  redis.call('PEXPIRE', key, window)
  return {0, retry}
end

redis.call('ZADD', key, now, member)
-- The key expires a full window after the last attempt, so idle buckets clean
-- themselves up. Without this, every identifier an attacker tries would be
-- retained for ever.
redis.call('PEXPIRE', key, window)
return {1, 0}
`;

/** The subset of ioredis this store needs. Declared structurally so the store
 *  can be constructed with a test double without importing ioredis's types
 *  into every consumer. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<unknown>;
}

export class RedisRateLimitStore implements RateLimitStore {
  readonly #redis: RedisLike;
  readonly #prefix: string;

  constructor(redis: RedisLike, prefix = 'ratelimit:') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async hit(
    key: string,
    max: number,
    windowSeconds: number,
    nowMs: number,
  ): Promise<RateLimitDecision> {
    // A sorted set stores one member per attempt, so two attempts landing in
    // the same millisecond need distinct members or the second silently
    // replaces the first and the caller gets a free retry.
    const member = `${nowMs}-${Math.random().toString(36).slice(2)}`;

    const raw = await this.#redis.eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      `${this.#prefix}${key}`,
      nowMs,
      windowSeconds * 1000,
      max,
      member,
    );

    if (!Array.isArray(raw) || raw.length !== 2) {
      throw new Error(`unexpected reply from the rate-limit script: ${JSON.stringify(raw)}`);
    }

    const [allowed, retryAfter] = raw as [number, number];
    return { allowed: allowed === 1, retryAfterSeconds: Number(retryAfter) };
  }

  async close(): Promise<void> {
    await this.#redis.quit();
  }
}
