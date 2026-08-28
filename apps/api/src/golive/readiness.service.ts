import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';
import { CHECKLIST, type Failure, type Item } from './go-live-checklist.js';

/**
 * WHAT THIS DEPLOYMENT HAS NOT BEEN TOLD YET.
 *
 * A checklist in a document is a list somebody reads once. This asks the same
 * questions of THE RUNNING PROCESS — which is the only thing that can answer
 * them, because the failure being guarded against is not "nobody read the
 * document" but "somebody read it, set the variable on the wrong instance, and
 * has no way to find out".
 *
 * It imports the same table `go-live.test.ts` holds to the code, so the
 * document, the build-time check and this cannot describe three different
 * systems. Adding a setting adds a row here.
 *
 * IT REPORTS; IT NEVER REFUSES. A readiness check that could stop the API
 * starting would be a new way to take the platform down at three in the
 * morning, and the things it looks at are deliberately the ones that are safe
 * to be missing for a while — a fee nobody set, a worker on no instance. What
 * genuinely cannot be missing already refuses at boot, in `config.ts`.
 *
 * WHAT IT CANNOT SEE, said out loud rather than implied. It reads the
 * environment of THE PROCESS ANSWERING, so on a deployment where `api` and
 * `worker` are separate containers — which is the arrangement the deployment
 * config ships — every worker interval reads as unset here and is correctly
 * set on the worker. That is why the worker rows carry `singleInstance` and
 * why the response says which instance answered rather than pretending to
 * speak for the deployment.
 */

export type State =
  /** Set, or done. Nothing to do. */
  | 'set'
  /** Not set, and the checklist says that costs something. */
  | 'unset'
  /**
   * Not set here, and it belongs on one instance. Not a finding on its own —
   * it is a finding only if no instance has it.
   */
  | 'unset-here'
  /**
   * Nothing can look at this from inside the process: a role granted to a
   * person, a lawyer having read a page, a restore having been rehearsed.
   */
  | 'not-observable';

export interface Row {
  readonly name: string;
  readonly kind: Item['kind'];
  readonly failure: Failure;
  readonly state: State;
  readonly ifMissed: string;
  readonly flow?: string;
}

export interface Readiness {
  /** Which process answered. A worker and an api answer differently. */
  readonly instance: { readonly environment: string; readonly hostname: string };
  readonly rows: readonly Row[];
  readonly summary: {
    readonly unset: number;
    readonly unsetHere: number;
    readonly notObservable: number;
    /** Of the unset ones, how many fail SILENTLY. The number to act on. */
    readonly silentAndUnset: number;
  };
}

@Injectable()
export class ReadinessService {
  readonly #pool: Pool;

  constructor(@Inject(DATABASE) pool: Pool) {
    this.#pool = pool;
  }

  /**
   * Read at CALL TIME, not captured in the constructor.
   *
   * And not a constructor parameter either, however convenient that would be
   * for a test: esbuild does not emit `design:paramtypes`, so an undecorated
   * parameter is one Nest silently leaves undefined — which works, until
   * somebody adds `@Inject` above it and the defaults stop applying. Every
   * injected dependency in this codebase carries an explicit token, and this
   * is not a dependency.
   */
  get #env(): NodeJS.ProcessEnv {
    return process.env;
  }

  async report(): Promise<Readiness> {
    // Read once. Asking per row would be fifty round trips for a screen.
    const settings = await this.#settings();
    const credentials = await this.#credentials();

    const rows = CHECKLIST.map((item): Row => {
      const base = {
        name: item.name,
        kind: item.kind,
        failure: item.failure,
        ifMissed: item.ifMissed,
        ...(item.flow === undefined ? {} : { flow: item.flow }),
      };
      return { ...base, state: this.#stateOf(item, settings, credentials) };
    });

    const count = (s: State): number => rows.filter((r) => r.state === s).length;
    return {
      instance: {
        environment: this.#env['XETRAL_ENVIRONMENT'] ?? 'unknown',
        // Which box, so an operator comparing two answers knows which is which.
        hostname: this.#env['HOSTNAME'] ?? 'unknown',
      },
      rows,
      summary: {
        unset: count('unset'),
        unsetHere: count('unset-here'),
        notObservable: count('not-observable'),
        silentAndUnset: rows.filter((r) => r.state === 'unset' && r.failure === 'silent').length,
      },
    };
  }

  #stateOf(item: Item, settings: Set<string>, credentials: Set<string>): State {
    switch (item.kind) {
      case 'action':
        // A role granted to a person, a page a lawyer read, a drill that was
        // run. Reported so they are not forgotten, never guessed at.
        return 'not-observable';
      case 'setting':
        return settings.has(item.name) ? 'set' : 'unset';
      case 'credential':
        return credentials.has(item.name) ? 'set' : 'unset';
      case 'env': {
        // The family, not a variable: at least one chain configured counts.
        if (item.name.endsWith('*')) {
          const prefix = item.name.slice(0, -1);
          const any = Object.keys(this.#env).some(
            (k) => k.startsWith(prefix) && (this.#env[k] ?? '') !== '',
          );
          return any ? 'set' : 'unset';
        }
        const value = this.#env[item.name];
        if (value !== undefined && value !== '') return 'set';
        return item.singleInstance === true ? 'unset-here' : 'unset';
      }
    }
  }

  /**
   * Which settings have a row. NOT which have a non-default value — every one
   * of these is seeded, so "has a row" is true of all of them and the useful
   * question is whether one is MISSING, which happens when a migration has not
   * been applied.
   */
  async #settings(): Promise<Set<string>> {
    const result = await this.#pool.query<{ key: string }>('SELECT key FROM platform_settings');
    return new Set(result.rows.map((r) => r.key));
  }

  /**
   * Which credential slots are satisfied. It reads whether a secret EXISTS and
   * never the secret: a credential goes in and does not come back out over
   * HTTP, and a readiness screen is exactly the sort of place that rule gets
   * quietly broken.
   *
   * THE ENVIRONMENT COUNTS, and leaving it out was the first version's bug.
   * The database is authoritative and the environment is the fallback — that
   * is the whole reason a key can be replaced during an incident without a
   * deploy — so a slot filled only by `BITNOB_API_KEY` is a slot that WORKS,
   * and reporting it as missing would put a false finding on the screen of
   * every deployment that has not yet used the dashboard. A check that is
   * wrong about a working system is a check people stop opening.
   *
   * The slot's own `env_var` column is what makes that answerable without a
   * second list here that could disagree with the catalogue.
   */
  async #credentials(): Promise<Set<string>> {
    const result = await this.#pool.query<{
      provider: string;
      name: string;
      env_var: string;
      stored: boolean;
    }>(
      `SELECT s.provider, s.name, s.env_var,
              (c.provider IS NOT NULL) AS stored
         FROM provider_credential_slots s
         LEFT JOIN provider_credentials c
           ON c.provider = s.provider AND c.name = s.name`,
    );
    const satisfied = new Set<string>();
    for (const row of result.rows) {
      const fromEnv = (this.#env[row.env_var] ?? '') !== '';
      if (row.stored || fromEnv) satisfied.add(`${row.provider}.${row.name}`);
    }
    return satisfied;
  }
}
