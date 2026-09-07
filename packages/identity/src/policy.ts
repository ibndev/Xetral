/**
 * Deny by default.
 *
 * The reference plugin had 45 REST routes declaring
 * `permission_callback => '__return_true'`, each with the real authorisation
 * check written inside the handler. That arrangement is safe exactly as long as
 * nobody forgets, and the failure is invisible: a route with no check looks
 * identical to a route whose check is three lines further down. There is no
 * list to audit, because "declared public" and "not yet secured" are the same
 * text.
 *
 * This registry inverts that. A route the code never declares is DENIED — the
 * mistake of forgetting produces a 403 in the first test run, rather than an
 * open endpoint in production. Being public is the thing that takes effort:
 * it requires an explicit declaration AND a written justification, and every
 * one of them is listable by `publicRouteAudit()` for review.
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Mirrors the `staff_role` enum in 005_giftcards.sql.
 *
 * A literal union rather than a string, so a typo in a route declaration is a
 * compile error rather than a route nobody can reach — which would look
 * exactly like a permissions bug in production and take an afternoon.
 */
export type StaffRole =
  | 'giftcard_reviewer'
  /** Reads customer records and the work queues. Cannot change anything. */
  | 'support'
  /** Reviews identity documents and freezes accounts. */
  | 'compliance'
  /** Moves suspense money, changes fees and limits. */
  | 'finance'
  /** Answers customer disputes, and pays out when one is upheld. Its own role
   *  rather than the gift card reviewer's: a different job with a different
   *  risk, and holding both should be a staffing decision. */
  | 'dispute_reviewer'
  /** All of the above, plus granting roles. */
  | 'admin';

export type RouteAuth =
  | {
      readonly mode: 'authenticated';
      /**
       * Whether a verified transaction PIN is required in addition to a valid
       * session. Required with no default, because "does this move money?" is
       * the question the author of a route must answer deliberately — a
       * default of `false` is how a transfer endpoint ends up PIN-free.
       */
      readonly pin: boolean;
      /**
       * A staff role the caller must hold. Absent means any authenticated
       * customer, which is the overwhelmingly common case.
       *
       * Declared through `staff()` rather than as an option on
       * `authenticated()`, so that gating a route on a role is a visibly
       * different call in the policy list. A reviewer scanning the file sees
       * the privileged surface without having to read the options object of
       * every line.
       */
      readonly role?: StaffRole;
      /**
       * HOW MANY FACTORS A STAFF ACTION TAKES, on top of the session.
       *
       * 'code+pin' — the default and the strict one. A fresh TOTP code
       *   elevates the session for ten minutes AND the transaction PIN is
       *   verified on every acting request inside that window.
       *
       * 'pin' — ONE step-up, the PIN, checked immediately before the action
       *   executes. Enrolment in a second factor is still required to reach
       *   any staff route at all, so this narrows what an ACTING request adds
       *   on top of an already-two-factor session; it does not make the
       *   surface single-factor.
       *
       * WHY THE OPTION EXISTS. Stacking a password, a rotating code and a PIN
       * on one button is the shape that produces a shared authenticator on a
       * desk — the outcome 014 already records about demanding a fresh code
       * per action. Where an operator performs the same action several times
       * in a sitting, as they do setting prices, the third factor buys very
       * little and costs the discipline of the first two.
       *
       * IT IS DECLARED, NOT INFERRED, and `singleFactorRouteAudit()` lists
       * every route that takes it — the same argument `publicRouteAudit()`
       * makes about opting out of authentication. A reduced-factor surface
       * that cannot be enumerated is one nobody reviews.
       */
      readonly stepUp?: 'code+pin' | 'pin';
    }
  | {
      readonly mode: 'public';
      /** Free text, shown in the audit. An empty one is rejected. */
      readonly justification: string;
    };

export type AccessDecision =
  | { readonly allow: true; readonly mode: 'public' }
  | {
      readonly allow: true;
      readonly mode: 'authenticated';
      readonly requiresPin: boolean;
      /** Undefined means any authenticated customer. */
      readonly requiresRole: StaffRole | undefined;
      /** Whether an acting staff request also needs a fresh TOTP code. False
       *  only where the route declared `stepUp: 'pin'`. */
      readonly requiresElevation: boolean;
    }
  | { readonly allow: false; readonly reason: 'undeclared_route' };

export interface PublicRoute {
  readonly method: HttpMethod;
  readonly path: string;
  readonly justification: string;
}

export class RoutePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutePolicyError';
  }
}

export class RoutePolicyRegistry {
  readonly #routes = new Map<string, RouteAuth>();

