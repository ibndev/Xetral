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
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { CryptoService } from './crypto.service.js';
import type { CryptoAddressView, CryptoQuoteView, WithdrawalView } from './crypto.service.js';
import { CryptoWebhookService } from './crypto-webhook.service.js';
import { addressSchema, quoteSchema, withdrawSchema } from './dto.js';
import type { Currency } from '@xetral/shared';

@Controller('v1/crypto')
export class CryptoController {
  constructor(@Inject(CryptoService) private readonly crypto: CryptoService) {}

  /**
   * The customer's deposit address.
   *
   * POST because the first call creates it at the provider. No PIN: receiving
   * money is not spending it, and a customer should never be blocked from
   * being paid.
   */
  @Post('addresses')
  @HttpCode(200)
  async address(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<CryptoAddressView> {
    const parsed = addressSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.crypto.addressFor(
      claimsOf(request).sub,
      parsed.data.asset as Currency,
      parsed.data.network,
    );
  }

  /** What a withdrawal would cost. Moves nothing, so no PIN. */
  @Get('withdrawals/quote')
  async quote(@Query() query: unknown): Promise<CryptoQuoteView> {
    const parsed = quoteSchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.crypto.quote(parsed.data);
  }

  @Get('withdrawals')
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ withdrawals: readonly WithdrawalView[] }> {
    return { withdrawals: await this.crypto.listWithdrawals(claimsOf(request).sub) };
  }

  /**
   * Send crypto off-platform. Requires a transaction PIN.
   *
   * The most irreversible action in the product: no chargeback, no recall, no
   * provider to appeal to. The PIN, the address checksum and the fee ceiling
   * are the whole of the protection, because nothing after the broadcast
   * exists.
   */
  @Post('withdrawals')
  @HttpCode(200)
  async withdraw(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<WithdrawalView> {
    const parsed = withdrawSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.crypto.withdraw(claimsOf(request).sub, parsed.data);
  }
}

/** Bitnob's on-chain webhook. Public, authenticated by an HMAC over the raw
 *  body — see the funding webhook for the same reasoning. */
@Controller('v1/webhooks')
export class CryptoWebhookController {
  constructor(@Inject(CryptoWebhookService) private readonly crypto: CryptoWebhookService) {}

  @Post('bitnob/crypto')
  @HttpCode(200)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) throw new BadRequestException({ error: 'raw_body_unavailable' });

    await this.crypto.handle(raw.toString('utf8'), request.headers as Record<string, string>);
    return { received: true };
  }
}

/** Field paths only — these bodies carry PINs and destination addresses. */
function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('crypto route reached without verified claims');
  return claims;
}
