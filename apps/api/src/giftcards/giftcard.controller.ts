import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { GiftCardService } from './giftcard.service.js';
import type { GiftCardView, QuoteView } from './giftcard.service.js';
import { clawbackSchema, quoteSchema, reviewSchema, submitGiftCardSchema } from './dto.js';

/**
 * What a customer can do: ask a price, sell a card, see their own submissions.
 *
 * Every route here refuses with `gift_cards_disabled` until the feature flag
 * is set. They are declared, policed and tested all the same — a flagged-off
 * feature whose code has never run is not flagged off, it is unfinished.
 */
@Controller('v1/giftcards')
export class GiftCardController {
  constructor(@Inject(GiftCardService) private readonly giftcards: GiftCardService) {}

  /** What we would pay. Moves nothing, so no PIN — but authenticated, because
   *  a public rate endpoint is a live price feed for our competitors. */
  @Post('quote')
  @HttpCode(200)
  async quote(@Body() body: unknown): Promise<QuoteView> {
    const parsed = quoteSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.giftcards.quote(parsed.data);
  }

  /**
   * Sell a card. Requires a transaction PIN.
   *
   * Nothing moves yet — this creates an offer a human will review — but the
   * PIN is still required, because the request hands over a bearer instrument
   * from the customer's account and a stolen session should not be able to
   * launder cards through somebody else's identity.
   */
  @Post()
  @HttpCode(200)
  async submit(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<GiftCardView> {
    const parsed = submitGiftCardSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.giftcards.submit(claimsOf(request).sub, parsed.data);
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ submissions: readonly GiftCardView[] }> {
    return { submissions: await this.giftcards.list(claimsOf(request).sub) };
  }
}

/**
 * What a reviewer can do.
 *
 * A separate controller under `/v1/admin/`, and the path prefix is load
 * bearing: `route-coverage.test.ts` fails the build if any route beginning
 * `/v1/admin/` is not declared through `RoutePolicyRegistry.staff()`. Getting
 * the privileged surface wrong is then a red test rather than an approval
 * endpoint any signed-in customer can call.
 */
@Controller('v1/admin/giftcards')
export class GiftCardReviewController {
  constructor(@Inject(GiftCardService) private readonly giftcards: GiftCardService) {}

  @Get('queue')
  async queue(): Promise<{ queue: readonly Record<string, unknown>[] }> {
    return { queue: await this.giftcards.queue() };
  }

  /** Reveals ONE card code, so a reviewer can check its balance. Deliberately
   *  not part of the queue listing — see the service. */
  @Post(':id/reveal')
  @HttpCode(200)
  async reveal(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ card_code: string }> {
    return this.giftcards.revealCard(id, claimsOf(request).sub);
  }

  /**
   * Approve or reject. Requires the reviewer's own transaction PIN.
   *
   * Approving pays a customer, so it is a money-moving action by any
   * reasonable reading, and a reviewer who walked away from an unlocked laptop
   * should not have left an approval button behind.
   */
  @Post(':id/review')
  @HttpCode(200)
  async review(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<GiftCardView> {
    const parsed = reviewSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    const reviewer = claimsOf(request).sub;
    if (parsed.data.decision === 'approve') {
      return this.giftcards.approve(id, reviewer);
    }

    const reason = parsed.data.reason;
    if (reason === undefined) {
      // The schema cannot express "required only when rejecting" without
      // making the error message worse, and the customer is always told why.
      throw new BadRequestException({ error: 'invalid_request', fields: ['reason'] });
    }
    return this.giftcards.reject(id, reviewer, reason);
  }

  /** Take it back, while it is still held. */
  @Post(':id/clawback')
  @HttpCode(200)
  async clawback(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<GiftCardView> {
    const parsed = clawbackSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    return this.giftcards.clawback(id, claimsOf(request).sub, parsed.data.reason);
  }
}

/** Field paths only, never values. These bodies carry PINs and card codes. */
function invalidRequest(issues: readonly { path: PropertyKey[] }[]): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((i) => i.path.join('.')),
  });
}

function claimsOf(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const claims = request.auth;
  if (claims === undefined) throw new Error('gift card route reached without verified claims');
  return claims;
}
