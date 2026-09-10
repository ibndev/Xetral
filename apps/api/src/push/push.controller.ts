import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { PushService } from './push.service.js';

/**
 * The handset a customer is signed in on.
 *
 * NO PIN ON EITHER ROUTE. Registering an address moves no money, and a token
 * is not a credential — it lets its holder send a notification to one handset
 * and nothing else. Demanding the factor that authorises spending in order to
 * become reachable would mean a customer with no PIN set could never be told
 * anything.
 *
 * THE TOKEN'S SHAPE IS CHECKED HERE AND ENFORCED BY 065's CHECK. This is the
 * readable refusal; the constraint is the rule.
 */
const registerSchema = z
  .object({
    token: z.string().trim().regex(/^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$/),
    platform: z.enum(['ios', 'android']),
  })
  .strict();

const revokeSchema = z
  .object({
    token: z.string().trim().regex(/^ExponentPushToken\[[A-Za-z0-9_-]{1,64}\]$/),
  })
  .strict();

@Controller('v1/push')
export class PushController {
  constructor(@Inject(PushService) private readonly push: PushService) {}

  @Post('devices')
  @HttpCode(204)
  async register(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });

    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.push.register(auth.sub, parsed.data.token, parsed.data.platform);
  }

  /**
   * Retires this handset — what signing out calls.
   *
   * A 204 whether or not it matched. A sign-out must never fail because the
   * handset was already retired, and an endpoint answering differently for
   * "not yours" and "not here" would say which tokens exist.
   */
  @Post('devices/revoke')
  @HttpCode(204)
  async revoke(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });

    const parsed = revokeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.push.revoke(auth.sub, parsed.data.token);
  }
}
