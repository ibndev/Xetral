import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { RecipientBookService } from './recipient-book.service.js';
import type { RecipientResolution, RecipientView } from './recipient-book.service.js';
import { createRecipientSchema, resolveRecipientSchema } from './dto.js';

/**
 * The customer's own address book, behind one Send flow.
 *
 * EVERY ROUTE IS `authenticated` AND NONE TAKES A PIN. The service's header
 * says why: a saved recipient moves nothing, the send takes a PIN and
 * re-fetches the rail's name on that request, and the destination is immutable
 * by trigger — so the control is where the money is, not on the address book.
 */
@Controller('v1/recipients')
export class RecipientBookController {
  constructor(@Inject(RecipientBookService) private readonly book: RecipientBookService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{
    recipients: readonly RecipientView[];
  }> {
    return { recipients: await this.book.list(callerOf(request)) };
  }

  /**
   * WHO HOLDS THIS, BEFORE ANYTHING IS SAVED.
   *
   * A POST rather than a GET, unlike `/v1/payouts/lookup` which it partly
   * replaces. The destination is a phone number or an account number, and a
   * query string is the one place a value lands in a browser history, a proxy
   * log and a referrer at once. `.strict()` on a body also refuses a field a
   * client believes it is sending, which a query string cannot.
   *
   * It answers 200 rather than 201 because it CREATES NOTHING.
   */
  @Post('resolve')
  @HttpCode(200)
  async resolve(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<RecipientResolution> {
    const parsed = resolveRecipientSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    return this.book.resolve(callerOf(request), parsed.data);
  }

  @Post()
  @HttpCode(201)
  async create(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<RecipientView> {
    const parsed = createRecipientSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    return this.book.create(callerOf(request), parsed.data);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@Req() request: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    await this.book.remove(callerOf(request), id);
  }
}

/**
 * The verified caller, or a thrown error rather than an optional.
 *
 * `AuthenticatedRequest['auth']` is optional because the type describes every
 * request, and `AuthGuard` refuses an undeclared route before a handler runs —
 * so reaching one of these without claims is a bug in the guard rather than
 * a request to answer. The same helper `payout.controller.ts` uses, and it
 * throws for the same reason: an optional chained away here would turn a
 * broken guard into a query for user `undefined`.
 */
function callerOf(request: AuthenticatedRequest): string {
  const claims = request.auth;
  if (claims === undefined) throw new Error('recipient route reached without verified claims');
  return claims.sub;
}
