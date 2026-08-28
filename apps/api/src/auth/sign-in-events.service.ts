import { createHash } from 'node:crypto';
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
  /** Cloudflare's `CF-IPCountry`, if the edge set one. */
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

export function countryFrom(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): string | undefined {
  const raw = headers['cf-ipcountry'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return undefined;
  const upper = value.toUpperCase();
  return COUNTRY.test(upper) ? upper : undefined;
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

  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

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
      countrySeenBefore: row?.country_seen_before ?? true,
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
