import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { AccessDecision } from '@xetral/identity';
import { API_CONFIG, CLOCK, RATE_LIMIT_STORE } from '../tokens.js';
import type { Clock } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { RateLimitStore } from './rate-limit.js';

/**
 * A ceiling on how fast ANY route can be called, not just the credential ones.
 *
 * WHAT WAS MISSING. Until this existed, three endpoints were limited — login,
 * registration and password reset — because those are where guessing is free.
 * Everything else was unbounded: a stolen access token could ask for a
 * customer's transaction history, or their card details, or attempt a transfer,
 * as fast as the network allowed. The daily spending limit caps how much such a
 * session can MOVE, and caps nothing about how much it can READ, which is the
 * half that matters to somebody harvesting an account before they empty it.
 *
 * THE CLASS IS DERIVED, NOT DECLARED, and that is the one design decision here
 * worth arguing about. `routes.ts` makes authorisation deny-by-default: an
 * undeclared route is refused. The same shape for rate limits would be wrong,
 * because the two failures are not symmetrical. A forgotten AUTHORISATION
 * declaration produces a 403 on the first request and somebody fixes it that
 * morning. A forgotten RATE LIMIT declaration produces nothing at all — the
 * route works perfectly — until the day it is being abused. Forgetting fails
 * open, silently, and the only defence against that is not being able to
 * forget. So the class comes from the policy the route already declares, and a
 * route written next year is limited the day it is written.
 */
export type RateClass = 'unmetered' | 'public' | 'read' | 'write' | 'money' | 'staff';

/**
 * Which ceiling a route falls under, from the policy it already carries.
 *
 * `requiresPin` is the marker for "this moves money" and is already correct on
 * every such route, because the guard uses it to demand a transaction PIN.
 * Reusing it means the two cannot drift: a new transfer endpoint that forgot
 * its rate class would also have forgotten its PIN, which is not a mistake that
 * survives review.
 */
export function rateClassOf(
  decision: AccessDecision,
  method: string,
  path: string,
): RateClass {
  // THE PROBES ARE UNMETERED, and this is the one place a path is named rather
  // than a policy read. The thing that polls these hardest is the load balancer
  // deciding whether this instance is alive, so a ceiling here does not slow an
  // attacker down — it makes a busy instance fail its own health check and get
  // killed, and the limiter becomes the cause of the outage it was added to
  // prevent. They touch nothing and reveal nothing, so there is no cost to
  // absorb.
  if (PROBE_PATHS.has(path)) return 'unmetered';

  if (!decision.allow) return 'public';
  if (decision.mode === 'public') return 'public';
  if (decision.requiresRole !== undefined) return 'staff';
  if (decision.requiresPin) return 'money';
  return method === 'GET' ? 'read' : 'write';
}

const PROBE_PATHS = new Set(['/health', '/ready']);

/*
 * `/metrics` is deliberately NOT in that set.
 *
 * The probes are unmetered because what polls them hardest is the load
 * balancer deciding whether this instance lives, and rate limiting it makes a
 * busy instance fail its own health check. A metrics scrape is different: it
 * runs aggregate queries, it is reachable by anything that can route here, and
 * its bearer check happens inside the handler — so an unmetered one would be a
 * way to make the database do real work without any credential at all. It
 * falls through to the public class, which is far above any real scrape
 * interval.
 */

@Injectable()
export class RequestRateLimiter {
  constructor(
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * Counts one request against its bucket, and refuses when the bucket is full.
   *
   * KEYED ON THE CUSTOMER WHEN THERE IS ONE, AND THIS IS A NIGERIA-SPECIFIC
   * DECISION rather than a general preference. Most of this platform's traffic
   * arrives over mobile data, and Nigerian carriers put their subscribers
   * behind carrier-grade NAT: an entire MTN or Airtel pool leaves through a
   * handful of addresses. A per-address ceiling tight enough to stop one stolen
   * session would refuse a carrier's worth of customers, and one loose enough
   * not to would not be a ceiling. The account id is the thing that actually
   * names who is doing this, and a forged token cannot reach here to claim one.
   *
   * Unauthenticated routes have no account to key on, so they fall back to the
   * address — and their ceiling is deliberately generous for the reason above.
   * The tight limits on those routes are the PER-IDENTIFIER buckets in
   * `login-rate-limit.guard.ts`, which work correctly under NAT because an
   * identifier is not shared by a carrier.
   */
  async enforce(request: Request, subject: string | undefined, rateClass: RateClass): Promise<void> {
    const max = this.#max(rateClass);

    // Zero means unmetered — the probes always, and any class an operator
    // deliberately switches off during an incident.
    if (max <= 0) return;

    const key =
      subject === undefined
        ? `req:${rateClass}:ip:${addressOf(request)}`
        : `req:${rateClass}:user:${subject}`;

    const decision = await this.store.hit(
      key,
      max,
      this.config.requestRateLimit.windowSeconds,
      this.clock.nowMs(),
    );

    if (!decision.allowed) {
      // A DISTINCT CODE from the credential limiter's `too_many_attempts`. The
      // two mean different things to a customer and want different words on
      // screen: one is "you are going too fast", the other is "we have stopped
      // accepting guesses at this account". A client that could not tell them
      // apart would tell somebody whose app retried too eagerly that their
      // sign-in was blocked.
      throw new HttpException(
        { error: 'too_many_requests', retry_after_seconds: decision.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  #max(rateClass: RateClass): number {
    const limits = this.config.requestRateLimit;
    switch (rateClass) {
      case 'unmetered':
        return 0;
      case 'public':
        return limits.publicMax;
      case 'read':
        return limits.readMax;
      case 'write':
        return limits.writeMax;
      case 'money':
        return limits.moneyMax;
      case 'staff':
        return limits.staffMax;
    }
  }
}

/**
 * The caller's address, as Express resolved it.
 *
 * `request.ip` honours the `trust proxy` hop count set in `main.ts`, which is
 * why that number is explicit configuration rather than `true`: too high and
 * this value is whatever the client typed into a header.
 */
function addressOf(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? 'unknown';
}
