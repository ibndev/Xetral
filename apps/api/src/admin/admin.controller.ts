import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
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
import { ConsentService } from '../consent/consent.service.js';
import { DataRightsService } from '../datarights/data-rights.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { RateFeedService } from '../fx/rate-feed.service.js';
import type { RateSyncReport } from '../fx/rate-feed.service.js';
import { ProviderHealthService } from '../observability/provider-health.service.js';
import { ProviderCredentialService } from '../settings/provider-credentials.service.js';
import { MonitoringService } from '../risk/monitoring.service.js';
import { CaseService } from '../risk/case.service.js';
import { CardService } from '../cards/card.service.js';
import { KycService } from '../kyc/kyc.service.js';
import { ErrorRecorder } from '../observability/error-recorder.service.js';
import { ReadinessService, type Readiness } from '../golive/readiness.service.js';
import { RecoveryService, type HeldMoney, type RecoveryRecord } from './recovery.service.js';
import { EarningsService, type EarningsReport } from './earnings.service.js';
import {
  FundingDiagnosticsService,
  type FundingDiagnosis,
} from '../funding/funding-diagnostics.service.js';
import { kycReviewSchema } from '../kyc/dto.js';
import { webhookEndpoints } from '../settings/webhook-endpoints.js';
import { API_CONFIG } from '../tokens.js';
import type { ApiConfig } from '../config.js';

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

/**
 * The filters a support screen may apply to somebody's transactions.
 *
 * `kind` is left as a bounded STRING rather than an enum of the eighteen
 * entry kinds, and that is deliberate: the enum lives in Postgres, a new kind
 * arrives with a migration, and a list here would silently stop offering it —
 * the drift `EntryKind` has already produced twice in this codebase. The
 * value is a query PARAMETER either way, so an unknown one matches nothing
 * rather than reaching the SQL.
 */
