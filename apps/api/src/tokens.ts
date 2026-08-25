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
export const CARD_PORT = Symbol('CARD_PORT');
/** A ReadonlyMap<ServiceKind, FulfilmentPort>: one entry per service the
 *  instance is configured for. A missing entry refuses that service's routes,
 *  which is a better answer than a placeholder adapter that fails on the
 *  first real call. */
export const FULFILMENT_PORTS = Symbol('FULFILMENT_PORTS');
/** The bank rail. One per instance — a customer has one dedicated account. */
export const FUNDING_PORT = Symbol('FUNDING_PORT');
/** On-chain assets. One per instance. */
export const CRYPTO_PORT = Symbol('CRYPTO_PORT');
/** FX rates and swaps. One per instance. */
export const FX_PORT = Symbol('FX_PORT');
/** Email. Undefined when no provider is configured, which disables password
 *  reset — there is no other way to prove control of an address. */
export const NOTIFICATION_PORT = Symbol('NOTIFICATION_PORT');
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
