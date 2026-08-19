import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import type { SessionSummary, TokenPair } from './auth.service.js';
import { LoginRateLimitGuard } from './login-rate-limit.guard.js';
import { loginSchema, refreshSchema } from './dto.js';

/**
 * The controller path and each handler path together form the key that
 * `routes.ts` declares a policy against — see route-key.ts. Changing a path
 * here without changing it there makes the route undeclared, and an undeclared
 * route is denied, so the mistake surfaces as a failing test rather than as an
 * unguarded endpoint.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  /**
   * 200 rather than 201: this creates a session, but the response body is a
   * token pair rather than a representation of a created resource, and no
   * Location header would make sense.
   */
  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginRateLimitGuard)
  async login(@Body() body: unknown): Promise<TokenPair> {
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      // The validation detail is safe to return — it describes the request
      // shape, which the caller already knows — but the credentials inside it
      // are not, so only the field paths are echoed.
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    return this.auth.login(parsed.data);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Body() body: unknown): Promise<TokenPair> {
    const parsed = refreshSchema.safeParse(body);
    if (!parsed.success) {
      // Deliberately the same error a bad token produces. A caller learning
      // that their token was well-formed but rejected, versus malformed, is a
      // distinction worth nothing to them and something to an attacker.
      throw new UnauthorizedException({ error: 'invalid_grant' });
    }
    return this.auth.refresh(parsed.data.refresh_token);
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    // The guard has already run and rejected anything without valid claims, so
    // this is a programming error rather than an untrusted input path.
    const claims = request.auth;
    if (claims === undefined) throw new Error('logout reached without verified claims');
    await this.auth.logout(claims.sid);
  }

  @Get('session')
  async session(@Req() request: AuthenticatedRequest): Promise<SessionSummary> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('session reached without verified claims');
    return this.auth.describeSession(claims);
  }
}