const userTransactionsQuery = z.object({
  currency: z.string().trim().min(3).max(8).optional(),
  kind: z.string().trim().min(2).max(40).optional(),
  before: z.string().regex(/^[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/**
 * A recovery takes a REASON and nothing else.
 *
 * `.strict()` so an amount cannot be smuggled in: the sum comes from the held
 * row, and a caller-supplied one is refused rather than ignored — the rule
 * `payoutSchema` follows about a caller-supplied beneficiary name, for the
 * same reason. Anything a client can send, a stolen session can send.
 *
 * `transaction_pin` is allowed through because the guard reads it from the
 * body before the handler runs; `.strict()` would otherwise refuse the very
 * request the route declares.
 *
 * Eight characters minimum, matching 049's CHECK: a queue cleared with
 * one-word reasons is indistinguishable from one nobody worked.
 */
const recoverySchema = z
  .object({
    reason: z.string().trim().min(8).max(500),
    transaction_pin: z.string().optional(),
  })
  .strict();

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

const queueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100),
});

/** A minimum length, because "ok" is not a review. The CHECK in the schema
 *  demands a reason exists; this demands it says something. */
const resolutionSchema = z.object({
  resolution: z.string().trim().min(10).max(1000),
});

const staffFreezeSchema = z.object({
  reason: z.string().trim().min(5).max(500),
});

const tierSchema = z.object({
  // 0 registered, 1 verified, 2 enhanced. A number rather than a name, because
  // the ordering is the meaning — the trigger refuses a jump that skips the
  // evidence below it, and that check is arithmetic.
  tier: z.coerce.number().int().min(0).max(2),
  reason: z.string().trim().min(10).max(500),
});

const openCaseSchema = z.object({
  user_id: z.string().uuid(),
  reason: z.string().trim().min(10).max(500),
});

const noteSchema = z.object({
  note: z.string().trim().min(3).max(4000),
});

/**
 * The summary becomes the resolution on every signal the case covers, so it
 * has to say something — twenty characters, matching the CHECK rather than
 * being a second, different opinion about the same rule.
 */
const closeCaseSchema = z.object({
  outcome: z.enum(['no_action', 'reported', 'account_restricted']),
  summary: z.string().trim().min(20).max(4000),
  report_reference: z.string().trim().min(1).max(200).optional(),
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

/**
 * A rate, as a person says it.
 *
 * `quote_per_base` is a DECIMAL STRING — "1650.00" — never a number. By the
 * time a decimal is a JS number the precision is already gone, which is the
 * rule `fromMajor()` follows and the reason this crosses the wire as text.
 * The regex is the same shape the column's CHECK enforces, so a value that
 * passes here cannot be refused by the database for its form.
 */
const publishFxRateSchema = z
  .object({
    base_currency: z.string().trim().regex(/^[A-Z]{3,5}$/),
    quote_currency: z.string().trim().regex(/^[A-Z]{3,5}$/),
    quote_per_base: z.string().trim().regex(/^[0-9]+(\.[0-9]+)?$/),
    transaction_pin: z.string().optional(),
  })
  .strict();

const publishFxSchema = z.object({
  base_currency: z.string().trim().length(3).toUpperCase(),
  quote_currency: z.string().trim().length(3).toUpperCase(),
  /* BASIS POINTS as an integer, never a decimal — the rule every rate in this
     codebase follows. The bound matches the CHECK, so a mistyped figure is
     refused by the form and by the database. */
  spread_basis_points: z.coerce.number().int().min(0).max(10_000),
  /* MINOR UNITS as a string. It is a bigint in Postgres and would lose
     precision as a JSON number. */
  min_base_minor: z.string().regex(/^[1-9][0-9]*$/),
  transaction_pin: z.string().optional(),
});

const publishRateSchema = z.object({
  brand: z.string().trim().min(1).max(60),
  country: z.string().trim().length(2).toUpperCase(),
  card_type: z.enum(['ecode', 'physical']),
  face_currency: z.string().trim().length(3).toUpperCase(),
  payout_currency: z.string().trim().length(3).toUpperCase(),
  payout_rate_minor: z.string().regex(/^[1-9][0-9]*$/),
  min_face_minor: z.string().regex(/^[1-9][0-9]*$/),
  max_face_minor: z.string().regex(/^[1-9][0-9]*$/),
  transaction_pin: z.string().optional(),
});

const retirePriceSchema = z.object({
  kind: z.enum(['fx', 'giftcard']),
  reason: z.string().trim().min(10).max(500),
  transaction_pin: z.string().optional(),
});

const resolveDataRequestSchema = z.object({
  status: z.enum(['completed', 'refused']),
  /* Twenty characters, matching the CHECK. A queue cleared with one-word
     outcomes is indistinguishable from one nobody worked, and this is the
     only part of the answer a regulator can inspect. */
  outcome: z.string().trim().min(20).max(2000),
  transaction_pin: z.string().optional(),
});

const taxQuery = z.object({
  months: z.coerce.number().int().min(1).max(36).default(12),
});

@Controller('v1/admin')
export class AdminController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(AdminService) private readonly admin: AdminService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(SettingsService) private readonly settings: SettingsService,
    @Inject(ConsentService) private readonly consentService: ConsentService,
    @Inject(DataRightsService) private readonly rights: DataRightsService,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(RateFeedService) private readonly rateFeed: RateFeedService,
    @Inject(ProviderHealthService) private readonly providerHealth: ProviderHealthService,
    @Inject(ProviderCredentialService)
    private readonly credentialStore: ProviderCredentialService,
    @Inject(MonitoringService) private readonly monitoring: MonitoringService,
    @Inject(CaseService) private readonly cases: CaseService,
    @Inject(CardService) private readonly cards: CardService,
    @Inject(KycService) private readonly kyc: KycService,
    @Inject(ErrorRecorder) private readonly errors: ErrorRecorder,
    @Inject(EarningsService) private readonly earnings: EarningsService,
    @Inject(ReadinessService) private readonly readinessService: ReadinessService,
    @Inject(FundingDiagnosticsService)
    private readonly diagnostics: FundingDiagnosticsService,
    @Inject(RecoveryService) private readonly recovery: RecoveryService,
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

  /**
   * What this deployment has not been told yet.
   *
   * `admin` rather than `support`, because the answer names every provider
   * this instance can reach, which flows are switched off and which secrets
   * are absent — a map of where the platform is soft. It carries no secret
   * and no value, only whether something is set.
   *
   * IT ANSWERS FOR THE PROCESS THAT SERVED IT. On a deployment where the
   * workers run in their own container, the worker intervals read as
   * `unset-here` on the API and are correctly set on the worker. The response
   * names the instance for that reason.
   */
  @Get('readiness')
  async readiness(): Promise<Readiness> {
    return this.readinessService.report();
  }

  /**
   * WHY OPENING A NAIRA ACCOUNT IS FAILING, in sentences.
   *
   * `readiness` asks whether a value is SET. Every reason this flow refuses
   * survives that: a key from the other Paystack domain is set, a
   * `preferred_bank` slug the business is not approved for is set, and a
   * dedicated-account product that was never enabled needs no setting at all.
   * So the whole class of "we configured everything and Activate Account
   * throws" was invisible from here, and the only place the answer existed
   * was a log line written at the moment somebody pressed the button.
   *
   * Reads only. It opens no account, so it is safe to press repeatedly during
   * an incident — and it relays the PROVIDER'S OWN sentence, which is the
   * part worth having and the part a customer must never see.
   */
  @Get('funding/diagnostics')
  async fundingDiagnostics(): Promise<FundingDiagnosis> {
    return this.diagnostics.diagnose();
  }

  /**
   * Whether anything is actually being sent.
   *
   * The failure this answers is silent by construction: with the worker
   * interval unset, rows accumulate, the API keeps saying "check your email",
   * and nothing errors — writing the row succeeded.
   *
   * Carries no message body. A rendered reset email contains a live bearer
   * token, which is why 012 seals every payload and erases it on send.
   */
  @Get('notifications')
  async notifications(): Promise<Record<string, unknown>> {
    return this.admin.notifications();
  }

  /* ------------------------------ recovery ----------------------------- */

  /**
   * Money held against something that never completed, and what has already
   * been given back.
   *
   * Both in one response, because "has somebody already dealt with this?" is
   * asked in the same breath as "what is waiting?" — and an operator who
   * cannot see the answer presses the button again.
   */
  @Get('recovery')
  async recoveryQueue(): Promise<{
    waiting: readonly HeldMoney[];
    recovered: readonly RecoveryRecord[];
  }> {
    const [waiting, recovered] = await Promise.all([
      this.recovery.waiting(),
      this.recovery.recovered(),
    ]);
    return { waiting, recovered };
  }

  /**
   * Give one held row back.
   *
   * THE AMOUNT IS NOT A PARAMETER. It comes from the held row, so this cannot
   * credit an arbitrary customer an arbitrary sum — which is what a
   * money-printing button on an operations screen would be.
   */
  @Post('recovery/:kind/:id')
  async recover(
    @Param('kind') kind: string,
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<RecoveryRecord> {
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    if (kind !== 'bank_payout' && kind !== 'purchase') {
      throw new BadRequestException({ error: 'invalid_request', fields: ['kind'] });
    }

    return this.recovery.recover(
      kind,
      id,
      claims(request).sub,
      parsed.data.reason,
      request.ip,
    );
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
   * What actually happened in this account.
   *
   * Support had balances, devices, cards and status changes — everything
   * ABOUT an account and nothing that happened IN it — so the commonest
   * question they are asked could only be answered from a psql prompt.
   *
   * The filters are validated against a closed shape rather than passed
   * through: `kind` reaches a query about somebody's money, and a schema is
   * what makes "anything the client sent" impossible to write here.
   */
  @Get('users/:id/transactions')
  async userTransactions(
    @Param('id') id: string,
    @Query() query: unknown,
  ): Promise<{ transactions: readonly unknown[] }> {
    const parsed = userTransactionsQuery.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    const { currency, kind, before, limit } = parsed.data;
    return {
      transactions: await this.admin.userTransactions(id, {
        ...(currency === undefined ? {} : { currency }),
        ...(kind === undefined ? {} : { kind }),
        ...(before === undefined ? {} : { before }),
        limit: limit ?? 50,
      }),
    };
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

  /* -------------------------------- cards ------------------------------ */

  /** One card's whole life: every status change and who caused it. Four digits
   *  of the number and no more — this screen is read over shoulders. */
  @Get('cards/:id')
  async card(@Param('id') id: string): Promise<unknown> {
    return this.admin.cardHistory(id);
  }

  /**
   * Freezes a card on a customer's behalf, with a reason.
   *
   * No staff TERMINATE, deliberately: freezing stops spending and the customer
   * can undo it, while terminating moves their money and cannot be undone.
   */
  @Post('cards/:id/freeze')
  @HttpCode(204)
  async freezeCard(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = staffFreezeSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    await this.cards.freezeAsStaff(id, actor, parsed.data.reason);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'card.freeze',
      subjectType: 'card',
      subjectId: id,
      detail: {},
      // A customer WILL ring back to ask why their card stopped working, and
      // "a member of staff froze it" is not an answer.
      reason: parsed.data.reason,
      ...(ip === undefined ? {} : { ip }),
    });
  }

  /**
   * Raises or lowers a customer's verification tier.
   *
   * Separate from the status endpoint above, because freezing an account and
   * deciding what we know about a person answer different questions — and
   * unfreezing must not restore a ceiling somebody removed for a reason.
   */
  @Post('users/:id/tier')
  @HttpCode(200)
  async setUserTier(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = tierSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const updated = await this.admin.setUserTier(id, parsed.data.tier, actor, parsed.data.reason);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'user.tier',
      subjectType: 'user',
      subjectId: id,
      detail: { tier: String(parsed.data.tier) },
      // Required in both directions: raising decides how much can leave, and
      // lowering takes something away from a customer.
      reason: parsed.data.reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return updated;
  }

  /* --------------------------- risk monitoring ------------------------- */

  /**
   * The compliance queue: what the rules flagged and nobody has decided about.
   *
   * Oldest first, and each row says how many OTHER open signals the same
   * customer has — one signal is a transaction, several is a pattern, and a
   * reviewer should know which they are looking at before they open the first.
   */
  @Get('risk/signals')
  async riskSignals(@Query() query: unknown): Promise<{ signals: readonly unknown[] }> {
    const parsed = queueQuery.safeParse(query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return { signals: await this.monitoring.queue(parsed.data.limit) };
  }

  /**
   * Closes one, with a reason.
   *
   * The reason is required by a CHECK as well as by this schema. A signal
   * closed with no explanation is a queue that was cleared rather than worked,
   * and that distinction is the only part of an AML programme a regulator can
   * actually inspect.
   */
  @Post('risk/signals/:id/resolve')
  @HttpCode(200)
  async resolveRiskSignal(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = resolutionSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const resolved = await this.monitoring.resolve(id, actor, parsed.data.resolution);
    if (resolved === undefined) {
      // One answer for "no such signal" and "already resolved", the same way
      // the dispute endpoints answer. A reviewer racing a colleague learns
      // that it is handled; nobody learns which signal ids exist.
      throw new NotFoundException({ error: 'signal_not_found' });
    }

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'risk.resolve',
      subjectType: 'risk_signal',
      subjectId: id,
      detail: {},
      reason: parsed.data.resolution,
      ...(ip === undefined ? {} : { ip }),
    });
    return resolved;
  }

  /* ---------------------------- case files ----------------------------- */

  @Get('risk/cases')
  async riskCases(@Query() query: unknown): Promise<{ cases: readonly unknown[] }> {
    const parsed = queueQuery.safeParse(query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return { cases: await this.cases.queue(parsed.data.limit) };
  }

  /** One case, with its signals and its notes. There is deliberately no
   *  customer-facing counterpart: tipping off is an offence. */
  @Get('risk/cases/:id')
  async riskCase(@Param('id') id: string): Promise<unknown> {
    return this.cases.detail(id);
  }

  @Post('risk/cases')
  @HttpCode(201)
  async openRiskCase(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = openCaseSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const opened = await this.cases.open(parsed.data.user_id, actor, parsed.data.reason);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'risk.case_open',
      subjectType: 'risk_case',
      subjectId: opened.id,
      detail: { user: parsed.data.user_id },
      reason: parsed.data.reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return opened;
  }

  /**
   * Adds a note.
   *
   * Deliberately NOT audited. A reviewer writes several while working one
   * case, and an audit log filling with "somebody typed something" buries the
   * entries that matter — the notes are themselves an append-only trail on the
   * case, which is where they belong.
   */
  @Post('risk/cases/:id/notes')
  @HttpCode(204)
  async noteRiskCase(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<void> {
    const parsed = noteSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);
    await this.cases.addNote(id, claims(request).sub, parsed.data.note);
  }

  /** Closes it, which resolves every signal attached — by trigger, so it
   *  cannot be closed with its signals left open by any path. */
  @Post('risk/cases/:id/close')
  @HttpCode(200)
  async closeRiskCase(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = closeCaseSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const closed = await this.cases.close(id, actor, {
      outcome: parsed.data.outcome,
      summary: parsed.data.summary,
      ...(parsed.data.report_reference === undefined
        ? {}
        : { report_reference: parsed.data.report_reference }),
    });

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'risk.case_close',
      subjectType: 'risk_case',
      subjectId: id,
      detail: { outcome: parsed.data.outcome },
      reason: parsed.data.summary,
      ...(ip === undefined ? {} : { ip }),
    });
    return closed;
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
  /**
   * The credential slots, and the WEBHOOK ENDPOINTS they verify.
   *
   * Together, because they are one job: an operator configuring Bitnob pastes
   * a key here and a URL there, and the dashboard used to show only half of
   * it. A webhook URL nobody publishes is a URL somebody guesses — and a
   * guessed one answers 404 to a provider who will keep POSTing to it while
   * deposits go unrecorded on our side, with nothing on either side reporting
   * anything.
   */
  @Get('credentials')
  async credentials(): Promise<{ credentials: readonly unknown[]; webhooks: readonly unknown[] }> {
    return {
      credentials: await this.credentialStore.status(),
      // Built from `WEBHOOK_BASE_URL`, and left as bare paths when it is
      // unset. Never a hostname this code invented.
      webhooks: webhookEndpoints(this.config.webhookBaseUrl),
    };
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

  /* --------------------------------- tax -------------------------------- */

  /**
   * `finance`, not `support`. What was collected on a revenue authority's
   * behalf is a finance figure, and the roles exist so a support agent looking
   * up a card cannot also read the returns.
   */
  @Get('tax')
  async tax(@Query() query: unknown): Promise<Record<string, unknown>> {
    const parsed = taxQuery.safeParse(query);
    if (!parsed.success) throw invalid(parsed.error.issues);
    return this.admin.tax(parsed.data.months);
  }

  /* ------------------------------- consent ------------------------------ */

  /**
   * Who has not agreed to the words currently in force.
   *
   * Empty is the resting state and fills the moment a notice is republished —
   * which is exactly when somebody needs to see it, because a change nobody
   * was asked about is a change nobody agreed to.
   */
  @Get('consents')
  async consents(): Promise<{
    summary: readonly unknown[];
    outstanding: readonly unknown[];
  }> {
    const [summary, outstanding] = await Promise.all([
      this.consentService.outstandingSummary(),
      this.consentService.outstanding(100),
    ]);
    return { summary, outstanding };
  }

  /* ----------------------------- data rights ---------------------------- */

  /**
   * Requests for a copy of somebody's data, or for it to be erased.
   *
   * Worst deadline first. A statutory window is one of the few deadlines here
   * whose consequence is regulatory rather than an unhappy customer.
   */
  @Get('data-requests')
  async dataRequests(): Promise<{ requests: readonly unknown[] }> {
    return { requests: await this.rights.due() };
  }

  /**
   * Carries out an erasure.
   *
   * The one action in this system that CANNOT BE UNDONE BY APPENDING, which is
   * why it takes a PIN and why a person decides it. The database refuses while
   * the customer holds a balance or is under investigation, and the refusal is
   * relayed unchanged — distinguishing the two here would reintroduce the
   * tipping-off the schema went out of its way to avoid.
   */
  @Post('data-requests/:id/erase')
  @HttpCode(200)
  async eraseCustomer(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<unknown> {
    const actor = claims(request).sub;
    const completed = await this.rights.completeErasure(id, actor);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'data.erase',
      subjectType: 'data_request',
      subjectId: id,
      detail: {},
      // Destructive, so a reason is required by CHECK. The outcome IS the
      // reason: it names what went and what stayed.
      reason: String(completed['outcome']),
      ...(ip === undefined ? {} : { ip }),
    });
    return completed;
  }

  /** Closes a request answered some other way — an export sent, or a refusal
   *  with its reason. */
  @Post('data-requests/:id/resolve')
  @HttpCode(200)
  async resolveDataRequest(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = resolveDataRequestSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const resolved = await this.rights.resolve(id, actor, parsed.data.status, parsed.data.outcome);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'data.resolve',
      subjectType: 'data_request',
      subjectId: id,
      detail: { status: parsed.data.status },
      reason: parsed.data.outcome,
      ...(ip === undefined ? {} : { ip }),
    });
    return resolved;
  }

  /* -------------------------------- pricing ----------------------------- */

  /**
   * What a customer will be quoted today.
   *
   * `finance`, and it is READ-ONLY here: publishing is below and takes a PIN.
   * The unattributed list is the interesting half — a price with no author was
   * written at a psql prompt, which is what this whole surface exists to make
   * unnecessary.
   */
  @Get('prices')
  async prices(): Promise<Record<string, unknown>> {
    const [published, fx, cards] = await Promise.all([
      this.pricing.published(),
      this.pricing.fxPolicies(),
      this.pricing.rateCards(),
    ]);
    return { ...published, fx_policies: fx, rate_cards: cards };
  }

  /**
   * Publishes an FX spread for one pair and one direction.
   *
   * TAKES A PIN, like every action that changes what a customer is charged.
   * There is no update: changing a spread is retiring one and publishing
   * another, so every past quote stays reproducible.
   */
  @Post('prices/fx')
  @HttpCode(201)
  async publishFx(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = publishFxSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const published = await this.pricing.publishFxSpread(actor, parsed.data);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'price.publish',
      subjectType: 'price',
      subjectId: String(published['uuid']),
      detail: {
        kind: 'fx_spread',
        pair: `${parsed.data.base_currency}/${parsed.data.quote_currency}`,
        spread_basis_points: parsed.data.spread_basis_points,
      },
      ...(ip === undefined ? {} : { ip }),
    });
    return published;
  }

  /**
   * Publishes what a currency is worth, in the direction stated.
   *
   * `prices/fx` publishes a MARGIN and this publishes the RATE. Separate
   * endpoints because they are separate decisions and separate rows: a pair
   * can have a margin and no rate of ours, which is right where a provider
   * quotes it and refuses every customer where none does —
   * `fx_pairs_priced_without_a_rate` is what shows the difference.
   */
  @Post('prices/fx-rate')
  @HttpCode(201)
  async publishFxRate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = publishFxRateSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const published = await this.pricing.publishFxRate(actor, parsed.data);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'price.publish',
      subjectType: 'price',
      subjectId: String(published['uuid']),
      detail: {
        kind: 'fx_rate',
        pair: `${parsed.data.base_currency}/${parsed.data.quote_currency}`,
        // The typed figure rather than the ratio: it is what an operator can
        // check a log line against.
        quote_per_base: parsed.data.quote_per_base,
      },
      ...(ip === undefined ? {} : { ip }),
    });
    return published;
  }

  /** Every live rate, with the spread that goes with it. */
  @Get('prices/fx-rates')
  async fxRates(): Promise<{ rates: readonly Record<string, unknown>[] }> {
    return { rates: await this.pricing.fxRates() };
  }

  /**
   * FETCH EVERY RATE FROM THE FEED, NOW.
   *
   * The worker does this on a schedule; this is the button for the afternoon
   * the market moves and nobody wants to wait for it. It writes exactly what
   * the worker writes — a retirement and a new row per pair that changed —
   * and it will not touch a rate a person published, because a deliberate
   * price outranks a market one.
   *
   * A PIN, like publishing one by hand, because it IS publishing: every
   * corridor the feed answers for is repriced and the next customer is quoted
   * the new number.
   */
  @Post('prices/fx-refresh')
  @HttpCode(200)
  async refreshFxRates(): Promise<RateSyncReport> {
    return this.rateFeed.sync();
  }

  /** Publishes a gift card rate for one brand, country, type and band. */
  @Post('prices/giftcard')
  @HttpCode(201)
  async publishRate(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = publishRateSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const published = await this.pricing.publishRateCard(actor, parsed.data);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'price.publish',
      subjectType: 'price',
      subjectId: String(published['uuid']),
      detail: {
        kind: 'giftcard_rate',
        card: `${parsed.data.brand} ${parsed.data.country} ${parsed.data.card_type}`,
        payout_rate_minor: parsed.data.payout_rate_minor,
      },
      ...(ip === undefined ? {} : { ip }),
    });
    return published;
  }

  /**
   * Retires a price, which stops it being quoted and keeps it on record.
   *
   * DESTRUCTIVE IN THE SENSE 009 MEANS: it takes something away from
   * customers, because until a replacement is published the flow it priced
   * refuses them. So a reason is required, by CHECK as well as by this schema.
   */
  @Post('prices/:id/retire')
  @HttpCode(200)
  async retirePrice(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<unknown> {
    const parsed = retirePriceSchema.safeParse(body);
    if (!parsed.success) throw invalid(parsed.error.issues);

    const actor = claims(request).sub;
    const retired = await this.pricing.retire(parsed.data.kind, id);

    const ip = ipOf(request);
    await this.audit.record({
      actorId: actor,
      action: 'price.retire',
      subjectType: 'price',
      subjectId: id,
      detail: { kind: parsed.data.kind },
      reason: parsed.data.reason,
      ...(ip === undefined ? {} : { ip }),
    });
    return retired;
  }

  /* ---------------------------- provider health ------------------------- */

  /**
   * Whether the providers are answering.
   *
   * `support`, deliberately the widest role that reads anything here: the
   * person taking the call about a card that will not work is the one who
   * needs to know Bitnob has been timing out for ten minutes, and making them
   * ask somebody with `admin` is how that goes unnoticed for an hour.
   *
   * `degraded` is the queue. `recent` includes the providers that are fine,
   * which is what makes "quiet because nothing is wrong" distinguishable from
   * "quiet because nothing is being called".
   */
  @Get('providers')
  async providers(): Promise<{ degraded: readonly unknown[]; recent: readonly unknown[] }> {
    const [degraded, recent] = await Promise.all([
      this.providerHealth.degraded(),
      this.providerHealth.recent(),
    ]);
    return { degraded, recent };
  }

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

  /**
   * Clear the list in one action.
   *
   * It cannot collide with `errors/:fingerprint/resolve`, which is a segment
   * longer. What matters is the COUNT it returns: an operator who clears
   * twenty failures and is told "20" knows the screen was not simply stale,
   * and one told "0" knows somebody else got there first.
   */
  /**
   * WHAT THE PLATFORM HAS EARNED, and why it might be nothing.
   *
   * Both revenue accounts have been posted to correctly since Phase 1 and
   * nothing ever rendered either figure — so "we are earning nothing" and
   * "the fee is set to zero, which is the shipped default" looked identical
   * from every screen an operator had. This answers both in one response.
   */
  @Get('earnings')
  async earningsReport(): Promise<EarningsReport> {
    return this.earnings.report();
  }

  @Post('errors/resolve-all')
  @HttpCode(200)
  async errorResolveAll(): Promise<{ resolved: number }> {
    return { resolved: await this.errors.resolveAll() };
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
