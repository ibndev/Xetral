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
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { AuthenticatedRequest } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { PinService } from './pin.service.js';
import { setPinSchema } from '../wallet/dto.js';
import type { SessionSummary, TokenPair } from './auth.service.js';
import { LoginRateLimitGuard, PasswordResetRateLimitGuard } from './login-rate-limit.guard.js';
import { countryFrom } from './sign-in-events.service.js';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  refreshSchema,
  resetPasswordSchema,
  totpCodeSchema,
} from './dto.js';
import { PasswordResetService } from './password-reset.service.js';
import { StaffTotpService } from './staff-totp.service.js';
import { ProfileService } from './profile.service.js';
import type { ProfileView } from './profile.service.js';
import type { TotpEnrolment } from './staff-totp.service.js';
import { AccountSecurityService } from './account-security.service.js';
import type { DeviceView } from './account-security.service.js';

/**
 * The controller path and each handler path together form the key that
 * `routes.ts` declares a policy against — see route-key.ts. Changing a path
 * here without changing it there makes the route undeclared, and an undeclared
 * route is denied, so the mistake surfaces as a failing test rather than as an
 * unguarded endpoint.
 */
@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PinService) private readonly pins: PinService,
    @Inject(AccountSecurityService) private readonly security: AccountSecurityService,
    @Inject(PasswordResetService) private readonly resets: PasswordResetService,
    @Inject(StaffTotpService) private readonly totp: StaffTotpService,
    @Inject(ProfileService) private readonly profile: ProfileService,
  ) {}

  /**
   * 200 rather than 201: this creates a session, but the response body is a
   * token pair rather than a representation of a created resource, and no
   * Location header would make sense.
   */
  /**
   * Opens an account.
   *
   * Public, and rate limited by the same guard as login — a registration
   * endpoint with no limit is a way to fill the users table and to probe which
   * addresses are taken, at whatever speed the attacker's connection allows.
   */
  @Post('register')
  @HttpCode(201)
  @UseGuards(LoginRateLimitGuard)
  async register(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<TokenPair> {
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    // Describes the consent this creates, and decides nothing. The signup form
    // shows the terms and the privacy notice above the button; without these
    // two fields, "they agreed" would be a claim with nothing behind it.
    return this.auth.register(parsed.data, {
      ip: request.ip,
      userAgent: request.headers['user-agent'],
    });
  }

  @Post('login')
  @HttpCode(200)
  @UseGuards(LoginRateLimitGuard)
  async login(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<TokenPair> {
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
    // Both fields describe the sign-in and neither decides it. `request.ip`
    // resolves the forwarded chain against TRUST_PROXY_HOPS; the country comes
    // from the edge's own header and is discarded unless it looks like one.
    return this.auth.login(parsed.data, {
      ip: request.ip,
      country: countryFrom(request.headers),
      platform: parsed.data.device.platform,
    });
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

  /**
   * Sets a transaction PIN, or changes one.
   *
   * Declares `pin: false` even though it is about the PIN: requiring the PIN to
   * set the first PIN would be circular. Changing one DOES require the current
   * value, enforced in the service, because otherwise a stolen session could
   * replace the very factor meant to stop it.
   */
  @Post('pin')
  @HttpCode(204)
  async setPin(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<void> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('setPin reached without verified claims');

    const parsed = setPinSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.pins.set(claims.sub, parsed.data.pin, parsed.data.current_pin);
  }

  /**
   * Confirms a transaction PIN and does nothing else.
   *
   * The handler is empty on purpose: `AuthGuard` verifies the PIN because this
   * route declares `pin: true`, so reaching the body at all IS the answer.
   * Nothing here re-implements the check, and nothing bypasses the five-attempt
   * lockout that protects every other money-moving route.
   *
   * It exists for biometric enrolment on mobile. The phone stores the PIN
   * behind the OS's biometric gate, and it must not store a WRONG one — the
   * alternative is discovering the mistake on a real transfer, which spends one
   * of the customer's five attempts on a request they did not intend to make.
   */
  @Post('pin/verify')
  @HttpCode(204)
  async verifyPin(@Req() request: AuthenticatedRequest): Promise<void> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('verifyPin reached without verified claims');
  }

  @Get('session')
  async session(@Req() request: AuthenticatedRequest): Promise<SessionSummary> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('session reached without verified claims');
    return this.auth.describeSession(claims);
  }

  /**
   * Every device that has held a session on this account.
   *
   * Deliberately readable without a PIN. This is the screen where a customer
   * FINDS OUT they have been compromised, and putting a PIN in front of
   * looking would mean the one control that requires noticing is behind the
   * factor they may be about to discover has been used.
   */
  @Get('devices')
  async devices(@Req() request: AuthenticatedRequest): Promise<readonly DeviceView[]> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('devices reached without verified claims');
    return this.security.devices(claims.sub, claims.did);
  }

  /**
   * Signs one device out, and every session on it.
   *
   * Takes the PIN. The endpoint is reachable with a stolen access token, so
   * without it a thief could evict the real owner using the session they took
   * — turning a recovery control into an attack.
   */
  @Post('devices/:id/revoke')
  @HttpCode(204)
  async revokeDevice(
    @Req() request: AuthenticatedRequest,
    @Param('id') deviceId: string,
  ): Promise<void> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('revokeDevice reached without verified claims');
    await this.security.revokeDevice(claims.sub, deviceId, 'customer request');
  }

  /** Signs out everywhere except here. See the service for why not here too. */
  @Post('devices/revoke-others')
  async revokeOtherDevices(
    @Req() request: AuthenticatedRequest,
  ): Promise<{ signed_out_devices: number }> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('revokeOthers reached without verified claims');
    return { signed_out_devices: await this.security.revokeOtherDevices(claims.sub, claims.did) };
  }

  /**
   * Changes the password and signs every other device out.
   *
   * The revocation is the point rather than a courtesy: a password change that
   * leaves the attacker's session live changes nothing about their access —
   * they are already past the password — while telling the customer they have
   * fixed it, so they stop looking.
   */
  @Post('password')
  async changePassword(
    @Req() request: AuthenticatedRequest,
    @Body() body: unknown,
  ): Promise<{ signed_out_devices: number }> {
    const claims = request.auth;
    if (claims === undefined) throw new Error('changePassword reached without verified claims');

    const parsed = changePasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }

    return this.security.changePassword(
      claims.sub,
      claims.did,
      parsed.data.current_password,
      parsed.data.new_password,
    );
  }

  /**
   * Ask for a reset link.
   *
   * ALWAYS 204, for any syntactically valid identifier. That is the whole
   * security property of this endpoint: answering 404 for an unknown address
   * and 204 for a known one turns any address list into a customer list.
   *
   * A 204 therefore means "if that address has an account, mail is on its way"
   * and nothing more. It is not a confirmation that anything was sent, and it
   * deliberately cannot be used as one.
   */
  @Post('password/forgot')
  @HttpCode(204)
  @UseGuards(PasswordResetRateLimitGuard)
  async forgotPassword(@Body() body: unknown, @Req() request: AuthenticatedRequest): Promise<void> {
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.resets.request(parsed.data.identifier, request.ip);
  }

  /**
   * Finish a reset.
   *
   * 204 with no body: there is no session here. The customer signs in with the
   * password they just set, which is also what proves the reset worked. Issuing
   * a token pair from this endpoint would mean a leaked reset link grants an
   * immediate live session rather than merely a password that can be used —
   * and every session on the account was just revoked for that same reason.
   */
  @Post('password/reset')
  @HttpCode(204)
  @UseGuards(PasswordResetRateLimitGuard)
  async resetPassword(@Body() body: unknown): Promise<void> {
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.resets.reset(parsed.data.token, parsed.data.new_password);
  }

  /**
   * Begin enrolling a second factor.
   *
   * Authenticated but NOT staff-only, and that is deliberate. A person who has
   * just been granted a role has to be able to enrol before they can use the
   * admin surface — and every staff route now requires an enrolled factor, so
   * gating this one behind `staff()` would be a circular lock nobody could
   * open. Enrolling is harmless for a customer who never becomes staff: it
   * writes a row that nothing consults.
   *
   * The secret is returned ONCE, here, and never again. Re-reading it would
   * turn any stolen session into a way to clone the factor.
   */
  @Post('totp/enrol')
  @HttpCode(200)
  async enrolTotp(@Req() request: AuthenticatedRequest): Promise<TotpEnrolment> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });
    return await this.totp.beginEnrolment(auth.sub, auth.sub);
  }

  /**
   * Prove the authenticator works, and turn the factor on.
   *
   * Until this succeeds the enrolment is inert. Trusting the row at issue time
   * instead would lock out an operator who scanned nothing — and they would
   * find out while trying to open the admin surface during whatever made them
   * need it.
   */
  @Post('totp/confirm')
  @HttpCode(204)
  async confirmTotp(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });

    const parsed = totpCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.totp.confirmEnrolment(auth.sub, auth.sid, parsed.data.totp_code);
  }

  /**
   * Elevate this session for the acting window.
   *
   * The endpoint that was missing, and whose absence made the entire acting
   * staff surface unreachable: enrolment elevated the session it ran on, and
   * after that window nothing could ever elevate one again. See
   * `StaffTotpService.elevate`.
   *
   * `authenticated`, not `staff`: it must be callable by somebody whose
   * session is NOT currently elevated, which is every caller by definition —
   * a staff policy would refuse the one request that exists to fix that. The
   * service still refuses anybody without a confirmed factor, so this grants
   * nothing to a customer.
   *
   * 204: it changes the session, and there is nothing to say back. How long
   * the elevation lasts is the server's business and telling a client would
   * invite it to cache a countdown that the next revocation makes a lie.
   */
  /**
   * The customer's own payment handle and link.
   *
   * A GET that WRITES on its first call, which is worth naming: it mints a
   * handle if there is none. That is idempotent — the second call returns the
   * same one — so it is safe to repeat, and minting at registration instead
   * would put a uniqueness retry inside the one transaction that must not
   * fail.
   */
  @Get('profile')
  async profileMine(@Req() request: AuthenticatedRequest): Promise<ProfileView> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });
    return this.profile.mine(auth.sub);
  }

  @Post('totp/elevate')
  @HttpCode(204)
  async elevateTotp(
    @Body() body: unknown,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    const auth = request.auth;
    if (auth === undefined) throw new UnauthorizedException({ error: 'invalid_token' });

    const parsed = totpCodeSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((issue) => issue.path.join('.')),
      });
    }
    await this.totp.elevate(auth.sub, auth.sid, parsed.data.totp_code);
  }
}
