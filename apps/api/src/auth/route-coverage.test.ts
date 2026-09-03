import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { testApiConfig } from '../test-support/api-config.js';
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

/**
 * The controllers the app ACTUALLY mounts, read off the module.
 *
 * This was a hand-written array with a comment saying it and `app.module.ts`
 * "are the pair that must stay in step". They were not, and nothing noticed:
 * three controllers — health, KYC and the entire admin dashboard — were
 * imported into the module and left out of its `controllers` list, so every
 * one of their routes answered 404 in the built bundle while this file
 * happily walked them and reported full coverage.
 *
 * That is the whole failure mode a coverage test exists to prevent, reproduced
 * inside the coverage test. Reading the list from the module means the two
 * cannot disagree: a controller the app does not mount is a controller this
 * test does not see, and its policy then shows up as an orphan.
 */
function mountedControllers(): (new (...args: never[]) => object)[] {
  const module = AppModule.forRoot({
    // Never connected to. `forRoot` only needs a config to build the provider
    // list, and nothing here instantiates anything.
    config: testApiConfig('postgres://unused/unused'),
  });
  return (module.controllers ?? []) as (new (...args: never[]) => object)[];
}

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
  const live = mountedControllers().flatMap(routesOf);

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
      'GET /health',
      // Scraped by monitoring, which has no session. Guarded by METRICS_TOKEN
      // inside the handler and absent entirely when that is unset.
      'GET /metrics',
      'GET /ready',
      // The signup form needs the country list and its dialling codes before
      // anybody has an account. It carries no customer data.
      'GET /v1/countries',
      'POST /v1/auth/login',
      // Account recovery. Public because a customer who has lost their
      // password has no session to present; both answer 204 and neither
      // issues a token.
      'POST /v1/auth/password/forgot',
      'POST /v1/auth/password/reset',
      'POST /v1/auth/refresh',
      'POST /v1/auth/register',
      'POST /v1/webhooks/bitnob',
      'POST /v1/webhooks/bitnob/crypto',
      'POST /v1/webhooks/bitnob/deposits',
      'POST /v1/webhooks/paystack/deposits',
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
      'GET /v1/admin/audit (admin)',
      // A card's whole life, for the agent on the phone.
      'GET /v1/admin/cards/:id (support)',
      // Provider credentials. `admin` on all three: the write decides whether
      // money can move at all, and the reads are a map of which integrations
      // are live.
      // Who has not agreed to the words currently in force. `compliance`,
      // the same question as an outstanding KYC review.
      'GET /v1/admin/consents (compliance)',
      // Where the platform operates, as data. `admin` rather than a narrower
      // role because opening a country is a statement about where this
      // business does business, not an operational adjustment.
      'GET /v1/admin/countries (admin)',
      'GET /v1/admin/credentials (admin)',
      'GET /v1/admin/credentials/:provider/:name/rotations (admin)',
      // Data requests. `compliance`, and the acting routes take a PIN —
      // erasing is the one action here that cannot be undone by appending.
      'GET /v1/admin/data-requests (compliance)',
      // The complaints queue. Its own role rather than the gift card
      // reviewer's — a different job with a different risk.
      'GET /v1/admin/disputes (dispute_reviewer)',
      'GET /v1/admin/drift (finance)',
      // What is currently failing. `admin` because an error message describes
      // how the platform is built.
      'GET /v1/admin/errors (admin)',
      'GET /v1/admin/giftcards/queue (giftcard_reviewer)',
      'GET /v1/admin/kyc (compliance)',
      'GET /v1/admin/overview (support)',
      'GET /v1/admin/prices (finance)',
      // The compliance queue, on the role that already reviews identity.
      // Provider health. `support` — see routes.ts.
      'GET /v1/admin/providers (support)',
      // What this deployment has not been told yet. `admin` rather than
      // `support`, because it names every flow that is off and every
      // credential that is absent — a map of where the platform is soft.
      'GET /v1/admin/readiness (admin)',
      'GET /v1/admin/risk/cases (compliance)',
      'GET /v1/admin/risk/cases/:id (compliance)',
      'GET /v1/admin/risk/signals (compliance)',
      'GET /v1/admin/settings (finance)',
      'GET /v1/admin/settings/:key/history (finance)',
      'GET /v1/admin/staff (admin)',
      'GET /v1/admin/stuck (support)',
      'GET /v1/admin/suspense (finance)',
      // What was collected on a revenue authority's behalf is a finance
      // figure, not a support one.
      'GET /v1/admin/tax (finance)',
      'GET /v1/admin/users (support)',
      'GET /v1/admin/users/:id (support)',
      // Acknowledging a failure. No PIN: it hides nothing, because a
      // recurrence reopens the fingerprint by itself.
      // Upholding a dispute pays money out of our own account, so it takes a
      // PIN and — through the guard — a fresh second factor.
      // Freezing only. There is deliberately no staff terminate: it moves the
      // customer's money and cannot be undone.
      'POST /v1/admin/cards/:id/freeze (compliance)',
      'POST /v1/admin/countries (admin)',
      'POST /v1/admin/countries/:code (admin)',
      'POST /v1/admin/credentials/:provider/:name (admin)',
      'POST /v1/admin/data-requests/:id/erase (compliance)',
      'POST /v1/admin/data-requests/:id/resolve (compliance)',
      'POST /v1/admin/disputes/:id/resolve (dispute_reviewer)',
      'POST /v1/admin/errors/:fingerprint/resolve (admin)',
      'POST /v1/admin/giftcards/:id/clawback (giftcard_reviewer)',
      'POST /v1/admin/giftcards/:id/reveal (giftcard_reviewer)',
      'POST /v1/admin/giftcards/:id/review (giftcard_reviewer)',
      'POST /v1/admin/kyc/:id/review (compliance)',
      // Publishing a price. `finance`, and every write takes a PIN — nothing
      // in the application ever wrote either price table before this.
      'POST /v1/admin/prices/:id/retire (finance)',
      'POST /v1/admin/prices/fx (finance)',
      'POST /v1/admin/prices/giftcard (finance)',
      // Opening and noting take no PIN; closing does, because it resolves
      // every signal the case covers.
      'POST /v1/admin/risk/cases (compliance)',
      'POST /v1/admin/risk/cases/:id/close (compliance)',
      'POST /v1/admin/risk/cases/:id/notes (compliance)',
      'POST /v1/admin/risk/signals/:id/resolve (compliance)',
      'POST /v1/admin/settings/:key (finance)',
      'POST /v1/admin/staff/grant (admin)',
      'POST /v1/admin/staff/revoke (admin)',
      'POST /v1/admin/suspense/:id/attribute (finance)',
      'POST /v1/admin/users/:id/status (compliance)',
      // Deciding how much money may leave an account in a day.
      'POST /v1/admin/users/:id/tier (compliance)',
    ]);
  });
});
