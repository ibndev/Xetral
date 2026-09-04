import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool } from 'pg';
import {
  ProviderContractError,
  ProviderError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '@xetral/providers';
import { DATABASE } from '../tokens.js';

/**
 * Records whether a provider answered.
 *
 * WHAT THIS EXISTS FOR is that every kill switch has to be flipped by hand,
 * which means noticing first — and nothing recorded whether a provider call
 * succeeded, so "is Bitnob down?" was answered by reading logs and the first
 * reliable signal was a customer saying so.
 *
 * A REJECTION IS NOT A FAILURE. `ProviderRejectedError` means the provider
 * understood the request and refused it: insufficient float, a frozen card, a
 * declined authorization. It is counted, and deliberately not counted as ill
 * health — an alert that fires every time a customer's card is declined is one
 * people mute.
 *
 * RECORDING CAN NEVER FAIL THE CALL IT RECORDS. Every error out of the write
 * is swallowed, the same rule `ErrorRecorder` follows: the reporter is not
 * more important than the thing it reports on, and a broken health table must
 * not stop somebody moving money.
 */
@Injectable()
export class ProviderHealthService {
  readonly #logger = new Logger(ProviderHealthService.name);

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  async record(
    provider: string,
    operation: string,
    outcome: 'succeeded' | 'unavailable' | 'timed_out' | 'contract' | 'rejected',
    error?: string,
  ): Promise<void> {
    try {
      await this.pool.query(`SELECT record_provider_call($1, $2, $3, $4)`, [
        provider,
        operation,
        outcome,
        // Truncated: the point of a bucket is that it is a count, and a
        // provider that answers with a page of HTML would otherwise put it
        // here.
        error === undefined ? null : error.slice(0, 500),
      ]);
    } catch (caught) {
      this.#logger.warn(`could not record provider health: ${String(caught)}`);
    }
  }

  async recent(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT provider, operation, attempts::text, succeeded::text, rejected::text,
              unavailable::text, timed_out::text, contract::text, failures::text,
              failure_percent, last_seen, last_error
         FROM provider_health_recent`,
    );
    return rows.rows as Record<string, unknown>[];
  }

  async degraded(): Promise<readonly Record<string, unknown>[]> {
    const rows = await this.pool.query(
      `SELECT provider, operation, attempts::text, failures::text, failure_percent,
              last_error, contract_broken
         FROM provider_degraded`,
    );
    return rows.rows as Record<string, unknown>[];
  }
}

/** What a thrown error means for the provider's health. */
export function outcomeOf(
  error: unknown,
): 'unavailable' | 'timed_out' | 'contract' | 'rejected' | undefined {
  if (error instanceof ProviderRejectedError) return 'rejected';
  if (error instanceof ProviderTimeoutError) return 'timed_out';
  if (error instanceof ProviderContractError) return 'contract';
  if (error instanceof ProviderUnavailableError) return 'unavailable';
  /*
   * A ProviderError subclass nobody has classified here, or an ordinary
   * exception from our own code inside the adapter. Returning undefined means
   * NOT RECORDED rather than recorded as healthy or as an outage: guessing
   * either way puts a number on the dashboard that is not about the provider.
   */
  if (error instanceof ProviderError) return 'unavailable';
  return undefined;
}

/**
 * Wraps a port so every call it makes is recorded.
 *
 * A PROXY RATHER THAN SEVEN HAND-WRITTEN WRAPPERS, and the argument is the one
 * this codebase makes about contract suites: three hand-written suites drift
 * into testing three behaviours while all staying green. Seven wrappers — for
 * cards, crypto, FX, funding, fulfilment, balances and notifications — would
 * drift the same way, and the one that drifts is the one nobody looks at.
 * More to the point, a method ADDED to a port later would silently not be
 * recorded, which is the failure this whole file exists to prevent.
 *
 * It wraps only functions and passes everything else through, so a port with
 * ordinary properties or a type guard like `supportsVerification()` keeps
 * working. The health write is FIRE AND FORGET: awaiting it would put a
 * database round trip in front of every provider response, and a slow health
 * table would become a slow card.
 *
 * THE RECEIVER IS THE TARGET, NEVER THE PROXY, AND THAT ONE ARGUMENT BROKE
 * OPENING A NAIRA ACCOUNT FOR EVERY CUSTOMER.
 *
 * `Reflect.get(target, property, receiver)` runs a GETTER with `this` bound to
 * the receiver. Passed the proxy — which is what a `get` trap is handed, and
 * what every example on the internet forwards — a getter that reads a PRIVATE
 * field executes against an object that does not have one, and JavaScript
 * answers:
 *
 *   TypeError: Cannot read private member #fallback from an object whose
 *   class did not declare it
 *
 * `SwitchingFundingPort.provider` and `SwitchingPayoutPort.provider` are
 * exactly that: a getter over `#fallback`. So `this.port.provider` threw on
 * every read — and it is read while BUILDING the customer record, before the
 * provider is ever called, so the failure looked like the rail refusing and
 * pointed every investigation at Paystack. Bank payouts and crypto read it
 * too.
 *
 * The method path was never affected, because it applies against `target`
 * explicitly. That is why this survived: the calls worked and the property
 * did not, which is not a shape anybody looks for.
 *
 * A private field is deliberately NOT proxy-transparent — it is the one part
 * of an object a proxy cannot forward — so the only correct receiver here is
 * the target itself.
 */
export function watched<T extends object>(
  port: T,
  provider: string,
  health: ProviderHealthService,
): T {
  return new Proxy(port, {
    get(target, property, receiver): unknown {
      // `target`, NOT `receiver`. See the header: forwarding the proxy makes
      // every getter over a private field throw. `receiver` is accepted and
      // ignored so the signature still documents what a trap is handed.
      void receiver;
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function' || typeof property !== 'string') return value;

      return (...args: unknown[]): unknown => {
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);

        // Synchronous methods — the type guards — are not provider calls and
        // are left alone rather than recorded as instant successes.
        if (!(result instanceof Promise)) return result;

        return result.then(
          (resolved) => {
            void health.record(provider, property, 'succeeded');
            return resolved;
          },
          (error: unknown) => {
            const outcome = outcomeOf(error);
            if (outcome !== undefined) {
              void health.record(
                provider,
                property,
                outcome,
                error instanceof Error ? error.message : String(error),
              );
            }
            throw error;
          },
        );
      };
    },
  });
}
