import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import type { StaffRole } from '@xetral/identity';
import { DATABASE } from '../tokens.js';

/**
 * Who holds a staff role, read fresh on every privileged request.
 *
 * NOT carried in the access token, and that is the whole point. A token is
 * signed and cannot be revoked mid-life, so a role baked into one keeps
 * working for the rest of its fifteen minutes after the role is withdrawn —
 * and the moment you most want to remove someone's approval rights is the
 * moment you have just discovered why. This is the same rule the codebase
 * already applies to `users.status`: anything that must take effect
 * immediately is checked at the point of action, never inferred from a token.
 *
 * The cost is one indexed lookup per staff request. Staff requests are rare
 * and each one of them can move money.
 */
@Injectable()
export class StaffService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /** Throws unless the user holds a LIVE grant of the role. */
  async assertRole(userUuid: string, role: StaffRole): Promise<void> {
    if (!(await this.hasRole(userUuid, role))) {
      // No detail about what role was needed. A customer probing admin paths
      // learns only that they cannot have them.
      throw new ForbiddenException({ error: 'forbidden' });
    }
  }

  async hasRole(userUuid: string, role: StaffRole): Promise<boolean> {
    const result = await this.pool.query<{ ok: boolean }>(
      `SELECT TRUE AS ok
         FROM staff_roles r
         JOIN users u ON u.id = r.user_id
        WHERE u.uuid = $1
          AND u.status = 'active'
          AND r.revoked_at IS NULL
          -- 'admin' subsumes every role. One row, not a grant per capability:
          -- a role table that needs a join to answer "may this person approve
          -- a gift card?" is a table people stop reading.
          AND r.role IN ($2::staff_role, 'admin')
        LIMIT 1`,
      [userUuid, role],
    );
    return result.rows.length > 0;
  }

  /**
   * The caller's OWN live roles.
   *
   * The dashboard had no way to ask this, so a screen could not hide a control
   * an operator is not allowed to use — and the only alternative is showing it
   * to everybody and letting the route refuse, which teaches people that
   * buttons on the operations surface may or may not work.
   *
   * It reads the same rows `hasRole` does, live, for the reason 007 gives
   * about roles never being carried in a token: a role withdrawn is withdrawn
   * now, not in fifteen minutes.
   *
   * It answers only about the caller, so it says nothing a signed-in operator
   * does not already know about themselves — unlike `listStaff`, which is the
   * whole privileged surface and stays behind `admin`.
   */
  async rolesOf(userUuid: string): Promise<readonly string[]> {
    const result = await this.pool.query<{ role: string }>(
      `SELECT r.role
         FROM staff_roles r
         JOIN users u ON u.id = r.user_id
        WHERE u.uuid = $1
          AND u.status = 'active'
          AND r.revoked_at IS NULL
        ORDER BY r.role`,
      [userUuid],
    );
    return result.rows.map((r) => r.role);
  }

  /** The whole privileged surface, for review. Mirrors publicRouteAudit(). */
  async listStaff(): Promise<readonly { user_uuid: string; role: string; granted_at: string }[]> {
    const result = await this.pool.query<{
      user_uuid: string;
      role: string;
      granted_at: string;
    }>(
      `SELECT u.uuid AS user_uuid, r.role, r.granted_at
         FROM staff_roles r JOIN users u ON u.id = r.user_id
        WHERE r.revoked_at IS NULL
        ORDER BY r.granted_at`,
    );
    return result.rows;
  }
}
