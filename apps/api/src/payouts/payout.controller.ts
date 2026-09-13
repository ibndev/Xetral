import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { PayoutService } from './payout.service.js';
import type { PayoutView } from './payout.service.js';
import {
  banksQuerySchema,
  branchesQuerySchema,
  lookupQuerySchema,
  payoutSchema,
} from './dto.js';
import type { PayoutBank, PayoutBranch } from '@xetral/providers';

/**
 * Sending money out of the platform, to a bank.
 *
 * Three routes and three different answers to "does this need a PIN":
 *
 *  - `banks` is a catalogue. No PIN; it is the same list for everybody.
 *  - `lookup` reads a name the BANK holds. No PIN, for the reason raising a
 *    dispute takes none — nothing is destroyed by asking, and the customer
 *    most likely to check a name twice is one being careful. It is still
 *    counted by the ordinary authenticated ceiling, because a lookup with no
 *    limit is a way to walk a bank's account space and harvest names.
 *  - `send` moves money that cannot be recalled. PIN.
 */
@Controller('v1/payouts')
export class PayoutController {
  constructor(@Inject(PayoutService) private readonly payouts: PayoutService) {}

  @Get('banks')
  async banks(@Query() query: unknown): Promise<{ banks: readonly PayoutBank[] }> {
    const parsed = banksQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return { banks: await this.payouts.banks(parsed.data.country, parsed.data.method) };
  }

  /**
   * The branches of one bank, or nothing where the corridor needs none.
   *
   * AN EMPTY LIST IS THE COMMON ANSWER and is not a failure — only Ghana
   * requires a branch code today. A catalogue, so no PIN, exactly like the
   * bank list it follows.
   */
  @Get('branches')
  async branches(@Query() query: unknown): Promise<{ branches: readonly PayoutBranch[] }> {
    const parsed = branchesQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return { branches: await this.payouts.branches(parsed.data) };
  }

  @Get('lookup')
  async lookup(@Query() query: unknown): Promise<{ account_name: string }> {
    const parsed = lookupQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.payouts.lookup(parsed.data);
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ payouts: readonly PayoutView[] }> {
    return { payouts: await this.payouts.list(claimsOf(request).sub) };
  }

  /**
   * Send it. Requires a transaction PIN.
   *
   * As irrecoverable as a crypto withdrawal in practice: once a Nigerian
   * instant transfer lands there is no recall, only asking the recipient. The
   * PIN and the bank's own name lookup are the whole of the protection.
   */
  @Post()
  @HttpCode(200)
  async send(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<PayoutView> {
    const parsed = payoutSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.payouts.send(claimsOf(request).sub, parsed.data);
  }
}

/** Field paths only — this body carries a PIN and an account number. */
function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('payout route reached without verified claims');
  return claims;
}
