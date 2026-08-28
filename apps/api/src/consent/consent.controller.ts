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
import { ConsentService } from './consent.service.js';
import type { ConsentKind, ConsentView } from './consent.service.js';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';

const consentSchema = z.object({
  kind: z.enum(['terms', 'privacy', 'marketing_email']),
  granted: z.boolean(),
});

/**
 * What a customer agreed to, and the one call that changes it.
 *
 * NO TRANSACTION PIN, on either route, and that is a decision rather than an
 * omission. Consent that is harder to withdraw than to give is not freely
 * given, so stopping the email cannot be gated on a factor a customer may not
 * remember — and nothing here moves money.
 */
@Controller('v1/consents')
export class ConsentController {
  constructor(@Inject(ConsentService) private readonly consents: ConsentService) {}

  @Get()
  async list(@Req() request: AuthenticatedRequest): Promise<{
    consents: readonly unknown[];
    documents: readonly unknown[];
  }> {
    return this.consents.forUser(await this.#userId(request));
  }

  @Post()
  @HttpCode(200)
  async record(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConsentView> {
    const parsed = consentSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    return this.consents.record(
      await this.#userId(request),
      parsed.data.kind as ConsentKind,
      parsed.data.granted,
      // Both describe the consent and neither decides it — the same terms on
      // which a sign-in's address is trusted.
      { ip: request.ip, userAgent: request.headers['user-agent'] },
    );
  }

  async #userId(request: AuthenticatedRequest): Promise<string> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('consent route reached without verified claims');
    return this.consents.userIdOf(claims.sub);
  }
}
