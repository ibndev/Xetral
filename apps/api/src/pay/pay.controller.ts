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
} from '@nestjs/common';
import { z } from 'zod';
import { PaymentLinkService } from './payment-link.service.js';

/**
 * THE PUBLIC CHECKOUT, and every route here is reachable without a session.
 *
 * That is the point of it: a payment link paid only by people who already
 * have an account is a shortcut, not a payment link. So this is the one
 * customer-facing surface with no bearer token anywhere, and it is shaped
 * accordingly —
 *
 *   - the LOOKUP answers a name and a currency and nothing else, so it cannot
 *     be walked to harvest anything, and answers identically for a slug that
 *     never existed and one whose owner closed their account;
 *   - the CHARGE writes a row and hands the payer to Paystack, so no card
 *     detail, no account number and no PIN ever reaches this API;
 *   - the SETTLE takes a reference and verifies it WITH PAYSTACK before
 *     anything is credited, so calling it with a made-up reference does
 *     nothing at all.
 *
 * All three are metered by the public rate-limit bucket, which is what the
 * policy's class gives an unauthenticated route — the tight one, because
 * these are the only routes here a stranger can reach at all.
 */
const slugParam = z.string().trim().regex(/^[a-z0-9]{8,32}$/);

const beginSchema = z
  .object({
    /** MAJOR units as a decimal STRING, parsed once by `fromMajor`. */
    amount: z.string().trim().min(1).max(32),
    /** Both rails require one and send the receipt there. */
    email: z.string().trim().email().max(255),
    name: z.string().trim().min(1).max(120).optional(),
    /**
     * WHAT THE PAYER CHOSE TO PAY IN.
     *
     * Validated as a SHAPE here and as a MEMBERSHIP in the service, against
     * the routes this deployment actually holds — a client must not be able
     * to widen what the platform collects by sending a different string, and
     * the list is data rather than an enum in this file for the same reason
     * a country is.
     */
    currency: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{3,4}$/)
      .optional(),
    /**
     * WHAT IT IS FOR, in the payer's words.
     *
     * Carried into the provider's metadata and onto the receipt, and inert
     * everywhere else: it can never alter the amount, the currency or who is
     * credited. Bounded because it goes into somebody else's system for ever.
     */
    note: z.string().trim().min(1).max(140).optional(),
  })
  .strict();

const settleSchema = z.object({ reference: z.string().trim().min(8).max(64) }).strict();

@Controller('v1/pay')
export class PayController {
  constructor(@Inject(PaymentLinkService) private readonly links: PaymentLinkService) {}

  /** Who this link pays. A name and a currency — see `payable_links` in 058. */
  @Get(':slug')
  async payee(
    @Param('slug') slug: string,
  ): Promise<{ name: string; currency: string; currencies: readonly string[] }> {
    return this.links.payee(parseSlug(slug));
  }

  /** Start a payment, and hand back where to send the payer. */
  @Post(':slug/charge')
  @HttpCode(200)
  async charge(
    @Param('slug') slug: string,
    @Body() body: unknown,
  ): Promise<{ authorization_url: string; reference: string }> {
    const parsed = beginSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    return this.links.begin(parseSlug(slug), {
      amount: parsed.data.amount,
      payerEmail: parsed.data.email,
      ...(parsed.data.name === undefined ? {} : { payerName: parsed.data.name }),
      ...(parsed.data.currency === undefined
        ? {}
        : { currency: parsed.data.currency.toUpperCase() }),
      ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }),
    });
  }

  /**
   * The payer coming back from Paystack.
   *
   * IT VERIFIES WITH PAYSTACK rather than believing the caller, so this being
   * public and unsigned grants nobody anything: a made-up reference matches no
   * row, and a real one is credited only if Paystack says it was paid — which
   * is exactly what the webhook checks. What it buys is that the customer sees
   * the money in the second it takes the payer to come back, rather than
   * whenever the webhook lands.
   */
  @Post('settle')
  @HttpCode(200)
  async settle(@Body() body: unknown): Promise<{ status: string }> {
    const parsed = settleSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException({ error: 'invalid_request' });
    return { status: await this.links.settle(parsed.data.reference) };
  }
}

function parseSlug(raw: string): string {
  const parsed = slugParam.safeParse(raw);
  /*
   * THE SAME ANSWER A REAL-BUT-UNKNOWN SLUG GETS — 404 and `link_not_found`,
   * which is what `payee()` throws — and the status has to match as well as
   * the code. This was a `BadRequestException`, so a malformed slug answered
   * 400 and an unknown one 404: two answers, from a page anybody can open, is
   * a way to learn which slugs are the right SHAPE and therefore worth
   * guessing. Caught by asserting the two responses are equal rather than by
   * asserting each one separately, which is how they came to differ.
   */
  if (!parsed.success) throw new NotFoundException({ error: 'link_not_found' });
  return parsed.data;
}
