import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * The record of where every sign-in came from — including the ones that
 * failed.
 *
 * WHY THE FAILURES. A password sprayed across four hundred accounts produces
 * four hundred refusals and, before this existed, no rows at all: the attack
 * that is easiest to see from the outside was the one nothing here could see.
 * The successes alone describe a takeover only after it has happened.
 *
 * NOTHING HERE AUTHORISES ANYTHING. The address arrives through the proxy
 * chain and the country arrives in a header, so both are worth exactly what
 * the edge in front of this API is worth. They describe a sign-in and are
 * shown to a customer who can judge them; no code path may branch on them to
 * grant access.
 */
export type SignInOutcome =
  | 'succeeded'
  | 'bad_credentials'
  | 'unknown_identifier'
  | 'refused';

export type SignInPlatform = 'ios' | 'android' | 'web';

export interface SignInOrigin {
  /** From Express's `req.ip`, which resolves the forwarded chain against
   *  `TRUST_PROXY_HOPS`. Absent when the request did not arrive through the
   *  edge — itself a thing worth being able to see. */
  readonly ip?: string | undefined;
  /** Cloudflare's `CF-IPCountry` for the CUSTOMER'S request, as the web
   *  proxy relays it — never the header on the request we received, which
   *  describes the web server. See `signInOriginFrom`. */
  readonly country?: string | undefined;
  readonly platform?: SignInPlatform | undefined;
}

export interface Familiarity {
  readonly ipSeenBefore: boolean;
  readonly countrySeenBefore: boolean;
}

/**
 * ISO 3166-1 alpha-2, plus Cloudflare's two specials: `XX` when it cannot
 * tell and `T1` for a Tor exit. Anything else is not a country code — a
 * request that did not come through the edge can carry whatever its sender
 * typed, and this is where that stops.
 */
const COUNTRY = /^[A-Z0-9]{2}$/;

type Headers = Readonly<Record<string, string | string[] | undefined>>;

/**
 * The three headers the web app's proxy adds. Lower-case, because that is how
 * Node hands them over, and the web side imports nothing from here — the
 * names are asserted equal by `sign-in-origin.test.ts` on both sides.
 */
export const PROXY_HEADERS = {
  secret: 'x-xetral-proxy-secret',
  ip: 'x-xetral-client-ip',
  country: 'x-xetral-client-country',
} as const;

const first = (headers: Headers, name: string): string | undefined => {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
};

const countryCode = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  return COUNTRY.test(upper) ? upper : undefined;
};

