import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { FundingService } from './funding.service.js';
import type { DepositView, VirtualAccountView } from './funding.service.js';
import { DepositWebhookService } from './deposit-webhook.service.js';
import { PaystackWebhookService } from './paystack-webhook.service.js';

@Controller('v1/funding')
export class FundingController {
  constructor(@Inject(FundingService) private readonly funding: FundingService) {}

  /**
   * The customer's dedicated account number.
   *
   * A POST rather than a GET because the first call CREATES the account at the
   * provider. It is idempotent — the unique constraint guarantees one live
   * account per customer — but it is not a read, and modelling it as one would
   * invite a client to call it on every screen render.
   */
  @Post('account')
  @HttpCode(200)
  async account(@Req() request: AuthenticatedRequest): Promise<VirtualAccountView> {
    return this.funding.accountFor(claimsOf(request).sub);
  }

  /**
   * The account this customer already has, if any. A READ.
   *
   * The comment above says modelling issuing as a read "would invite a client
   * to call it on every screen render" — which is exactly what the Add money
   * screen did, because there was nothing else to call. So every visit to that
   * page opened a bank account as a side effect of being looked at. This is
   * the question that page was actually asking.
   *
   * `{ account: null }` rather than a 404: not having one is the resting state
   * of every new customer, and a client that has to catch an error to render
   * its ordinary case will eventually catch a real one with it.
   */
  @Get('account')
  async existingAccount(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ account: VirtualAccountView | null }> {
    return { account: (await this.funding.existingAccount(claimsOf(request).sub)) ?? null };
  }

  /** What has landed. Reading this moves nothing, so no PIN. */
  @Get('deposits')
  async deposits(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ deposits: readonly DepositView[] }> {
    return { deposits: await this.funding.deposits(claimsOf(request).sub) };
  }
}

/**
 * Bitnob's deposit webhook.
 *
 * Separate controller because it is PUBLIC — Bitnob has no session with us —
 * and the authentication is an HMAC over the raw body, checked before anything
 * is parsed. Keeping it apart from the customer-facing routes means the
 * `public` declaration in routes.ts covers exactly one path and reads as the
 * deliberate exception it is.
 */
@Controller('v1/webhooks')
export class DepositWebhookController {
  constructor(
    @Inject(DepositWebhookService) private readonly deposits: DepositWebhookService,
    @Inject(PaystackWebhookService)
    private readonly paystackDeposits: PaystackWebhookService,
  ) {}

  /**
   * Paystack, the default rail.
   *
   * Its OWN route rather than a branch inside the Bitnob one: the two are
   * signed with different credentials and carry no field in common, so a
   * single endpoint would be two handlers with a shared chance to run the
   * wrong one against money-creating input.
   */
  @Post('paystack/deposits')
  @HttpCode(200)
  async paystack(@Req() request: Request): Promise<{ received: true }> {
    // The RAW body, not the parsed one. The signature covers the exact bytes
    // Paystack sent, and a re-serialised object normalises whitespace and
    // unicode escapes — producing failures that look like a wrong key.
    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) {
      throw new BadRequestException({ error: 'raw_body_unavailable' });
    }

    await this.paystackDeposits.handle(
      raw.toString('utf8'),
      request.headers as Record<string, string>,
    );

    // 200 and nothing else. A body here would be the only place a webhook
    // could leak what we know about a customer to whoever can reach the URL.
    return { received: true };
  }

  @Post('bitnob/deposits')
  @HttpCode(200)
  async receive(@Req() request: Request): Promise<{ received: true }> {
    // The RAW body, not the parsed one. The signature covers the exact bytes
    // Bitnob sent, and a re-serialised object normalises whitespace and
    // unicode escapes — producing failures that look like a wrong secret.
    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) {
      throw new BadRequestException({ error: 'raw_body_unavailable' });
    }

    await this.deposits.handle(raw.toString('utf8'), request.headers as Record<string, string>);

    // 200 and nothing else. A body here would be the only place a webhook
    // could leak what we know about a customer to whoever can reach the URL.
    return { received: true };
  }
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('funding route reached without verified claims');
  return claims;
}
