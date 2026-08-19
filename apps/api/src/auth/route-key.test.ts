import { METHOD_METADATA as NEST_METHOD_METADATA, PATH_METADATA as NEST_PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it } from 'vitest';
import { METHOD_METADATA, PATH_METADATA, buildRoutePath } from './route-key.js';

describe('nest metadata keys', () => {
  it('still match the constants Nest itself writes', () => {
    // route-key.ts hardcodes these because the constants module is not
    // resolvable under native ESM, so importing it there would fail at boot
    // rather than in CI. This is the canary for that trade: if Nest ever
    // renames a key, this fails here instead of silently denying every route
    // in production.
    expect(PATH_METADATA).toBe(NEST_PATH_METADATA);
    expect(METHOD_METADATA).toBe(NEST_METHOD_METADATA);
  });
});

describe('route path assembly', () => {
  it('joins a controller prefix and a handler path', () => {
    expect(buildRoutePath('v1/auth', 'login')).toBe('/v1/auth/login');
  });

  it('normalises the leading and trailing slashes Nest emits', () => {
    // Nest stores '/' for a handler with no path of its own, and tolerates a
    // leading slash on either part. All four spellings must produce the same
    // key, or a policy declared one way silently fails to match.
    expect(buildRoutePath('/v1/auth', '/')).toBe('/v1/auth');
    expect(buildRoutePath('v1/auth/', '/logout')).toBe('/v1/auth/logout');
    expect(buildRoutePath('/v1/auth/', 'logout/')).toBe('/v1/auth/logout');
    expect(buildRoutePath('v1/auth', '/logout')).toBe('/v1/auth/logout');
  });

  it('handles a controller mounted at the root', () => {
    expect(buildRoutePath('/', 'health')).toBe('/health');
    expect(buildRoutePath('', 'health')).toBe('/health');
  });

  it('keeps parameter templates rather than concrete values', () => {
    // The policy is declared against the template. If this ever returned a
    // concrete URL, every customer id would need its own declaration.
    expect(buildRoutePath('v1/cards', ':id/freeze')).toBe('/v1/cards/:id/freeze');
  });
});
