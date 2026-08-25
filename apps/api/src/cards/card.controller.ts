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
import type { Request } from 'express';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { CardService } from './card.service.js';
import type { CardSecretsView, CardView } from './card.service.js';
import { CardWebhookService } from './webhook.service.js';
import type { WebhookOutcome } from './webhook.service.js';
import { fundCardSchema, issueCardSchema } from './dto.js';

@Controller('v1/cards')
export class CardController {
  constructor(@Inject(CardService) private readonly cards: CardService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{ cards: readonly CardView[] }> {
    return { cards: await this.cards.list(subjectOf(request)) };
  }

  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CardView> {
    return this.cards.get(subjectOf(request), id);
  }

  @Post()
  @HttpCode(201)
  async issue(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<CardView> {
    const parsed = issueCardSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    return this.cards.issue(subjectOf(request), {
      nameOnCard: parsed.data.name_on_card,
      initialFunding: parsed.data.initial_funding,
      idempotencyKey: parsed.data.idempotency_key,
    });
  }

  @Post(':id/fund')
  @HttpCode(200)
  async fund(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CardView> {
    const parsed = fundCardSchema.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);

    return this.cards.fund(subjectOf(request), id, {
      amount: parsed.data.amount,
      idempotencyKey: parsed.data.idempotency_key,
    });
  }

  /**
   * The card number, the CVV and the expiry.
   *
   * POST rather than GET, and not for REST tidiness. A GET puts the card id in
   * access logs, browser history and `Referer` headers, is prefetched by
   * browsers and cached by intermediaries — none of which is acceptable for
   * the request that returns a PAN. It also could not carry the PIN, which
   * travels in the body so `redactPayload` scrubs it from anything that logs
   * one.
   *
   * The response is the only place in this API where a full card number
   * appears. It is not stored, not logged, and not repeated in the audit
   * detail: `card_reveals` records THAT it happened, never what it showed.
   */
  @Post(':id/reveal')
  @HttpCode(200)
  async reveal(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CardSecretsView> {
    return this.cards.reveal(subjectOf(request), id, request.ip);
  }

  /** No PIN. Freezing is the protective action, and a customer watching
   *  fraudulent charges land should not have to remember one first. */
  @Post(':id/freeze')
  @HttpCode(200)
  async freeze(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CardView> {
    return this.cards.freeze(subjectOf(request), id);
  }

  /** Unfreezing re-enables spending, so it does require a PIN. */
  @Post(':id/unfreeze')
  @HttpCode(200)
  async unfreeze(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CardView> {
    return this.cards.unfreeze(subjectOf(request), id);
  }

  @Post(':id/terminate')
  @HttpCode(200)
  async terminate(
    @Req() request: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<CardView> {
    return this.cards.terminate(subjectOf(request), id);
  }
}

/**
 * The Bitnob webhook.
 *
 * Public, because Bitnob has no session with us — the signature IS the
 * authentication, and it is checked against the raw body before anything is
 * parsed.
 */
@Controller('v1/webhooks')
export class CardWebhookController {
  constructor(@Inject(CardWebhookService) private readonly webhooks: CardWebhookService) {}

  @Post('bitnob')
  @HttpCode(200)
  async bitnob(@Req() request: Request): Promise<WebhookOutcome> {
    // Nest populates rawBody when the app is created with `rawBody: true`.
    // Falling back to a re-serialised body would silently break verification,
    // so its absence is a hard failure instead.
    const raw = (request as Request & { rawBody?: Buffer }).rawBody;
    if (raw === undefined) {
      throw new Error('rawBody is missing; the app must be created with rawBody: true');
    }

    const headers: Record<string, string | undefined> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      headers[name] = Array.isArray(value) ? value[0] : value;
    }

    return this.webhooks.handle(raw.toString('utf8'), headers);
  }
}

function subjectOf(request: AuthenticatedRequest): string {
  const claims = request.auth;
  if (claims === undefined) throw new Error('card route reached without verified claims');
  return claims.sub;
}

/** Zod's issue paths can contain symbols (for symbol-keyed properties), so the
 *  segments are stringified rather than assumed to be string | number. */
function invalidRequest(
  issues: readonly { readonly path: readonly PropertyKey[] }[],
): BadRequestException {
  return new BadRequestException({
    error: 'invalid_request',
    fields: issues.map((issue) => issue.path.map((segment) => String(segment)).join('.')),
  });
}
