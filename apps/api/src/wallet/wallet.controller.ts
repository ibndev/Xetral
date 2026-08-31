import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { WalletService } from './wallet.service.js';
import type { BalanceView, TransferResult } from './wallet.service.js';
import { historyQuerySchema, transferSchema } from './dto.js';

@Controller('v1/wallets')
export class WalletController {
  constructor(@Inject(WalletService) private readonly wallets: WalletService) {}

  @Get()
  async balances(@Req() request: AuthenticatedRequest): Promise<{ balances: readonly BalanceView[] }> {
    return { balances: await this.wallets.balances(claimsOf(request).sub) };
  }

  @Get('transactions')
  async transactions(
    @Req() request: AuthenticatedRequest,
    @Query() query: unknown,
  ): Promise<unknown> {
    const parsed = historyQuerySchema.safeParse(query);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    const { currency, limit, before, kinds } = parsed.data;
    return this.wallets.history(claimsOf(request).sub, currency, {
      limit,
      ...(before === undefined ? {} : { before }),
      ...(kinds === undefined ? {} : { kinds }),
    });
  }

  /**
   * The first money-moving route in the platform.
   *
   * It declares `pin: true` in routes.ts, so AuthGuard verifies the
   * transaction PIN before this handler runs. Until Phase 4 that flag made a
   * route refuse to serve at all — deliberately, so nothing could ship
   * believing it was protected by a check that did not exist.
   *
   * 200 rather than 201: the response is the outcome of a movement, not a
   * representation of a created resource at some new URL.
   */
  @Post('transfers')
  @HttpCode(200)
  async transfer(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<TransferResult> {
    const parsed = transferSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        // Field paths only. The body carries a PIN, and echoing values back
        // would put it in the response and in whatever logs that.
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    return this.wallets.transfer(claimsOf(request).sub, parsed.data);
  }
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  // The guard has already rejected anything without verified claims, so this
  // is a programming error rather than an untrusted-input path.
  if (claims === undefined) throw new Error('wallet route reached without verified claims');
  return claims;
}
