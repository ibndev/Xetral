import { ApiError, SessionExpiredError, toApiError } from './errors.js';
import type { XetralCountry } from './client.js';

/**
 * Holding a session, and refreshing it exactly once.
 *
 * THIS FILE EXISTS BECAUSE OF A DELIBERATE SERVER-SIDE DECISION. Refresh
 * tokens rotate on every use, and presenting a consumed one revokes the whole
 * device family — because a token used twice is a token that was stolen. The
 * accepted cost, recorded in Phase 2, is that a client racing its own refresh
 * logs itself out, and the fix belongs HERE rather than in a weaker check
 * there.
 *
 * So: when several requests find their access token expired at once, exactly
 * one refresh is sent and the rest await it. Without that, a screen that fires
 * four requests on mount sends four refreshes with the same token, the server
 * correctly reads three of them as reuse, and the customer is signed out for
 * opening a page.
 */

export interface Tokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Epoch seconds. Used to refresh BEFORE a 401 rather than after one. */
  readonly expiresAt: number;
}

/**
 * Where tokens live between launches.
 *
 * An interface rather than a concrete store, because the right answer differs
 * per platform and both are security decisions: iOS and Android use the
 * Keychain and Keystore through Expo SecureStore, and the web uses memory plus
 * an httpOnly cookie — never `localStorage`, which any injected script can
 * read.
 */
export interface TokenStore {
  read(): Promise<Tokens | undefined>;
  write(tokens: Tokens): Promise<void>;
  clear(): Promise<void>;
}

/** Refresh this many seconds before expiry, rather than waiting for a 401.
 *  Covers clock skew and a slow request without being so eager that a token is
 *  rotated on every call. */
const REFRESH_SKEW_SECONDS = 60;

export interface SessionOptions {
  readonly baseUrl: string;
  readonly store: TokenStore;
  readonly fetch?: typeof fetch;
  /** Injected so expiry is testable without waiting. */
  readonly nowSeconds?: () => number;
  /** Called when the session is gone for good, so the app can navigate to
   *  sign-in from one place rather than at every call site. */
  readonly onSignedOut?: () => void;
}

export class Session {
  readonly #baseUrl: string;
  readonly #store: TokenStore;
  readonly #fetch: typeof fetch;
  readonly #nowSeconds: () => number;
  readonly #onSignedOut: (() => void) | undefined;

  /** THE single-flight latch. Non-undefined means a refresh is in the air and
   *  every other caller must await this promise rather than start another. */
  #refreshing: Promise<Tokens> | undefined;

  constructor(options: SessionOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#store = options.store;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.#nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#onSignedOut = options.onSignedOut;
  }

