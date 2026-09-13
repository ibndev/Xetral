import {
  ProviderContractError,
  ProviderRejectedError,
  ProviderTimeoutError,
  ProviderUnavailableError,
} from '../ports/errors.js';
/* The same two shapes `client.ts` declares, imported rather than redeclared:
   two exported names for one type is an ambiguity at the package boundary,
   and the copy that drifts is the one nobody watches. */
import type { FlutterwaveCredential, FlutterwaveFetch } from './client.js';

const PROVIDER = 'flutterwave';

/**
 * FLUTTERWAVE v4, AND THE ONE THING THIS PLATFORM USES IT FOR.
 *
 * WRITTEN FROM Flutterwave's PUBLISHED v4 OpenAPI SPECIFICATION, September
 * 2026 — a source AND a date, because the Bitnob table in this package
 * carried a source without one and decayed into a description of an API that
 * no longer answered.
 *
 * WHY THERE IS A SECOND CLIENT AT ALL, and it is not a rewrite under a
 * deadline. Five rounds of customers in Accra reporting that their mobile
 * money details could not be found, and every round fixed a different layer
 * while the real cause sat one API version away:
 *
 *   v3 `POST /accounts/resolve` IS A BANK-ACCOUNT RESOLVER. Flutterwave's own
 *   specification — the one vendored in their engineers' MCP server — says
 *   "Resolve a BANK ACCOUNT number ... Requires account_number (10 digits)
 *   and account_bank (bank code). account_bank: Bank code (3 DIGITS)."
 *
 * This adapter was sending `account_bank: "MTN"` and a twelve-digit phone
 * number. Both fields were wrong for that endpoint and NO SPELLING OF EITHER
 * WAS EVER GOING TO WORK — there is no mobile money in v3's resolver at all.
 * The previous round's two-shape retry was a careful fix to the wrong
 * question.
 *
 * v4 HAS A SEPARATE ENDPOINT FOR IT: `POST /wallet-account/resolve`, taking
 * `{ account_number, mobile_network, country }` and answering `account_name`,
 * beside `POST /bank-account/resolve` which takes `{ account_number, bank_id,
 * country }`. Two resolvers, because they are two different questions — which
 * is exactly what v3 collapsing them into one bank-shaped call hid.
 *
 * MONEY STAYS ON v3, and that is deliberate rather than laziness. v3 is not
 * deprecated; v4's transfers are a different model entirely (recipient and
 * sender become resources with their own ids), and migrating every payout,
 * every checkout and every webhook to chase one read is how a working rail
 * gets broken. What moves here is ONE CALL THAT MOVES NOTHING.
 *
 * OAUTH2 CLIENT CREDENTIALS, NOT A BEARER SECRET KEY. Four auth schemes in
 * this package now — Bitnob signs, Paystack and v3 Flutterwave bear a key,
 * and this exchanges a client id and secret for a token that lasts ten
 * minutes. Copying any one onto another is a 401 that reads as a bad
 * credential, which is what `bitnob/signing.ts` exists because of.
 */
/**
 * THE BASE URL IS A VALUE, NOT A CONSTANT, and the reason is that two public
 * sources disagree about it.
 *
 * Flutterwave's published OpenAPI says `https://api.flutterwave.cloud/f4b/
 * production`; their own developer blog says `f4bexperience.flutterwave.com`.
 * This repo has shipped a table of plausible constants twice and been wrong
 * both times, so the machine-readable specification is the DEFAULT and an
 * operator can move it without a deploy — which is also what makes
 * `verify-flutterwave-v4.mjs` worth running before this is relied on.
 */
export const FLUTTERWAVE_V4_BASE = 'https://api.flutterwave.cloud/f4b/production';
export const FLUTTERWAVE_V4_SANDBOX = 'https://api.flutterwave.cloud/f4b/sandbox';

/** Keycloak, on Flutterwave's own identity host. */
export const FLUTTERWAVE_V4_TOKEN_URL =
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';

