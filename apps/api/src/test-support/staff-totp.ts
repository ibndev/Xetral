import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { timeStepAt, totpAt } from '@xetral/identity';

/**
 * Enrolling a staff second factor from a test.
 *
 * ONE helper, shared by every suite that drives the admin surface, for the same
 * reason there is one `ApiConfig` fixture: three hand-written copies of "how
 * staff authenticate" drift into three ideas of what the guard requires, and
 * the copy that drifts is the one covering the surface that can move money.
 *
 * It goes through the REAL endpoints — enrol, then confirm with a code
 * generated from the returned secret — rather than inserting rows. A helper
 * that seeded `staff_totp` directly would keep passing if the enrolment
 * endpoints broke, which is precisely the failure the audit found when every
 * suite seeded its own users and none of them noticed there was no way to
 * register.
 */
export interface StaffSession {
  readonly token: string;
  /**
   * A currently-valid code.
   *
   * Codes are single-use, so calling this twice inside one 30-second step
   * yields the same string and the second use is refused — which is correct,
   * and is why acting requests rely on session ELEVATION rather than a fresh
   * code each time.
   */
  code(): string;
}

export async function enrolStaffTotp(
  app: INestApplication,
  token: string,
): Promise<StaffSession> {
  const enrolled = await request(app.getHttpServer())
    .post('/v1/auth/totp/enrol')
    .set('Authorization', `Bearer ${token}`)
    .expect(200);

  const secret = enrolled.body.secret as string;
  const code = (): string => totpAt(secret, timeStepAt(Math.floor(Date.now() / 1000)));

  await request(app.getHttpServer())
    .post('/v1/auth/totp/confirm')
    .set('Authorization', `Bearer ${token}`)
    .send({ totp_code: code() })
    .expect(204);

  return { token, code };
}

/**
 * Enrol a staff second factor and mark the session elevated.
 *
 * WHAT IS REAL HERE AND WHAT IS A SHORTCUT, because the difference matters.
 *
 * The ENROLMENT is real: it goes through both endpoints and confirms with a
 * code generated from the secret the server returned, so a broken enrolment
 * path fails every suite that grants a role.
 *
 * The ELEVATION is a direct write, and that is deliberate. Elevating properly
 * means making a real acting request with a code attached, and there is no
 * harmless acting route on the admin surface — every one of them approves,
 * freezes or grants something. Doing it for real in twenty-five unrelated
 * suites would turn each of them into a test of TOTP, and the first time a
 * code was rejected they would all fail for a reason none of them is about.
 *
 * The mechanism this skips is covered directly, through the guard, in
 * `staff-totp.e2e.test.ts` — which is where a break in it should surface.
 */
export async function enrolAndElevate(
  app: INestApplication,
  pool: {
    query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
  },
  token: string,
  userId: string,
): Promise<StaffSession> {
  // Idempotent, because granting somebody two roles calls this twice and a
  // confirmed factor cannot be re-enrolled — by design, since that is the
  // attack where a stolen session quietly swaps the authenticator. The helper
  // has to tolerate what the product correctly refuses.
  const existing = await pool.query(
    `SELECT 1 FROM staff_totp t JOIN users u ON u.id = t.user_id
      WHERE u.id = $1::bigint AND t.confirmed_at IS NOT NULL`,
    [userId],
  );

  const session =
    existing.rows.length > 0
      ? { token, code: (): string => '' }
      : await enrolStaffTotp(app, token);

  await pool.query(
    `UPDATE auth_sessions SET totp_verified_at = now()
      WHERE user_id = $1::bigint AND revoked_at IS NULL`,
    [userId],
  );

  return session;
}
