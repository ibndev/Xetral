import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { FxService } from './fx.service.js';
import type { FxQuoteView, FxTradeView } from './fx.service.js';
import { convertSchema, fxQuoteSchema } from './dto.js';

@Controller('v1/fx')
export class FxController {
  constructor(@Inject(FxService) private readonly fx: FxService) {}

  /** What a conversion would give. Moves nothing, so no PIN — but
   *  authenticated: an open rate endpoint is a live price feed for anyone
   *  who wants to trade against our spread. */
  @Get('quote')
  async quote(@Query() query: unknown): Promise<FxQuoteView> {
    const parsed = fxQuoteSchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.fx.quote(parsed.data);
  }

  @Get('trades')
  async list(@Req() request: AuthenticatedRequest): Promise<{ trades: readonly FxTradeView[] }> {
    return { trades: await this.fx.list(claimsOf(request).sub) };
  }

  /**
   * Convert, or remit to somebody else. Requires a transaction PIN.
   *
   * 200 rather than 201: the response is the outcome of a movement, not a
   * resource at a new URL — the same reasoning as a transfer and a purchase.
   */
  @Post('convert')
  @HttpCode(200)
  async convert(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<FxTradeView> {
    const parsed = convertSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.fx.convert(claimsOf(request).sub, parsed.data);
  }
}

/** Field paths only — the body carries a PIN. */
function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('fx route reached without verified claims');
  return claims;
}
