import { describe, expect, it } from 'vitest';
import { RoutePolicyError, RoutePolicyRegistry } from './policy.js';

describe('deny by default', () => {
  it('denies a route nobody declared', () => {
    // The whole point. Forgetting to declare a route produces a 403 in the
    // first test run, not an open endpoint in production.
    const registry = new RoutePolicyRegistry();
    expect(registry.decide('POST', '/v1/transfers')).toEqual({
      allow: false,
      reason: 'undeclared_route',
    });
  });

  it('denies a route declared under a different method', () => {
    // GET /v1/cards being public says nothing about POST /v1/cards. Matching
    // on path alone is how a read endpoint's exemption leaks onto a write one.
    const registry = new RoutePolicyRegistry().public(
      'GET',
      '/v1/status',
      'uptime probe, returns no customer data',
    );
    expect(registry.decide('POST', '/v1/status').allow).toBe(false);
  });

  it('allows an explicitly authenticated route', () => {
    const registry = new RoutePolicyRegistry().authenticated('GET', '/v1/wallets', { pin: false });
    expect(registry.decide('GET', '/v1/wallets')).toEqual({
      allow: true,
      mode: 'authenticated',
      requiresPin: false,
      requiresElevation: true,
    });
  });

  it('carries the PIN requirement through to the decision', () => {
    const registry = new RoutePolicyRegistry().authenticated('POST', '/v1/transfers', { pin: true });
    const decision = registry.decide('POST', '/v1/transfers');
    expect(decision).toEqual({
      allow: true,
      mode: 'authenticated',
      requiresPin: true,
      requiresElevation: true,
    });
  });
});

describe('opting out of auth is deliberate', () => {
  it('requires a written justification', () => {
    const registry = new RoutePolicyRegistry();
    expect(() => registry.public('POST', '/v1/login', '')).toThrow(RoutePolicyError);
    expect(() => registry.public('POST', '/v1/login', 'ok')).toThrow(/justification/);
  });

  it('lists every public route for review', () => {
    // The audit the reference plugin never had: 45 routes with
    // `permission_callback => '__return_true'` and no way to enumerate them.
    const registry = new RoutePolicyRegistry()
      .public('POST', '/v1/auth/login', 'issues the first session; cannot require one')
      .public('GET', '/v1/status', 'uptime probe, returns no customer data')
      .authenticated('POST', '/v1/transfers', { pin: true });

    const audit = registry.publicRouteAudit();
    expect(audit).toHaveLength(2);
    expect(audit.map((r) => r.path)).toEqual(['/v1/status', '/v1/auth/login']);
    expect(audit[0]?.justification).toMatch(/uptime probe/);
  });
});

describe('unambiguous policy', () => {
  it('refuses to declare the same route twice', () => {
    // Last-write-wins would let a module loaded later quietly downgrade a route
    // another module secured, making the effective policy depend on import
    // order -- which no reviewer can see in a diff.
    const registry = new RoutePolicyRegistry().authenticated('POST', '/v1/transfers', {
      pin: true,
    });
    expect(() => registry.authenticated('POST', '/v1/transfers', { pin: false })).toThrow(
      /already declared/,
    );
    expect(() => registry.public('POST', '/v1/transfers', 'a plausible sounding reason')).toThrow(
      RoutePolicyError,
    );
  });

  it('keeps the original policy after a rejected redeclaration', () => {
    const registry = new RoutePolicyRegistry().authenticated('POST', '/v1/transfers', {
      pin: true,
    });
    try {
      registry.public('POST', '/v1/transfers', 'attempting to loosen this route');
    } catch {
      // expected
    }
    expect(registry.decide('POST', '/v1/transfers')).toEqual({
      allow: true,
      mode: 'authenticated',
      requiresPin: true,
      requiresElevation: true,
    });
  });

  it('exposes the declared set so it can be diffed against the router', () => {
    // Catches the opposite mistake: a policy declared for a route that no
    // longer exists, which makes the audit list lie.
    const registry = new RoutePolicyRegistry()
      .authenticated('GET', '/v1/wallets', { pin: false })
      .public('GET', '/v1/status', 'uptime probe, returns no customer data');
    expect(registry.declaredRoutes()).toEqual(['GET /v1/status', 'GET /v1/wallets']);
  });
});

describe('how many factors an acting staff route takes', () => {
  it('demands the code by DEFAULT, so forgetting keeps the strict answer', () => {
    /*
     * THE DIRECTION THIS DEFAULTS IN IS THE WHOLE SAFETY ARGUMENT. A route
     * that omits `stepUp` keeps both factors; losing one has to be written
     * down. Reading an absent field the other way round would make a
     * forgotten declaration quietly weaker — the rule 017 states about rate
     * classes, where forgetting fails open and so must be impossible.
     */
    const registry = new RoutePolicyRegistry().staff('POST', '/v1/admin/settings/:key', {
      pin: true,
      role: 'admin',
    });
    const decision = registry.decide('POST', '/v1/admin/settings/:key');
    expect(decision).toMatchObject({ requiresPin: true, requiresElevation: true });
  });

  it('drops the code only where a route says so out loud', () => {
    const registry = new RoutePolicyRegistry().staff('POST', '/v1/admin/prices/fx', {
      pin: true,
      role: 'finance',
      stepUp: 'pin',
    });
    // The PIN is still verified on the request. What goes is the THIRD factor
    // on a button an operator presses several times in a sitting.
    expect(registry.decide('POST', '/v1/admin/prices/fx')).toMatchObject({
      requiresPin: true,
      requiresElevation: false,
    });
  });

  it('refuses a single step-up on a route that takes no PIN at all', () => {
    // That combination asks for nothing beyond the session. Refused where it
    // is declared rather than discovered in production.
    const registry = new RoutePolicyRegistry();
    expect(() =>
      registry.staff('GET', '/v1/admin/prices', { pin: false, role: 'finance', stepUp: 'pin' }),
    ).toThrow(RoutePolicyError);
  });

  it('lists every reduced-factor route, the way it lists every public one', () => {
    // A surface where the factors were deliberately reduced has to be
    // enumerable, or nobody reviews it.
    const registry = new RoutePolicyRegistry()
      .staff('POST', '/v1/admin/prices/fx', { pin: true, role: 'finance', stepUp: 'pin' })
      .staff('POST', '/v1/admin/users/:id/freeze', { pin: true, role: 'compliance' });

    expect(registry.singleFactorRouteAudit()).toEqual([
      { method: 'POST', path: '/v1/admin/prices/fx' },
    ]);
  });
});
