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
import { z } from 'zod';
import { DataRightsService } from './data-rights.service.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

const requestSchema = z.object({
  kind: z.enum(['export', 'erasure']),
  // Read by AuthGuard, not here. Declared so the body validates.
  transaction_pin: z.string().optional(),
});

/**
 * A customer's own data.
 *
 * THE EXPORT REQUIRES A PIN, and that is a departure from every other read
 * here worth stating. A balance is one number; this is every balance, every
 * transaction, every device and every place they have signed in from, in one
 * file — the single thing a stolen session most wants, and the one read whose
 * consequence survives the fifteen minutes an access token lasts. The PIN is
 * the factor the thief is least likely to have.
 *
 * Asking for erasure does NOT require one, for the same reason raising a
 * dispute does not: the customer most likely to ask is one who has just
 * discovered somebody else is in their account, and demanding the factor that
 * person may already have is worst exactly then. Nothing is destroyed by
 * asking — a reviewer decides.
 */
@Controller('v1/me')
export class DataRightsController {
  constructor(@Inject(DataRightsService) private readonly rights: DataRightsService) {}

  @Post('export')
  @HttpCode(200)
  async export(@Req() request: AuthenticatedRequest): Promise<Record<string, unknown>> {
    return this.rights.export(await this.#userId(request));
  }

  @Get('requests')
  async requests(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ requests: readonly unknown[] }> {
    return { requests: await this.rights.requestsFor(await this.#userId(request)) };
  }

  @Post('requests')
  @HttpCode(201)
  async request(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<Record<string, unknown>> {
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    return this.rights.request(await this.#userId(request), parsed.data.kind);
  }

  /** What can be erased and what cannot, with the reason. PUBLISHED TO THE
   *  CUSTOMER rather than only to staff: being refused with no way to learn
   *  what would change is what turns a right into a support ticket, which is
   *  the same argument `GET /v1/kyc/limits` rests on. */
  @Get('erasure-scope')
  async scope(): Promise<{ scope: readonly unknown[] }> {
    return { scope: await this.rights.scope() };
  }

  async #userId(request: AuthenticatedRequest): Promise<string> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('data rights route reached without claims');
    return this.rights.userIdOf(claims.sub);
  }
}
