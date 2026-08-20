import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AuthController } from './auth.controller.js';
import { WalletController } from '../wallet/wallet.controller.js';
import { CardController, CardWebhookController } from '../cards/card.controller.js';
import { PurchaseController } from '../purchases/purchase.controller.js';
import {
  GiftCardController,
  GiftCardReviewController,
} from '../giftcards/giftcard.controller.js';
import {
  DepositWebhookController,
  FundingController,
} from '../funding/funding.controller.js';
import { METHOD_METADATA, PATH_METADATA, buildRoutePath } from './route-key.js';
import { buildRoutePolicy } from './routes.js';

/**
 * Keeps the declared policy and the actual router in step, in BOTH directions.
 *
 * AuthGuard already denies an undeclared route at runtime, which is the safe
 * behaviour but a late one: the symptom is a 403 that a developer discovers by
 * hitting the endpoint. This turns the same mistake into a failing build.
 *
 * The reverse check matters just as much. A policy for a route that no longer
 * exists makes `publicRouteAudit()` describe a surface that is not there, and
 * an audit nobody can trust is worse than no audit — it invites the reader to
 * stop reading it.
 */

// Every controller the app mounts. Missing one here would let its routes go
// undeclared without failing this test -- so app.module.ts and this list are
// the pair that must stay in step.
const CONTROLLERS = [
  AuthController,
  WalletController,
  CardController,
  CardWebhookController,
  PurchaseController,
  GiftCardController,
  GiftCardReviewController,
  FundingController,
  DepositWebhookController,
];

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.DELETE]: 'DELETE',
};

/** Walks a controller class the way Nest's router does. */
function routesOf(controller: new (...args: never[]) => object): string[] {
  const controllerPath = Reflect.getMetadata(PATH_METADATA, controller) as string;
  const prototype = controller.prototype as Record<string, unknown>;

  return Object.getOwnPropertyNames(prototype)
    .filter((name) => name !== 'constructor')
    .flatMap((name) => {
      const handler = prototype[name];
      if (typeof handler !== 'function') return [];

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
      const handlerPath = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
      if (method === undefined || handlerPath === undefined) return [];

      const verb = METHOD_NAMES[method];
      if (verb === undefined) return [];

      return [`${verb} ${buildRoutePath(controllerPath, handlerPath)}`];
    });
}

describe('policy covers the router', () => {
  const declared = new Set(buildRoutePolicy().declaredRoutes());
  const live = CONTROLLERS.flatMap(routesOf);

  it('finds the routes the controllers actually expose', () => {
    // Guards the walker itself: if this returned nothing, every other
    // assertion below would pass vacuously.
    expect(live.length).toBeGreaterThan(0);
    expect(live).toContain('POST /v1/auth/login');
  });

  it('declares a policy for every live route', () => {
    const undeclared = live.filter((route) => !declared.has(route));
    expect(undeclared).toEqual([]);
  });

  it('has no policy for a route that does not exist', () => {
    const orphaned = [...declared].filter((route) => !live.includes(route));
    expect(orphaned).toEqual([]);
  });
});

describe('the public surface is small and justified', () => {
  const audit = buildRoutePolicy().publicRouteAudit();

  it('lists exactly the routes reachable without signing in', () => {
    // This assertion is meant to fail when someone adds a public route. That
    // is not friction for its own sake: it forces the addition to be noticed
    // in review rather than merged as one line among forty.
    expect(audit.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'POST /v1/auth/login',
      'POST /v1/auth/refresh',
      'POST /v1/webhooks/bitnob',
      'POST /v1/webhooks/bitnob/deposits',
    ]);
  });

  it('explains every one of them', () => {
    for (const route of audit) {
      expect(route.justification.length).toBeGreaterThan(20);
    }
  });
});

describe('the privileged surface is declared as privileged', () => {
  const policy = buildRoutePolicy();
  const staffRoutes = policy.staffRouteAudit();

  /**
   * The structural half of the rule.
   *
   * `staff()` is what gates a route on a role, and forgetting it leaves an
   * approval endpoint reachable by any signed-in customer — authenticated, so
   * not obviously wrong in a diff, and catastrophic. Tying the guarantee to
   * the path prefix means the mistake cannot be made silently: an admin route
   * declared with `authenticated()` fails the build here.
   */
  it('gates every /v1/admin/ route on a staff role', () => {
    const admin = policy.declaredRoutes().filter((r) => r.includes(' /v1/admin/'));
    expect(admin.length).toBeGreaterThan(0);

    const gated = new Set(staffRoutes.map((r) => `${r.method} ${r.path}`));
    expect(admin.filter((r) => !gated.has(r))).toEqual([]);
  });

  /** And the converse: a staff-only route that is not under /v1/admin/ is a
   *  privileged endpoint hiding in the customer surface. */
  it('keeps the staff surface under one prefix', () => {
    const strays = staffRoutes
      .map((r) => `${r.method} ${r.path}`)
      .filter((r) => !r.includes(' /v1/admin/'));
    expect(strays).toEqual([]);
  });

  it('lists exactly the routes only staff can reach', () => {
    expect(staffRoutes.map((r) => `${r.method} ${r.path} (${r.role})`).sort()).toEqual([
      'GET /v1/admin/giftcards/queue (giftcard_reviewer)',
      'POST /v1/admin/giftcards/:id/clawback (giftcard_reviewer)',
      'POST /v1/admin/giftcards/:id/reveal (giftcard_reviewer)',
      'POST /v1/admin/giftcards/:id/review (giftcard_reviewer)',
    ]);
  });
});
