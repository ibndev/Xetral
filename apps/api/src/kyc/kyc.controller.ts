import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { KycService } from './kyc.service.js';
import type { KycView } from './kyc.service.js';
import { kycSchema } from './dto.js';

/**
 * Identity verification, from the customer's side.
 *
 * Submitting is not a money movement, so no PIN — but it is authenticated,
 * because the whole point is to attach documents to a known account. The
 * review side lives in the admin controller, where it is gated on the
 * `compliance` role.
 */
@Controller('v1/kyc')
export class KycController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  @Get()
  async mine(@Req() request: AuthenticatedRequest): Promise<{ kyc: KycView | null }> {
    return { kyc: await this.kyc.mine(claims(request).sub) };
  }

  @Post()
  @HttpCode(200)
  async submit(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<KycView> {
    const parsed = kycSchema.safeParse(body);
    if (!parsed.success) {
      // Field paths only. This body carries a BVN.
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    return this.kyc.submit(claims(request).sub, parsed.data);
  }
}

function claims(request: AuthenticatedRequest): NonNullable<AuthenticatedRequest['auth']> {
  const value = request.auth;
  if (value === undefined) throw new Error('kyc route reached without verified claims');
  return value;
}