export const FLUTTERWAVE_V4_ENDPOINTS = {
  /** A mobile money wallet. `{ account_number, mobile_network, country }`. */
  resolveWallet: '/wallet-account/resolve',
  /** A bank account. `{ account_number, bank_id, country }`. */
  resolveBankAccount: '/bank-account/resolve',
  /** Mobile networks by country, which is what `mobile_network` takes. */
  mobileNetworks: (country: string) =>
    `/mobile-networks?country=${encodeURIComponent(country)}`,
} as const;

export interface FlutterwaveV4Options {
  readonly baseUrl?: string;
  readonly tokenUrl?: string;
  readonly clientId: FlutterwaveCredential;
  readonly clientSecret: FlutterwaveCredential;
  readonly fetch?: FlutterwaveFetch;
  readonly timeoutMs?: number;
}

/**
 * A token, and when it stops being one.
 *
 * THE TOKEN LASTS TEN MINUTES AND IS CACHED FOR NINE. A client that asked for
 * a fresh one per call would put a second round trip in front of every name
 * lookup — on the screen money leaves from — and one that cached for the full
 * ten would hand out a token that expires in flight. The minute is the margin.
 */
interface CachedToken {
  readonly token: string;
  readonly expiresAt: number;
}

export class FlutterwaveV4Client {
  readonly #baseUrl: string;
  readonly #tokenUrl: string;
  readonly #clientId: FlutterwaveCredential;
  readonly #clientSecret: FlutterwaveCredential;
  readonly #fetch: FlutterwaveFetch;
  readonly #timeoutMs: number;
  #cached: CachedToken | undefined;
  /** One exchange at a time. Without it a screen firing two lookups on mount
   *  mints two tokens, which is the single-flight rule `Session.refresh()`
   *  follows for the same reason. */
  #inFlight: Promise<string> | undefined;

  constructor(options: FlutterwaveV4Options) {
    this.#baseUrl = (options.baseUrl ?? FLUTTERWAVE_V4_BASE).replace(/\/+$/, '');
    this.#tokenUrl = options.tokenUrl ?? FLUTTERWAVE_V4_TOKEN_URL;
    this.#clientId = options.clientId;
    this.#clientSecret = options.clientSecret;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * Whether this deployment can ask v4 anything at all.
   *
   * ASKED BEFORE THE CALL, so "nobody has pasted the credentials" is told
   * apart from "the rail refused". The first means a name was never
   * obtainable and the send proceeds with a label, exactly as it does in
   * Kenya; the second means the number is wrong and the send is refused. 069
   * built the tri-state that depends on this distinction.
   */
  async configured(): Promise<boolean> {
    const [id, secret] = await Promise.all([
      typeof this.#clientId === 'string' ? this.#clientId : this.#clientId(),
      typeof this.#clientSecret === 'string' ? this.#clientSecret : this.#clientSecret(),
    ]);
    return id !== undefined && id !== '' && secret !== undefined && secret !== '';
  }

  async #token(): Promise<string> {
    const now = Date.now();
    if (this.#cached !== undefined && this.#cached.expiresAt > now) return this.#cached.token;
    if (this.#inFlight !== undefined) return this.#inFlight;

    this.#inFlight = this.#exchange()
      .then((cached) => {
        this.#cached = cached;
        return cached.token;
      })
      .finally(() => {
        this.#inFlight = undefined;
      });
    return this.#inFlight;
  }

  async #exchange(): Promise<CachedToken> {
    const [id, secret] = await Promise.all([
      typeof this.#clientId === 'string' ? this.#clientId : this.#clientId(),
      typeof this.#clientSecret === 'string' ? this.#clientSecret : this.#clientSecret(),
    ]);
    if (id === undefined || id === '' || secret === undefined || secret === '') {
      throw new ProviderUnavailableError(
        PROVIDER,
        'no Flutterwave v4 client id and secret are configured. Paste both on ' +
          'the Provider keys screen, or set FLUTTERWAVE_V4_CLIENT_ID and ' +
          'FLUTTERWAVE_V4_CLIENT_SECRET. Without them a mobile money ' +
          'recipient cannot be named.',
      );
    }

    /* FORM-ENCODED, because that is what an OAuth2 token endpoint takes. JSON
       here answers 400 with a message about the grant type, which reads as a
       wrong credential — the Airalo lesson about a body's shape on the wire. */
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: id,
      client_secret: secret,
    });