  /**
   * Opens an account and signs straight into it.
   *
   * The response is the same token pair `signIn` returns, so registration ends
   * with a live session rather than bouncing the customer to a sign-in form
   * they have just filled in. Identity documents are NOT sent here — KYC is a
   * separate, reviewed step, and folding it into registration would make a
   * regulatory decision a side effect of choosing a password.
   */
  /**
   * The countries a customer may sign up from.
   *
   * ON `Session` RATHER THAN `XetralClient`, because it is read BEFORE
   * anybody has signed in and `XetralClient` requires a session to construct.
   * It is also the only call here that carries no token: attaching one would
   * make the signup form's first request trigger a refresh against an empty
   * store, which on the web means exchanging a cookie that is not there.
   *
   * A hardcoded list in the two signup forms would have been less code and
   * would have made "add a country without a deploy" true of the database and
   * false of the only screen it matters on.
   */
  async countries(): Promise<readonly XetralCountry[]> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/countries`, {
      headers: { accept: 'application/json' },
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response.status, body);
    return (body as { countries: readonly XetralCountry[] }).countries;
  }

  async register(input: {
    email: string;
    password: string;
    fullName: string;
    /** ISO 3166-1 alpha-2, from `countries()`. */
    country: string;
    /** NATIONAL digits only. The dialling code comes from the country, and
     *  the two are joined server-side — see the register DTO for why. */
    phone: string;
    device: { fingerprint: string; platform: string };
  }): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: input.email,
        password: input.password,
        full_name: input.fullName,
        country: input.country,
        phone: input.phone,
        device: input.device,
      }),
    });

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response.status, body);

    await this.#store.write(this.#toTokens(body));
  }

  async signIn(
    identifier: string,
    password: string,
    device: { fingerprint: string; platform: string },
  ): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier, password, device }),
    });

    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw toApiError(response.status, body);

    await this.#store.write(this.#toTokens(body));
  }

  async signOut(): Promise<void> {
    const tokens = await this.#store.read();
    // Clear locally FIRST. If the network call fails the customer must still
    // end up signed out on this device — the opposite order leaves them
    // holding live tokens because a request timed out.
    await this.#store.clear();

    if (tokens !== undefined) {
      await this.#fetch(`${this.#baseUrl}/v1/auth/logout`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${tokens.accessToken}`,
        },
        body: JSON.stringify({ refresh_token: tokens.refreshToken }),
      }).catch(() => undefined);
    }
  }

  /** A valid access token, refreshing first if it is close to expiring. */
  async accessToken(): Promise<string> {
    const tokens = await this.#store.read();
    if (tokens === undefined) {
      this.#onSignedOut?.();
      throw new SessionExpiredError();
    }

    if (tokens.expiresAt - REFRESH_SKEW_SECONDS > this.#nowSeconds()) {
      return tokens.accessToken;
    }
    return (await this.refresh()).accessToken;
  }

  /**
   * Rotates the refresh token — at most once at a time.
   *
   * Every caller arriving while one is in flight gets the SAME promise. The
   * latch is cleared in a `finally` so a failed refresh does not wedge the
   * session into a state where no further attempt is possible.
   */
  async refresh(): Promise<Tokens> {
    if (this.#refreshing !== undefined) return this.#refreshing;

    this.#refreshing = this.#doRefresh().finally(() => {
      this.#refreshing = undefined;
    });
    return this.#refreshing;
  }

  async #doRefresh(): Promise<Tokens> {
    const current = await this.#store.read();
    if (current === undefined) {
      this.#onSignedOut?.();
      throw new SessionExpiredError();
    }

    const response = await this.#fetch(`${this.#baseUrl}/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: current.refreshToken }),
    });

    const body: unknown = await response.json().catch(() => undefined);

    if (!response.ok) {
      const error = toApiError(response.status, body);
      // `invalid_grant` means the token was consumed, expired or revoked —
      // including the case where this device's family was revoked because
      // somebody replayed a stolen token. There is nothing to retry: the
      // session is over and the customer signs in again.
      if (error.code === 'invalid_grant' || response.status === 401) {
        await this.#store.clear();
        this.#onSignedOut?.();
        throw new SessionExpiredError();
      }
      throw error;
    }

    const rotated = this.#toTokens(body);
    await this.#store.write(rotated);
    return rotated;
  }

  #toTokens(body: unknown): Tokens {
    if (typeof body !== 'object' || body === null) {
      throw new ApiError('unknown', 200, [], 'the sign-in response had no body');
    }
    const record = body as Record<string, unknown>;
    const accessToken = record['access_token'];
    const refreshToken = record['refresh_token'];
    const expiresIn = record['expires_in'];

    if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
      throw new ApiError('unknown', 200, [], 'the sign-in response carried no tokens');
    }

    return {
      accessToken,
      refreshToken,
      expiresAt:
        this.#nowSeconds() + (typeof expiresIn === 'number' ? expiresIn : 900),
    };
  }
}

/** In-memory storage. The web default, and the right one there: `localStorage`
 *  is readable by any injected script, and a refresh token in it is a session
 *  somebody else can keep alive indefinitely. */
export class MemoryTokenStore implements TokenStore {
  #tokens: Tokens | undefined;

  async read(): Promise<Tokens | undefined> {
    return this.#tokens;
  }

  async write(tokens: Tokens): Promise<void> {
    this.#tokens = tokens;
  }

  async clear(): Promise<void> {
    this.#tokens = undefined;
  }
}
