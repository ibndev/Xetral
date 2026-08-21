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
import type { VerifiedTarget } from '@xetral/providers';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { PurchaseService } from './purchase.service.js';
import type { CatalogueItemView, PurchaseView } from './purchase.service.js';
import { catalogueQuerySchema, purchaseSchema, verifyTargetSchema } from './dto.js';

/**
 * Airtime, data, utilities, eSIMs and virtual numbers — one controller, because
 * from the customer's side they are the same transaction: pay this much, get
 * that thing. Which provider serves it is a routing decision inside the
 * service, and giving each one its own controller would put that decision in
 * the URL, where changing it later breaks every client.
 */
@Controller('v1/purchases')
export class PurchaseController {
  constructor(@Inject(PurchaseService) private readonly purchases: PurchaseService) {}

  /** What can be bought, and for how much. Reading a price list moves no
   *  money, so no PIN — but it still needs a session: the catalogue names the
   *  providers we use and their product codes. */
  @Get('catalogue')
  async catalogue(@Query() query: unknown): Promise<{ items: readonly CatalogueItemView[] }> {
    const parsed = catalogueQuerySchema.safeParse(query);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const items = await this.purchases.catalogue(parsed.data.service, parsed.data.group);
    return { items };
  }

  /**
   * "Whose meter is this?" — asked BEFORE paying, deliberately.
   *
   * An electricity payment to a mistyped meter number succeeds at the provider
   * and credits a stranger, and there is no reversal for that. This is the one
   * chance to show a customer the name on the account.
   */
  @Post('verify')
  @HttpCode(200)
  async verify(@Body() body: unknown): Promise<VerifiedTarget> {
    const parsed = verifyTargetSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const { service, item_code, target } = parsed.data;
    return this.purchases.verifyTarget(service, item_code, target);
  }

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ purchases: readonly PurchaseView[] }> {
    return { purchases: await this.purchases.list(claimsOf(request).sub) };
  }

  /**
   * 200 rather than 201, and the same reasoning as a transfer: the response is
   * the outcome of a movement, not a representation of a resource at a new URL.
   * A purchase left `reserved` after a provider timeout answers 200 as well —
   * the request was accepted and the money is correctly held; telling the
   * customer it failed would be a lie we would have to take back.
   */
  @Post()
  @HttpCode(200)
  async buy(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<PurchaseView> {
    const parsed = purchaseSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    return this.purchases.buy(claimsOf(request).sub, parsed.data);
  }
}

/** Field paths only, never values. The body of a purchase carries a
 *  transaction PIN, and echoing the input back would put it in the response and
 *  in whatever logs that. */
function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) {
    // Unreachable: AuthGuard denies any route without a policy, and every route
    // here is declared `authenticated`. Throwing beats a non-null assertion,
    // which would turn a wiring mistake into a purchase attributed to nobody.
    throw new Error('authenticated route reached with no claims');
  }
  return claims;
}