  static #key(method: HttpMethod, path: string): string {
    return `${method} ${path}`;
  }

  /**
   * Declaring a route twice throws rather than overwriting.
   *
   * Last-write-wins would mean a module loaded later could quietly downgrade a
   * route another module secured, and the resulting policy would depend on
   * import order — which is not something a reviewer can see in a diff.
   */
  #declare(method: HttpMethod, path: string, auth: RouteAuth): this {
    const key = RoutePolicyRegistry.#key(method, path);
    if (this.#routes.has(key)) {
      throw new RoutePolicyError(`route '${key}' is already declared; policy must be unambiguous`);
    }
    this.#routes.set(key, auth);
    return this;
  }

  authenticated(method: HttpMethod, path: string, options: { readonly pin: boolean }): this {
    return this.#declare(method, path, { mode: 'authenticated', pin: options.pin });
  }

  /**
   * A route only staff may call.
   *
   * The role is REQUIRED, with no default, for the same reason `pin` is: a
   * default would let someone add an approval endpoint without stating who may
   * use it, and "everyone signed in" is the wrong answer for every route that
   * needs this method at all.
   */
  staff(
    method: HttpMethod,
    path: string,
    options: {
      readonly pin: boolean;
      readonly role: StaffRole;
      /** See `RouteAuth.stepUp`. Omitted means 'code+pin', the strict one:
       *  reducing the factors on an action has to be written down. */
      readonly stepUp?: 'code+pin' | 'pin';
    },
  ): this {
    if (options.stepUp === 'pin' && !options.pin) {
      // A route that acts without a PIN and also declines the code would be
      // asking for nothing at all beyond the session. Refused at declaration
      // rather than discovered in production.
      throw new RoutePolicyError(
        `route '${method} ${path}' declares a single PIN step-up but takes no PIN`,
      );
    }
    return this.#declare(method, path, {
      mode: 'authenticated',
      pin: options.pin,
      role: options.role,
      ...(options.stepUp === undefined ? {} : { stepUp: options.stepUp }),
    });
  }

  /**
   * The justification is mandatory and is checked for content, not merely for
   * presence. It exists to be read during review: a route whose reason for
   * being public cannot be written down in a sentence usually should not be.
   */
  public(method: HttpMethod, path: string, justification: string): this {
    if (justification.trim().length < 10) {
      throw new RoutePolicyError(
        `route '${method} ${path}' must carry a written justification for being public`,
      );
    }
    return this.#declare(method, path, { mode: 'public', justification });
  }

  /**
   * The only lookup. An unknown route returns a denial rather than undefined,
   * so a caller cannot treat "no policy" as "no restriction" by forgetting a
   * null check — the shape of the return value makes the safe reading the
   * easy one.
   */
  decide(method: HttpMethod, path: string): AccessDecision {
    const auth = this.#routes.get(RoutePolicyRegistry.#key(method, path));

    if (auth === undefined) return { allow: false, reason: 'undeclared_route' };
    if (auth.mode === 'public') return { allow: true, mode: 'public' };
    return {
      allow: true,
      mode: 'authenticated',
      requiresPin: auth.pin,
      requiresRole: auth.role,
      // Absent means the strict default. Reading it the other way round would
      // make a forgotten declaration LOSE a factor, and forgetting must never
      // be the permissive direction — the rule 017 states about rate classes.
      requiresElevation: auth.stepUp !== 'pin',
    };
  }

  /**
   * Every staff route that takes ONE step-up factor instead of two.
   *
   * The same list `publicRouteAudit()` is, for the same reason: a surface
   * where the factors were deliberately reduced is one a reviewer has to be
   * able to enumerate, rather than find by reading the options object of
   * every line. `route-coverage.test.ts` prints it.
   */
  singleFactorRouteAudit(): readonly { readonly method: string; readonly path: string }[] {
    const out: { method: string; path: string }[] = [];
    for (const [key, auth] of this.#routes) {
      if (auth.mode !== 'authenticated' || auth.stepUp !== 'pin') continue;
      const [method, ...rest] = key.split(' ');
      out.push({ method: method ?? '', path: rest.join(' ') });
    }
    return out;
  }

  /**
   * Every route that opted out of authentication, with its stated reason.
   *
   * This is the list the plugin never had. Print it in CI and a pull request
   * that adds a public route has to explain itself in the diff.
   */
  publicRouteAudit(): readonly PublicRoute[] {
    const out: PublicRoute[] = [];
    for (const [key, auth] of this.#routes) {
      if (auth.mode !== 'public') continue;
      const [method, ...rest] = key.split(' ');
      out.push({
        method: method as HttpMethod,
        path: rest.join(' '),
        justification: auth.justification,
      });
    }
    return out.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  }

  /** Every declared route, for a coverage check against the router's own table. */
  declaredRoutes(): readonly string[] {
    return [...this.#routes.keys()].sort();
  }

  /**
   * Every route gated on a staff role, with the role required.
   *
   * The privileged-surface counterpart to `publicRouteAudit()`. Both answer a
   * question a reviewer should not have to grep for: what can be reached
   * without signing in, and what can be reached only by staff.
   */
  staffRouteAudit(): readonly { method: HttpMethod; path: string; role: StaffRole }[] {
    const out: { method: HttpMethod; path: string; role: StaffRole }[] = [];
    for (const [key, auth] of this.#routes) {
      if (auth.mode !== 'authenticated' || auth.role === undefined) continue;
      const [method, ...rest] = key.split(' ');
      out.push({ method: method as HttpMethod, path: rest.join(' '), role: auth.role });
    }
    return out.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));
  }
}