    const response = await this.#send(this.#tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const text = await response.text();
    if (!response.ok) {
      /* A REJECTION, not an outage: they understood and refused, which on a
         token endpoint means the pair is wrong. 037's line. */
      throw new ProviderRejectedError(
        PROVIDER,
        `the Flutterwave v4 token endpoint refused the client credentials (${response.status})`,
        'bad_credentials',
        text,
      );
    }

    let payload: { access_token?: unknown; expires_in?: unknown };
    try {
      payload = JSON.parse(text) as typeof payload;
    } catch (cause) {
      throw new ProviderContractError(
        PROVIDER,
        'the Flutterwave v4 token endpoint returned a non-JSON body',
        cause,
      );
    }
    if (typeof payload.access_token !== 'string' || payload.access_token === '') {
      throw new ProviderContractError(
        PROVIDER,
        'the Flutterwave v4 token endpoint returned no access_token',
      );
    }

    /*
     * NINE MINUTES, OR WHAT THEY SAID MINUS A MINUTE, whichever is less. The
     * margin exists because a token that expires between the check and the
     * call fails as a 401, which reads as a wrong credential rather than as a
     * stale one.
     */
    const lifetime = typeof payload.expires_in === 'number' ? payload.expires_in : 600;
    const safe = Math.max(30, Math.min(lifetime, 600) - 60);
    return { token: payload.access_token, expiresAt: Date.now() + safe * 1000 };
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const token = await this.#token();
    const response = await this.#send(`${this.#baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        /* Their own spec names this header on every mutating call. A resolve
           mutates nothing, so it is harmless here and present so the one
           place a v4 request is built already carries it. */
        'x-idempotency-key': cryptoRandomId(),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    const text = await response.text();

    if (response.status === 401) {
      /*
       * A TOKEN THAT WENT STALE EARLY. Dropped rather than retried here: the
       * caller decides whether asking again is safe, and for a READ it is —
       * but this client does not move money and must not grow a retry loop
       * that a later money path would inherit.
       */
      this.#cached = undefined;
      throw new ProviderRejectedError(
        PROVIDER,
        'the Flutterwave v4 token was refused',
        'bad_credentials',
        text,
      );
    }

    if (response.status >= 500) {
      throw new ProviderUnavailableError(
        PROVIDER,
        `v4 ${method} ${path} returned ${response.status}`,
        text,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch (cause) {
      throw new ProviderContractError(
        PROVIDER,
        `v4 ${method} ${path} returned ${response.status} with a non-JSON body`,
        cause,
      );
    }

    if (!response.ok) {
      const message = (payload as { message?: unknown; error?: unknown }).message;
      throw new ProviderRejectedError(
        PROVIDER,
        typeof message === 'string' ? message : `v4 ${method} ${path} returned ${response.status}`,
        undefined,
        text,
      );
    }

    return payload;
  }

  async #send(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      return await this.#fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') {
        throw new ProviderTimeoutError(
          PROVIDER,
          `a Flutterwave v4 call did not answer within ${this.#timeoutMs}ms`,
          cause,
        );
      }
      throw new ProviderUnavailableError(PROVIDER, 'a Flutterwave v4 call failed', cause);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * An idempotency key for a v4 request.
 *
 * A CSPRNG, NEVER `Math.random`, and the local Semgrep rule refuses the other
 * one here. This particular value guards nothing — a resolve is a read — but
 * the one place a v4 request is built is the place a later money-moving call
 * would copy, and a predictable key on THAT is a way to collide two payouts.
 */
function cryptoRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
