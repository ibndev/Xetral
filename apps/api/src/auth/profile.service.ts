import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';

export interface ProfileView {
  readonly handle: string;
  /** The whole thing, ready to paste into a message. */
  readonly link: string;
}

/**
 * A customer's own payment handle, and the link built from it.
 *
 * MINTED ON FIRST ASK rather than at registration, and that is a decision
 * about the registration transaction more than about handles: sign-up already
 * writes a user, a credential, a device, a session and a consent record, and
 * adding a uniqueness loop to it means a retry on collision inside the one
 * flow that must not fail. Here the cost of a collision is one more attempt on
 * a request nobody is waiting on.
 *
 * A HANDLE IS CLAIMED ONCE AND NEVER REISSUED — `handle_history` and its
 * trigger enforce that, not this file. If it could be released and retaken, a
 * payment link posted in a message thread last month would start paying
 * somebody else this month, and nobody re-reads a link they have already
 * shared.
 */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async mine(userUuid: string): Promise<ProfileView> {
    const existing = await this.pool.query<{ handle: string | null; email: string | null }>(
      `SELECT handle, email FROM users WHERE uuid = $1`,
      [userUuid],
    );
    const row = existing.rows[0];
    if (row === undefined) throw new Error('profile requested for a user that does not exist');
    if (row.handle !== null) return this.#view(row.handle);

    return this.#view(await this.#mint(userUuid, row.email));
  }

  /**
   * A handle nobody has ever held, derived from the customer's own address.
   *
   * The address's local part is the natural seed: it is what somebody already
   * calls themselves, so the handle they are given is one they recognise.
   * Everything that is not a letter or a digit goes, because a handle is
   * typed from a message and a dot or a plus is a character somebody will
   * mistranscribe.
   *
   * The loop is bounded. An unbounded retry on a uniqueness collision is a
   * request that can hang for ever against a table somebody is inserting into,
   * and the last attempt is deliberately random rather than sequential — with
   * `olawale`, `olawale2` … `olawale9` taken, a tenth customer named Olawale
   * should not be walking the same ladder every one of them walked.
   */
  async #mint(userUuid: string, email: string | null): Promise<string> {
    const seed = (email ?? '')
      .split('@')[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9]/g, '') ?? '';
    // Three is the minimum the CHECK allows; `user` is the fallback for an
    // address whose local part is shorter or entirely punctuation.
    const base = seed.length >= 3 ? seed.slice(0, 16) : 'user';

    for (let attempt = 0; attempt < 8; attempt++) {
      const candidate =
        attempt === 0
          ? base
          : attempt < 5
            ? `${base}${attempt + 1}`
            // `randomInt`, not `Math.random`. A handle is PERMANENT and
            // PUBLIC: it can never be reissued, and it is the thing a payment
            // link is made of. A predictable suffix lets somebody work out
            // what the next customer named Olawale will be given and claim it
            // first — which is a cheap way to intercept payments meant for a
            // person who has not signed up yet. `.semgrep/xetral.yml` refuses
            // `Math.random` here, and was right to.
            : `${base}${randomInt(1000, 10000)}`;

      const taken = await this.pool.query(
        // `handle_history`, not `users.handle`: a handle somebody has released
        // is still taken, and checking the live column alone would offer one
        // that the trigger then refuses.
        `SELECT 1 FROM handle_history WHERE handle = $1`,
        [candidate],
      );
      if (taken.rows.length > 0) continue;

      try {
        const claimed = await this.pool.query<{ handle: string }>(
          `UPDATE users SET handle = $2 WHERE uuid = $1 AND handle IS NULL RETURNING handle`,
          [userUuid, candidate],
        );
        const handle = claimed.rows[0]?.handle;
        // No row means another request minted one for this customer between
        // the read and the write. Theirs is as good as ours.
        if (handle !== undefined) return handle;

        const now = await this.pool.query<{ handle: string }>(
          `SELECT handle FROM users WHERE uuid = $1`,
          [userUuid],
        );
        const settled = now.rows[0]?.handle;
        if (settled !== undefined && settled !== null) return settled;
      } catch {
        // A collision the check above missed, because two requests raced for
        // the same candidate. Try the next one.
        continue;
      }
    }

    throw new Error('could not mint a payment handle after eight attempts');
  }

  #view(handle: string): ProfileView {
    // `appBaseUrl` is the customer-facing origin and is CONFIGURATION, never a
    // request header — the same rule password reset links follow. A link built
    // from a `Host` an attacker controls is a payment link pointing at their
    // site, which is worse here than in an email because it is meant to be
    // forwarded.
    const origin = this.config.appBaseUrl ?? '';
    return { handle, link: `${origin}/pay/${handle}` };
  }
}
