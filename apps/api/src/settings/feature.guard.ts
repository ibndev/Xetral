import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { routeKeyOf } from '../auth/route-key.js';
import { SettingsService } from './settings.service.js';
import type { KillSwitch } from './settings.service.js';

/**
 * THE CUSTOMER ROUTES EACH SERVICE OWNS, by path prefix.
 *
 * Staff routes (`/v1/admin/…`) and provider webhooks (`/v1/webhooks/…`) are
 * not under any of these, deliberately: an operator must still be able to
 * see and resolve what a hidden service holds, and money a provider reports
 * as having moved is recorded whatever any screen shows — the rule
 * `kill-switches.test.ts` already holds the webhook path to.
 */
export const FEATURE_ROUTES: Readonly<Record<KillSwitch, readonly string[]>> = {
  crypto: ['/v1/crypto'],
  fx: ['/v1/fx'],
  cards: ['/v1/cards'],
  bills: ['/v1/purchases'],
  payouts: ['/v1/payouts'],
};

/** The service a route template belongs to, or undefined. */
export function featureOfRoute(path: string): KillSwitch | undefined {
  for (const [service, prefixes] of Object.entries(FEATURE_ROUTES) as [KillSwitch, readonly string[]][]) {
    if (prefixes.some((p) => path === p || path.startsWith(`${p}/`))) return service;
  }
  return undefined;
}

/**
 * A HIDDEN SERVICE IS NOT REACHABLE, not merely not drawn.
 *
 * Coming soon refuses what moves money and leaves the reads — a paused crypto
 * screen still shows what somebody holds, and a paused card can still be
 * frozen. Hidden is a different statement: the product is not offered here at
 * all, so EVERY customer route it owns answers as a route that does not exist.
 * A hidden service whose endpoints still answered would be hidden in the
 * clients we ship and visible to anybody holding a token and a URL.
 *
 * 404 `not_found` rather than a named refusal, so the answer does not say
 * what is hidden. Registered after `AuthGuard`, so an unauthenticated caller
 * is still refused for that first and learns nothing here.
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const route = routeKeyOf(context);
    if (route === undefined) return true;
    const service = featureOfRoute(route.path);
    if (service === undefined) return true;
    if ((await this.settings.serviceState(service)) === 'hidden') {
      throw new NotFoundException({ error: 'not_found' });
    }
    return true;
  }
}
