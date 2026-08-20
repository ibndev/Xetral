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
export type StaffRole = 'giftcard_reviewer' | 'admin';

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
    options: { readonly pin: boolean; readonly role: StaffRole },
  ): this {
    return this.#declare(method, path, {
      mode: 'authenticated',
      pin: options.pin,
      role: options.role,
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
    };
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
