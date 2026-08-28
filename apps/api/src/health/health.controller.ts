import { Controller, Get, HttpCode, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { Pool } from 'pg';
import { API_CONFIG, DATABASE } from '../tokens.js';
import type { ApiConfig } from '../config.js';

/**
 * Liveness and readiness, which are different questions.
 *
 * LIVENESS asks "is this process wedged?" — if the answer is no, restarting it
 * is the remedy. It must not touch the database: an instance that is perfectly
 * healthy while Postgres is briefly unavailable should not be killed and
 * restarted into the same outage, taking the rest of the fleet with it as the
 * orchestrator cycles them all.
 *
 * READINESS asks "should this instance receive traffic right now?" — and that
 * one does depend on the database, because an instance that cannot reach it
 * will fail every request it is given.
 *
 * Collapsing the two into one endpoint gives a fleet that restarts itself
 * during a database blip.
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(DATABASE) private readonly pool: Pool,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  /**
   * Liveness. Answers as long as the event loop is turning.
   *
   * It also names the ENVIRONMENT, and that is not decoration. Staging and
   * production are deliberately identical in every visible respect — same
   * bundle, same routes, same screens — which is what makes staging worth
   * having and also what makes "which one am I looking at?" a question people
   * get wrong under pressure. One curl now answers it.
   *
   * Nothing sensitive: the name of the deployment is not a secret, and an
   * operator who cannot tell them apart is the more dangerous condition.
   */
  @Get('health')
  @HttpCode(200)
  health(): { status: 'ok'; environment: string; uptime_seconds: number } {
    return {
      status: 'ok',
      environment: this.config.environment,
      uptime_seconds: Math.floor(process.uptime()),
    };
  }

  /**
   * Readiness. 200 only if a real query returns.
   *
   * `SELECT 1` rather than checking the pool's own idea of its state: a pool
   * can hold connections a firewall has since dropped, and report itself
   * healthy right up until a customer's transfer times out.
   */
  @Get('ready')
  async ready(): Promise<{ status: string; database: string }> {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ready', database: 'ok' };
    } catch {
      // Deliberately no detail. This endpoint is reachable by anything that
      // can route to the instance, and a connection error names the host, the
      // port and often the user.
      throw new ServiceUnavailableException({ status: 'not_ready', database: 'unreachable' });
    }
  }
}
