import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { MetricsService } from './metrics.service.js';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

/** Long enough that a fifteen-second scraper is served from memory, short
 *  enough that an operator watching an incident sees it move. */
const CACHE_MS = 10_000;

/**
 * Metrics, for whatever is watching.
 *
 * PUBLIC IN THE ROUTE POLICY AND GUARDED BY ITS OWN TOKEN — the shape the
 * webhooks already use, and for the same reason: a scraper has no session to
 * present, so bearer-token-in-config is the only credential it can hold.
 *
 * NOT ACTUALLY PUBLIC, though. This publishes queue depths, provider health
 * and what the platform owes customers, which is a business-intelligence leak
 * to anything that can route to the instance — and a non-zero drift figure
 * published openly tells somebody the books are inconsistent before we have
 * noticed ourselves.
 *
 * WITH NO TOKEN CONFIGURED IT ANSWERS 404, not 401. An unconfigured endpoint
 * that answered 401 would confirm to a prober that it exists and is worth
 * coming back to; 404 is the truthful answer, because with no token there is
 * nothing here to authorise against. Defaulting to open was never on the
 * table: an endpoint that works is an endpoint nobody checks the guard on.
 */
@Controller()
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  async scrape(@Req() request: AuthenticatedRequest): Promise<string> {
    const expected = this.config.metricsToken;
    if (expected === undefined) throw new NotFoundException();

    const header = request.headers['authorization'];
    const presented =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';

    if (!constantTimeEquals(presented, expected)) {
      throw new UnauthorizedException();
    }
    return this.metrics.render(CACHE_MS);
  }
}

/**
 * Compares without leaking the answer in the timing.
 *
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * length oracle, so both sides are hashed to a fixed width first. This is a
 * static token that does not rotate on use — the one credential in the system
 * where an attacker gets unlimited attempts at a fixed string.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) {
    // Still compare something of equal length, so a wrong length costs the
    // same as a wrong value.
    timingSafeEqual(right, right);
    return false;
  }
  return timingSafeEqual(left, right);
}
