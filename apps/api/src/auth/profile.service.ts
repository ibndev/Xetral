import { randomInt } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { OnApplicationBootstrap } from '@nestjs/common';
import type { Pool } from 'pg';
import type { ApiConfig } from '../config.js';
import { API_CONFIG, DATABASE } from '../tokens.js';

export interface ProfileView {
  readonly handle: string;
  /**
   * The whole thing, ready to paste into a message — or NULL when this
   * deployment has not been told its own address.
   *
   * Nullable rather than a relative path, which is what it used to be:
   * `appBaseUrl ?? ''` produced `/pay/olawale`, and a screen offering to copy
   * THAT hands the customer a string that cannot be opened by anybody they
   * send it to. A link that looks real and does not work is worse than an
   * absent one, because they find out from whoever failed to pay them.
   *
   * The handle is still returned and still usable — it can be typed into the
   * Send screen — so the feature degrades to the half that works.
   */
  readonly link: string | null;
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
export class ProfileService implements OnApplicationBootstrap {
  readonly #logger = new Logger(ProfileService.name);

  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Say at BOOT if the column this feature needs is not there.
   *
   * Nothing in this deployment applies migrations, so a release can ship code
   * for a schema the database has not got — and the first person to find out
   * was a customer opening their settings page and reading "Something went
   * wrong". A line in the startup log costs one query and puts the discovery
   * where the person who can fix it is already looking.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.pool.query(`SELECT handle FROM users LIMIT 0`);
    } catch {
      this.#logger.warn(
        'PAYMENT LINKS ARE OFF: users.handle does not exist on this database. ' +
          'Apply packages/ledger/sql/039_profile_handles.sql. Until then the ' +
          'payment link screen answers feature_unavailable and everything else ' +
          'works normally.',
      );
    }
  }

  async mine(userUuid: string): Promise<ProfileView> {
    let existing;
    try {
      existing = await this.pool.query<{ handle: string | null; email: string | null }>(
        `SELECT handle, email FROM users WHERE uuid = $1`,
        [userUuid],
      );
    } catch (error: unknown) {
      /*
       * A MISSING MIGRATION IS NOT "SOMETHING WENT WRONG".
       *
       * `users.handle` arrives in 039. On a deployment that has not applied it
       * this query throws, the error reached the client as an unhandled 500,
       * and the payment link screen rendered "Something went wrong. Please try
       * again." — which invites a customer to try again for ever at a schema
       * that is not going to change on its own.
       *
       * `feature_unavailable` says the truth: this part of the product is not
       * switched on here. The server log names the file to apply.
       */
      this.#logger.error(
        `payment handles are unavailable: ${describe(error)}. ` +
          `Apply packages/ledger/sql/039_profile_handles.sql to this database.`,
      );
      throw new ServiceUnavailableException({ error: 'feature_unavailable' });
    }
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

  /**
   * Change it, once, to something nobody has ever held.
   *
   * A HANDLE IS STILL NEVER REISSUED TO SOMEBODY ELSE, and that rule is what
   * makes this safe to offer rather than what it fights. 039's trigger
   * releases the old one into `handle_history` and refuses it to any OTHER
   * user id — so a customer changing theirs frees NOTHING for anybody: a
   * payment link posted in a message thread last month goes on pointing at a
   * handle only they have ever had. Without that, changing a handle would be
   * a way to hand a stranger every payment already promised to you.
   *
   * THE SAME PERSON MAY TAKE THEIRS BACK, and the asymmetry is the point
   * rather than a hole in it: every link pointing at that handle pays the
   * same person either way, so refusing would make one mistyped change
   * permanent for no benefit at all.
   *
   * The PIN is asked for because the change is still consequential and
   * reaches every link somebody has already shared — not because it moves
   * money, which it does not.
   *
   * Normalised before it is checked, because a handle arrives typed from a
   * message: the leading `@` somebody pastes with it, and the capitals a
   * phone keyboard adds to the first letter, are not mistakes to refuse.
   */
  async choose(userUuid: string, requested: string): Promise<ProfileView> {
    const handle = requested.trim().replace(/^@+/, '').toLowerCase();

    // The same shape 039 enforces, checked here so a customer gets a sentence
    // rather than a constraint violation. The database is still what decides
    // — this is a message, not the rule.
    if (!/^[a-z0-9](?:[a-z0-9_]{1,18})[a-z0-9]$/.test(handle)) {
      throw new BadRequestException({ error: 'handle_invalid' });
    }

    try {
      const updated = await this.pool.query<{ handle: string }>(
        `UPDATE users SET handle = $2 WHERE uuid = $1 RETURNING handle`,
        [userUuid, handle],
      );
      const claimed = updated.rows[0]?.handle;
      if (claimed === undefined) throw new BadRequestException({ error: 'handle_invalid' });
      return this.#view(claimed);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      /*
       * TAKEN COVERS BOTH — held by somebody now, and held by somebody once.
       * The live unique index raises one and 039's trigger raises the other,
       * both as `unique_violation`, and they mean the same thing to the
       * person typing: pick another. Distinguishing them would also say
       * whether a handle once belonged to a real customer, which is a fact
       * about somebody else.
       */
      if (isUniqueViolation(error)) throw new ConflictException({ error: 'handle_taken' });
      throw error;
    }
  }

  #view(handle: string): ProfileView {
    // `appBaseUrl` is the customer-facing origin and is CONFIGURATION, never a
    // request header — the same rule password reset links follow. A link built
    // from a `Host` an attacker controls is a payment link pointing at their
    // site, which is worse here than in an email because it is meant to be
    // forwarded.
    const origin = this.config.appBaseUrl;
    if (origin === undefined) {
      this.#logger.warn(
        'PAYMENT LINKS HAVE NO ADDRESS: APP_BASE_URL is not set, so customers ' +
          'are shown their @handle and no link. Set it to the origin their ' +
          'browser reaches.',
      );
      return { handle, link: null };
    }
    return { handle, link: `${origin}/pay/${handle}` };
  }
}

/** Postgres 23505. Raised by the live unique index AND by 039's trigger,
 *  which uses the same SQLSTATE deliberately — a handle held once and a
 *  handle held now are the same answer to the person typing. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
