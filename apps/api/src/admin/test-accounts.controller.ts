import { BadRequestException, Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { AuthenticatedRequest } from '../auth/auth.guard.js';
import { AuditService } from './audit.service.js';
import { TestAccountService, type TestAccountReset } from './test-account.service.js';

/**
 * An email OR a phone — exactly one — and the PIN the guard reads.
 *
 * `.strict()`, so nothing else rides along: which account is reset is decided
 * by the whitelist and the identifier, never by an id a caller supplies.
 */
const resetSchema = z
  .object({
    email: z.string().trim().min(3).max(320).optional(),
    phone: z.string().trim().min(8).max(20).optional(),
    transaction_pin: z.string().optional(),
  })
  .strict()
  .refine((b) => (b.email === undefined) !== (b.phone === undefined), {
    message: 'give an email or a phone, not both',
    path: ['email'],
  });

/**
 * `POST /v1/admin/test-accounts/reset` — `admin`, a PIN and the elevation
 * window, declared in `routes.ts`. It is the one reset path, it reaches only
 * accounts named in `TEST_ACCOUNT_EMAILS` / `TEST_ACCOUNT_PHONES` (403
 * otherwise), and every call is recorded three times: 091's own row, the
 * append-only audit log, and a log line.
 */
@Controller('v1/admin/test-accounts')
export class TestAccountsController {
  constructor(
    @Inject(TestAccountService) private readonly accounts: TestAccountService,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post('reset')
  @HttpCode(200)
  async reset(@Req() request: AuthenticatedRequest, @Body() body: unknown): Promise<TestAccountReset> {
    const parsed = resetSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        error: 'invalid_request',
        fields: parsed.error.issues.map((i) => i.path.join('.')),
      });
    }
    const actor = request.auth?.sub;
    if (actor === undefined) throw new Error('admin route reached without verified claims');

    const identifier = parsed.data.email ?? parsed.data.phone ?? '';
    const outcome = await this.accounts.reset(identifier, actor);

    const header = request.headers['x-forwarded-for'];
    const ip = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim();
    await this.audit.record({
      actorId: actor,
      action: 'test_account.reset',
      subjectType: 'user',
      subjectId: identifier,
      detail: {
        by: parsed.data.email !== undefined ? 'email' : 'phone',
        account_numbers_deactivated: outcome.account_numbers_deactivated,
        account_numbers_left_live: outcome.account_numbers_left_live,
      },
      // Destructive, so 091's CHECK requires a reason. The outcome IS the
      // reason, as it is for `data.erase`: what went.
      reason: `test account reset: ${outcome.removed}`,
      ...(ip === undefined || ip === '' ? {} : { ip }),
    });
    return outcome;
  }
}
