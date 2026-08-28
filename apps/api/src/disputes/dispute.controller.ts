import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { DisputeService } from './dispute.service.js';
import type { DisputeView, QueuedDispute } from './dispute.service.js';
import { raiseDisputeSchema, resolveDisputeSchema, withdrawDisputeSchema } from './dto.js';

/**
 * What a customer can do about a transaction they say is wrong.
 *
 * NO TRANSACTION PIN on raising one, and that is deliberate rather than an
 * oversight. A dispute moves no money, and the customer most likely to raise
 * one is the customer who has just discovered somebody else is using their
 * account — which is precisely when demanding the factor that other person may
 * already have is worst. The same reasoning freezes a card without a PIN and
 * asks for one to unfreeze it: the protective action has to be frictionless.
 */
@Controller('v1/disputes')
export class DisputeController {
  constructor(@Inject(DisputeService) private readonly disputes: DisputeService) {}

  @Post()
  @HttpCode(200)
  async raise(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<DisputeView> {
    const parsed = raiseDisputeSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.disputes.raise(subjectOf(request), parsed.data);
  }

  @Get()
  async mine(@Req() request: AuthenticatedRequest): Promise<readonly DisputeView[]> {
    return this.disputes.listMine(subjectOf(request));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  async withdraw(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DisputeView> {
    const parsed = withdrawDisputeSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.disputes.withdraw(subjectOf(request), id, parsed.data.resolution);
  }
}

/**
 * The reviewer's side.
 *
 * Under `/v1/admin/`, which is not a naming convention: `route-coverage.test.ts`
 * fails the build if a route under that prefix is declared with
 * `authenticated()` rather than `staff()`. Forgetting would leave the endpoint
 * that pays money out of our own account reachable by every signed-in customer,
 * and it would not look wrong in a diff.
 */
@Controller('v1/admin/disputes')
export class AdminDisputeController {
  constructor(@Inject(DisputeService) private readonly disputes: DisputeService) {}

  @Get()
  async queue(): Promise<readonly QueuedDispute[]> {
    return this.disputes.queue();
  }

  @Post(':id/resolve')
  @HttpCode(200)
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<DisputeView> {
    const parsed = resolveDisputeSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.disputes.resolve(
      subjectOf(request),
      id,
      parsed.data,
      request.ip ?? undefined,
    );
  }
}

function subjectOf(request: AuthenticatedRequest): string {
  const sub = request.auth?.sub;
  // Unreachable behind AuthGuard, which sets `auth` before any handler runs.
  // Throwing rather than defaulting means a future change that bypasses the
  // guard fails loudly instead of attributing a dispute to nobody.
  if (sub === undefined) throw new BadRequestException({ error: 'invalid_token' });
  return sub;
}

function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((issue) => issue.path.join('.')),
  });
}
