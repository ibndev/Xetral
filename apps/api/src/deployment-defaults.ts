import { createConnection } from 'node:net';

/**
 * WHAT A PRODUCTION DEPLOYMENT OF THIS REPOSITORY CAN BE SURE OF, applied when
 * the environment left it out.
 *
 * `docker-compose.app.yml` declared all three of these as `${VAR:-default}`,
 * and the running API still reported every one unset — the deployment
 * platform passes its own copy of each variable, EMPTY, and an empty value is
 * not a missing one to `${:-}`'s caller. So a default that lives only in a
 * compose file is a default that depends on how the file is read, and the
 * three it left unset were the silent ones:
 *
 *   NOTIFICATION_FROM — unset, NO MAILER IS BUILT. Every reset code, every
 *     new-device alert and every receipt sat in the outbox while the API told
 *     customers to check their email.
 *   APP_BASE_URL — unset, a checkout has no page to send a payer back to.
 *   REDIS_URL — unset, the rate limiter keeps its count in one process.
 *
 * PRODUCTION ONLY, and each default is a fact rather than a guess. The public
 * address is the one the phone is already compiled against
 * (`apps/mobile/app.json`); the sender is on the domain the legal pages name.
 * Staging and development state their own, because a staging box that
 * defaulted to the production address would mail links into production.
 *
 * REDIS IS FOUND, NOT ASSUMED. A URL pointing at nothing would make every
 * rate-limited request wait on a connection that never comes, so the compose
 * file's `redis` service is used only if something answers on it — and if
 * nothing does, the variable stays unset and readiness keeps saying so.
 *
 * `.env` STILL WINS. A deployment on another domain sets its own and none of
 * this runs.
 */
export const PRODUCTION_DEFAULTS = {
  APP_BASE_URL: 'https://app.xetral.com',
  NOTIFICATION_FROM: 'Xetral <no-reply@xetral.com>',
} as const;

export const COMPOSE_REDIS = { host: 'redis', port: 6379 } as const;

/** Every variable a default was applied to, for readiness to say so. */
export const DEFAULTED_MARKER = 'XETRAL_DEFAULTED_VARS';

export type Reachable = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpReachable: Reachable = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok: boolean): void => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });

const unset = (env: NodeJS.ProcessEnv, name: string): boolean => (env[name] ?? '').trim() === '';

/**
 * Fills in what production left out, IN PLACE, and says what it did. Nothing
 * here throws: a default that could stop the API starting would be a new way
 * to take the platform down.
 */
export async function applyDeploymentDefaults(
  env: NodeJS.ProcessEnv,
  reachable: Reachable = tcpReachable,
): Promise<readonly string[]> {
  if ((env['XETRAL_ENVIRONMENT'] ?? '').trim().toLowerCase() !== 'production') return [];

  const applied: string[] = [];
  for (const [name, value] of Object.entries(PRODUCTION_DEFAULTS)) {
    if (unset(env, name)) {
      env[name] = value;
      applied.push(name);
    }
  }
  if (unset(env, 'REDIS_URL') && (await reachable(COMPOSE_REDIS.host, COMPOSE_REDIS.port, 1500))) {
    env['REDIS_URL'] = `redis://${COMPOSE_REDIS.host}:${COMPOSE_REDIS.port}`;
    applied.push('REDIS_URL');
  }
  if (applied.length > 0) env[DEFAULTED_MARKER] = applied.join(',');
  return applied;
}
