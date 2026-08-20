/**
 * Dependency-injection tokens.
 *
 * Every injected dependency in this app is named by an explicit token rather
 * than inferred from a constructor parameter's type. NestJS's usual style
 * relies on `emitDecoratorMetadata` to record `design:paramtypes`, and esbuild
 * — which is what vitest transpiles with — does not emit that metadata. Code
 * that depends on it compiles fine and fails at runtime with an unhelpful
 * "cannot resolve dependency at index 0".
 *
 * Explicit tokens sidestep the whole problem and read better besides: what is
 * being injected is stated, not derived.
 */
export const API_CONFIG = Symbol('API_CONFIG');
export const DATABASE = Symbol('DATABASE');
export const ROUTE_POLICY = Symbol('ROUTE_POLICY');
export const RATE_LIMIT_STORE = Symbol('RATE_LIMIT_STORE');
export const LEDGER = Symbol('LEDGER');
export const CLOCK = Symbol('CLOCK');

/** Injected rather than read from Date.now() so expiry and rate-limit windows
 *  are testable without sleeping. */
export interface Clock {
  nowMs(): number;
  nowSeconds(): number;
}

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  nowSeconds: () => Math.floor(Date.now() / 1000),
};
