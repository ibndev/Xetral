import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AdminService } from './admin.service.js';
import { AuditService } from './audit.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { KycService } from '../kyc/kyc.service.js';
import { ErrorRecorder } from '../observability/error-recorder.service.js';
import { kycReviewSchema } from '../kyc/dto.js';

/**
 * The operations backend.
 *
 * Every route lives under `/v1/admin/`, which is a structural guarantee rather
 * than a convention: `route-coverage.test.ts` fails the build if any route
 * with that prefix is declared with `authenticated()` instead of `staff()`.
 * Forgetting the role would leave an account-freezing endpoint reachable by
 * every signed-in customer — authenticated, and therefore not obviously wrong
 * in a diff.
 */

const statusSchema = z.object({
  status: z.enum(['active', 'frozen', 'closed']),
  reason: z.string().trim().min(3).max(500),
});

const attributeSchema = z.object({
  user_id: z.string().uuid(),
  reason: z.string().trim().min(3).max(500),
});

const settingSchema = z.object({
  value: z.string().trim().min(1).max(500),
});

/**
 * A pasted provider credential.
 *
 * NOT trimmed by zod, and the length ceiling is generous. Some providers issue
 * keys with meaningful trailing characters, and a schema that quietly rewrote
 * one would produce a credential that authenticates nothing — which presents
 * as the provider rejecting every request rather than as a mistake here. The
 * service trims exactly once, at the point where it also refuses an empty one.
 */
const credentialSchema = z.object({
  secret: z.string().min(1).max(4096),
});

const roleSchema = z.object({
  user_id: z.string().uuid(),
  role: z.enum(['giftcard_reviewer', 'compliance', 'support', 'finance', 'admin']),
});

