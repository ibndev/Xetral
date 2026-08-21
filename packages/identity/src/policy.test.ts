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
    });
  });

  it('carries the PIN requirement through to the decision', () => {
    const registry = new RoutePolicyRegistry().authenticated('POST', '/v1/transfers', { pin: true });
    const decision = registry.decide('POST', '/v1/transfers');
    expect(decision).toEqual({ allow: true, mode: 'authenticated', requiresPin: true });
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