/** Compared as digests so the lengths always match and the time says nothing. */
const sameSecret = (presented: string | undefined, expected: string): boolean => {
  if (presented === undefined) return false;
  const a = createHash('sha256').update(presented, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
};

/**
 * Where a sign-in came from — the CUSTOMER, not the hop in front of us.
 *
 * `CF-IPCOUNTRY` ON THIS REQUEST DESCRIBES OUR OWN WEB SERVER. Every customer
 * request reaches the API through the web app — a browser directly, the phone
 * through `/api/x` — and the web app's request to the API is a second trip
 * through Cloudflare, which stamps the country of whoever opened THAT
 * connection: the server, in Germany. So a customer signing in from Lagos was
 * emailed "Sign-in from a new country: DE" with a Cloudflare address beside
 * it, which is the message most likely to make somebody think their money is
 * being taken. The header was never read on the documented topology either:
 * there the web reaches the API privately and no country arrives at all.
 *
 * SO THE COUNTRY IS READ ONLY WHERE THE PROXY VOUCHES FOR IT. The proxy saw
 * the customer's own request and copies Cloudflare's answer about THAT one;
 * the secret is what stops a caller reaching the API some other way from
 * typing a country of its choosing — a forged "NG" is how a takeover from
 * elsewhere would keep this alert quiet. Without a matching secret the
 * country is absent, and an unplaceable sign-in raises nothing: quiet is the
 * safe direction for a message whose only job is to be believed.
 *
 * The address follows the same rule, falling back to `req.ip` — which still
 * serves the failure counting that only needs addresses to be consistent.
 */
export function signInOriginFrom(
  headers: Headers,
  requestIp: string | undefined,
  proxySecret: string | undefined,
): { readonly ip: string | undefined; readonly country: string | undefined } {
  const vouched =
    proxySecret !== undefined &&
    proxySecret !== '' &&
    sameSecret(first(headers, PROXY_HEADERS.secret), proxySecret);
  if (!vouched) return { ip: requestIp, country: undefined };

  const clientIp = first(headers, PROXY_HEADERS.ip)?.trim();
  return {
    ip: clientIp !== undefined && isIP(clientIp) !== 0 ? clientIp : requestIp,
    country: countryCode(first(headers, PROXY_HEADERS.country)),
  };
}

/**
 * SHA-256 of the lower-cased identifier.
 *
 * A failed sign-in against an address that matched no account is somebody
 * else's email address, placed in our database by whoever guessed it. Stored
 * in the clear, this table would be a list of addresses currently under
 * attack. Equal hashes still mean equal identifiers, which is all the
 * correlation needs.
 */
export function identifierHash(identifier: string): string {
  return createHash('sha256').update(identifier.trim().toLowerCase(), 'utf8').digest('hex');
}

@Injectable()
export class SignInEventService {
  readonly #logger = new Logger(SignInEventService.name);

  #relayColumn: { readonly has: boolean; readonly at: number } | undefined;

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Whether 090 is applied — `sign_in_events.country_relayed`.
   *
   * WITHOUT IT THE NEW-COUNTRY ALERT IS SILENT, deliberately. Every country
   * written before the relay existed is the web server's (DE), so comparing a
   * customer's first correctly placed sign-in against that history emails
   * every customer "new country: NG" once — the panic this round removes.
   * Only 090 can tell the two kinds of row apart, so behind it the answer is
   * "seen before". Code ships ahead of migrations here (069, 087), so this is
   * probed rather than assumed: present is cached for good, absent for a
   * minute, and `pg_attribute` because `information_schema` answers about
   * grants.
   */
  async #relayed(client: PoolClient): Promise<boolean> {
    const cached = this.#relayColumn;
    if (cached !== undefined && (cached.has || Date.now() - cached.at < 60_000)) {
      return cached.has;
    }
    const result = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM pg_attribute
        WHERE attrelid = to_regclass('sign_in_events')
          AND attname = 'country_relayed'
          AND NOT attisdropped`,
    );
    const has = Number(result.rows[0]?.n ?? 0) === 1;
    if (!has && cached?.has !== false) {
      this.#logger.warn(
        'sign_in_events has no country_relayed: migration 090_sign_in_country_relayed.sql ' +
          'is not applied. The new-country sign-in email stays off until it is.',
      );
    }
    this.#relayColumn = { has, at: Date.now() };
    return has;
  }

  /**
   * Whether this account has been seen at this place before — asked BEFORE the
   * current attempt is written, because writing it first would make every
   * location familiar the moment it is used.
   */
  async familiarity(
    client: PoolClient,
    userId: string,
    origin: SignInOrigin,
  ): Promise<Familiarity> {
    const result = await client.query<{
      ip_seen_before: boolean;
      country_seen_before: boolean;
    }>(`SELECT * FROM sign_in_is_familiar($1::bigint, $2::inet, $3::text)`, [
      userId,
      origin.ip ?? null,
      origin.country ?? null,
    ]);
    const row = result.rows[0];
    return {
      // Unknown counts as familiar. A missing address must not be able to
      // manufacture a security alert on every sign-in from a client we simply
      // cannot place.
      ipSeenBefore: row?.ip_seen_before ?? true,
      // Behind 090 the history is the web server's country; see `#relayed`.
      countrySeenBefore: (await this.#relayed(client))
        ? (row?.country_seen_before ?? true)
        : true,
    };
  }

  /**
   * A sign-in that worked, recorded ON THE LOGIN'S OWN TRANSACTION.
   *
   * It has to be this one and not a separate connection: a 'succeeded' row
   * that commits while the session it describes rolls back is a claim that
   * somebody signed in when nobody did — and this table's whole worth is that
   * a reader can trust it.
   */
  async recordSuccess(
    client: PoolClient,
    input: {
      readonly userId: string;
      readonly identifier: string;
      readonly deviceId: string;
      readonly origin: SignInOrigin;
    },
  ): Promise<void> {
    // Every country that reaches here came through the vouched relay
    // (`signInOriginFrom` reads no other), so a present one is marked as the
    // customer's — which is what 090's familiarity compares against.
    if (await this.#relayed(client)) {
      await client.query(
        `INSERT INTO sign_in_events
           (user_id, identifier_hash, ip, country, country_relayed, platform, device_id, outcome)
         VALUES ($1::bigint, $2, $3::inet, $4::text, $4::text IS NOT NULL, $5, $6::bigint, 'succeeded')`,
        [
          input.userId,
          identifierHash(input.identifier),
          input.origin.ip ?? null,
          input.origin.country ?? null,
          input.origin.platform ?? null,
          input.deviceId,
        ],
      );
      return;
    }
    await client.query(
      `INSERT INTO sign_in_events
         (user_id, identifier_hash, ip, country, platform, device_id, outcome)
       VALUES ($1::bigint, $2, $3::inet, $4, $5, $6::bigint, 'succeeded')`,
      [
        input.userId,
        identifierHash(input.identifier),
        input.origin.ip ?? null,
        input.origin.country ?? null,
        input.origin.platform ?? null,
        input.deviceId,
      ],
    );
  }

  /**
   * A sign-in that did not work, recorded on a CONNECTION OF ITS OWN.
   *
   * The mirror image of the rule above, and the reason this is two methods
   * rather than one with a parameter. `login()` throws on a refusal and its
   * transaction rolls back — so a failure written on that client is a failure
   * that is never written, and the credential-stuffing view would see a clean
   * database during an attack.
   *
   * Swallows everything. Being unable to record an attempt is not a reason to
   * change the answer the caller gets, in either direction: it must not turn a
   * refusal into an error the client retries, and it must not let a caller
   * suppress the record by making the write fail.
   */
  async recordFailure(input: {
    readonly userId?: string | undefined;
    readonly identifier: string;
    readonly outcome: Exclude<SignInOutcome, 'succeeded'>;
    readonly origin: SignInOrigin;
  }): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO sign_in_events
           (user_id, identifier_hash, ip, country, platform, outcome)
         VALUES ($1::bigint, $2, $3::inet, $4, $5, $6::sign_in_outcome)`,
        [
          input.userId ?? null,
          identifierHash(input.identifier),
          input.origin.ip ?? null,
          input.origin.country ?? null,
          input.origin.platform ?? null,
          input.outcome,
        ],
      );
    } catch (error) {
      this.#logger.warn(
        `could not record a failed sign-in: ${error instanceof Error ? error.message : 'unknown'}`,
      );
    }
  }
}