const listQuery = z.object({
  search: z.string().trim().max(160).optional(),
  status: z.enum(['active', 'frozen', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().regex(/^[0-9]+$/).optional(),
});

@Controller('v1/admin')
export class AdminController {
  constructor(
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ProviderCredentialService)
    private readonly credentialStore: ProviderCredentialService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(ErrorRecorder) private readonly errors: ErrorRecorder,
  ) {}

  /* ------------------------------ overview ----------------------------- */

  @Get('overview')
  async overview(): Promise<Record<string, unknown>> {
    return this.admin.overview();
  }

  /** The number to look at every morning: is the ledger consistent with
   *  itself? A non-empty result means a trigger did not fire. */
  @Get('drift')
  async drift(): Promise<{ drift: readonly Record<string, unknown>[] }> {
    return { drift: await this.admin.drift() };
  }

  @Get('stuck')
  async stuck(): Promise<Record<string, unknown>> {
    return this.admin.stuck();
  }

  /* -------------------------------- users ------------------------------ */

  @Get('users')
  async users(@Query() query: unknown): Promise<{ users: readonly unknown[] }> {
    const parsed = listQuery.safeParse(query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const { search, status, limit, before } = parsed.data;
    return {
      users: await this.admin.users({
        limit,
        ...(search === undefined ? {} : { search }),
        ...(status === undefined ? {} : { status }),
        ...(before === undefined ? {} : { before }),
      }),
    };
  }

  @Get('users/:id')
  async user(@Param('id') id: string): Promise<Record<string, unknown>> {
    return this.admin.user(id);
  }

  /**
   * Freeze, unfreeze or close.
   *
   * Declares `pin: true` in the route table: an operator who walked away from
   * an unlocked laptop should not have left the ability to freeze customer
   * accounts behind.
   */
  @Post('users/:id/status')
  @HttpCode(200)
  async setStatus(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = statusSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return this.admin.setUserStatus(
      id,
      parsed.data.status,
      claims(request).sub,
      parsed.data.reason,
      ipOf(request),
    );
  }

  /* -------------------------------- kyc -------------------------------- */

  @Get('kyc')
  async kycQueue(): Promise<{ queue: readonly unknown[] }> {
    return { queue: await this.kyc.queue(100) };
  }

  @Post('kyc/:id/review')
  @HttpCode(200)
  async reviewKyc(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = kycReviewSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const reviewer = claims(request).sub;
    if (parsed.data.decision === 'approve') {
      return this.kyc.approve(id, reviewer, ipOf(request));
    }

    const reason = parsed.data.reason;
    if (reason === undefined) {
      throw new BadRequestException({ error: 'invalid_request', fields: ['reason'] });
    }
    return this.kyc.reject(id, reviewer, reason, ipOf(request));
  }

  /* ------------------------------ suspense ----------------------------- */

  @Get('suspense')
  async suspense(): Promise<{ deposits: readonly unknown[] }> {
    return { deposits: await this.admin.suspense() };
  }

  /** Gives suspense money to the customer it belongs to, by appending a
   *  correcting entry rather than editing the original. */
  @Post('suspense/:id/attribute')
  @HttpCode(200)
  async attribute(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = attributeSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return this.admin.attributeDeposit(
      id,
      parsed.data.user_id,
      claims(request).sub,
      parsed.data.reason,
      ipOf(request),
    );
  }

  /* ------------------------- provider credentials ---------------------- */

  /**
   * Every slot and whether it is filled. NEVER what is in one.
   *
   * There is no companion endpoint that reads a credential back. That is the
   * design rather than an omission: a key goes in and the only thing that ever
   * reads it is the adapter that uses it, in process. An operator confirming
   * they pasted the right thing has the four-character hint.
   */
  @Get('credentials')
  async credentials(): Promise<{ credentials: readonly unknown[] }> {
    return { credentials: await this.credentialStore.status() };
  }

  /** That a credential was replaced, by whom, and when — never what it was.
   *  The whole difference from `platform_settings_history`, which records
   *  every value a row has ever held. */
  @Get('credentials/:provider/:name/rotations')
  async credentialRotations(
    @Param('provider') provider: string,
    @Param('name') name: string,
  ): Promise<{ rotations: readonly unknown[] }> {
    return { rotations: await this.credentialStore.rotations(provider, name) };
  }

  /**
   * Pastes a new credential.
   *
   * The audit entry records the slot and the HINT, never the value — unlike
   * `setting.change` below, which records the value because for a fee that is
   * the point. `admin_audit_log` is append-only, so a secret written there
   * could never be removed.
   */
  @Post('credentials/:provider/:name')
  @HttpCode(200)
  async setCredential(
    @Req() request: AuthenticatedRequest,
    @Param('provider') provider: string,
    @Param('name') name: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = credentialSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const updated = await this.credentialStore.set(
      provider,
      name,
      parsed.data.secret,
      actor,
    );

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'credential.change',
      subjectType: 'provider_credential',
      subjectId: `${provider}.${name}`,
      // The hint, and only because it is already the safest thing we store.
      detail: { hint: updated.hint ?? '' },
      ...(ip === undefined ? {} : { ip }),
    });
    return updated;
  }

  /* ------------------------------ settings ----------------------------- */

  @Get('settings')
  async listSettings(): Promise<{ settings: readonly unknown[] }> {
    return { settings: await this.settings.list() };
  }

  @Get('settings/:key/history')
  async settingHistory(@Param('key') key: string): Promise<{ history: readonly unknown[] }> {
    return { history: await this.settings.history(key) };
  }

  /**
   * Changes one setting.
   *
   * The bounds are enforced by a database trigger, so a fat-fingered fee is
   * refused whether it arrives here or through psql. This endpoint adds the
   * readable error and the audit entry.
   */
  @Post('settings/:key')
  @HttpCode(200)
  async setSetting(
    @Req() request: AuthenticatedRequest,
    @Param('key') key: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = settingSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const updated = await this.settings.set(key, parsed.data.value, actor);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'setting.change',
      subjectType: 'setting',
      subjectId: key,
      detail: { value: parsed.data.value },
      ...(ip === undefined ? {} : { ip }),
    });
    return updated;
  }

  /* -------------------------------- staff ------------------------------ */

  @Get('staff')
  async staff(): Promise<{ staff: readonly unknown[] }> {
    return { staff: await this.admin.staff() };
  }

  @Post('staff/grant')
  @HttpCode(200)
  async grant(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = roleSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return this.admin.grantRole(
      parsed.data.user_id,
      parsed.data.role,
      claims(request).sub,
      ipOf(request),
    );
  }

  @Post('staff/revoke')
  @HttpCode(200)
  async revoke(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<Record<string, unknown>> {
    const parsed = roleSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return this.admin.revokeRole(
      parsed.data.user_id,
      parsed.data.role,
      claims(request).sub,
      ipOf(request),
    );
  }

  /* -------------------------------- audit ------------------------------ */

  @Get('audit')
  async auditLog(@Query() query: unknown): Promise<{ entries: readonly unknown[] }> {
    const parsed = listQuery.safeParse(query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    const { limit, before } = parsed.data;
    return {
      entries: await this.audit.list({ limit, ...(before === undefined ? {} : { before }) }),
    };
  }

  /* -------------------------------- errors ----------------------------- */

  /**
   * What is currently failing.
   *
   * `admin`, not `support`: an error message describes how the platform is
   * built, and the smallest audience that can act on it is the right one. It
   * carries no customer data by construction — the route pattern is stored,
   * never the resolved path — but "no customer data by construction" is a
   * property of the recorder, and this is the wrong place to bet on it
   * staying true.
   */
  @Get('errors')
  async errorList(): Promise<{ errors: readonly Record<string, unknown>[] }> {
    return { errors: await this.errors.open() };
  }

  /**
   * Acknowledge one.
   *
   * No PIN, and deliberately NOT written to the audit log. The audit log
   * exists for actions that touch a customer or the platform's policy, and
   * its action and subject columns are closed enums so that adding one is a
   * decision rather than a habit. Acknowledging a failure is neither: it
   * changes nothing about money, nothing a customer can see, and it cannot
   * hide anything, because `record_error` clears `resolved_at` on the next
   * occurrence — a bug somebody closed and which has come back reopens itself
   * rather than staying hidden behind a fix that did not work.
   */
  @Post('errors/:fingerprint/resolve')
  @HttpCode(200)
  async errorResolve(
    @Param('fingerprint') fingerprint: string,
  ): Promise<{ resolved: boolean }> {
    return { resolved: await this.errors.resolve(fingerprint) };
  }
}

function invalid(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claims(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const value = request.auth;
  if (value === undefined) throw new Error('admin route reached without verified claims');
  return value;
}

/** For the audit trail. Behind Cloudflare and a router, so the forwarded
 *  header is what identifies the operator rather than the proxy. */
function ipOf(request: AuthenticatedRequest): string | undefined {
  const header = request.headers['x-forwarded-for'];
  const forwarded = Array.isArray(header) ? header[0] : header;
  const first = forwarded?.split(',')[0]?.trim();
  return first !== undefined && first !== '' ? first : undefined;
}
