import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import pg from 'pg';
import type { Pool } from 'pg';
import type {
  CreateVirtualAccountRequest,
  DepositLookup,
  FundingPort,
  NotificationMessage,
  NotificationPort,
  NotificationReceipt,
  ProviderDeposit,
  VirtualAccount,
} from '@xetral/providers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../app.module.js';
import { systemClock } from '../tokens.js';
import { testApiConfig } from '../test-support/api-config.js';
import { enrolAndElevate } from '../test-support/staff-totp.js';

/**
 * RESETTING A TEST ACCOUNT, end to end: the same email and phone register
 * again as a brand-new customer, and nothing outside the whitelist is touched.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (DATABASE_URL === undefined || DATABASE_URL === '') {
  throw new Error('the test-account reset e2e suite needs DATABASE_URL with the migrations applied');
}

const PASSWORD = 'a-long-enough-password';
const PIN = '903184';
const TEST_OTP = '424242';

const national = (): string => String(8000000000 + Math.floor(Math.random() * 999999999));
const TEST_EMAIL = `qa-${randomUUID()}@example.ng`;
const TEST_NATIONAL = national();
const TEST_PHONE = `+234${TEST_NATIONAL}`;
// The operator is whitelisted too, so the database's own staff guard is what
// refuses them — not the list.
const ADMIN_EMAIL = `ops-${randomUUID()}@example.ng`;

class StubMailer implements NotificationPort {
  readonly provider = 'stub';
  readonly sent: NotificationMessage[] = [];
  async send(message: NotificationMessage): Promise<NotificationReceipt> {
    this.sent.push(message);
    return { providerMessageId: `stub_${this.sent.length}` };
  }
}

/** Records every switch-off, which is the half of a reset the rail sees. */
class RecordingFundingPort implements FundingPort {
  readonly provider = 'paystack';
  readonly deactivated: { provider: string; id: string }[] = [];
  async deactivateAt(provider: string, id: string): Promise<boolean> {
    this.deactivated.push({ provider, id });
    return true;
  }
  async createVirtualAccount(_req: CreateVirtualAccountRequest): Promise<VirtualAccount> {
    throw new Error('not used by this suite');
  }
  async getVirtualAccount(_id: string): Promise<VirtualAccount> {
    throw new Error('not used by this suite');
  }
  async listDeposits(_account: DepositLookup): Promise<readonly ProviderDeposit[]> {
    return [];
  }
}

let pool: Pool;
let app: INestApplication;
let mailer: StubMailer;
let funding: RecordingFundingPort;
let adminToken: string;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL, max: 6 });
  mailer = new StubMailer();
  funding = new RecordingFundingPort();
  const mod = await Test.createTestingModule({
    imports: [
      AppModule.forRoot({
        config: testApiConfig(DATABASE_URL as string, {
          signupEmailVerification: true,
          testAccounts: { emails: [TEST_EMAIL, ADMIN_EMAIL], phones: [TEST_PHONE], otp: TEST_OTP },
        }),
        pool,
        clock: systemClock,
        notificationPort: mailer,
        fundingPort: funding,
      }),
    ],
  }).compile();
  app = mod.createNestApplication(new ExpressAdapter());
  await app.init();

  // The operator signs up with the fixed code (they are on the list), then is
  // granted `admin` and a second factor the way every admin suite does it.
  const admin = await register(ADMIN_EMAIL, TEST_OTP, national()).expect(201);
  adminToken = admin.body.access_token as string;
  await request(app.getHttpServer())
    .post('/v1/auth/pin')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ pin: PIN })
    .expect(204);
  const id = (
    await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [ADMIN_EMAIL])
  ).rows[0]?.id as string;
  await pool.query(
    `INSERT INTO staff_roles (user_id, role, granted_by) VALUES ($1, 'admin', $1)`,
    [id],
  );
  await enrolAndElevate(app, pool, adminToken, id);
});

afterAll(async () => {
  await app?.close();
  await pool?.end();
});

function register(email: string, code: string | undefined, phone: string) {
  return request(app.getHttpServer())
    .post('/v1/auth/register')
    .send({
      email,
      password: PASSWORD,
      full_name: 'Adaeze Okonkwo',
      country: 'NG',
      phone,
      ...(code === undefined ? {} : { email_code: code }),
      device: { fingerprint: `fp-${randomUUID()}`, platform: 'web' },
    });
}

const reset = (body: Record<string, string>) =>
  request(app.getHttpServer())
    .post('/v1/admin/test-accounts/reset')
    .set('Authorization', `Bearer ${adminToken}`)
    .send({ ...body, transaction_pin: PIN });

describe('signing up a test account with TEST_OTP', () => {
  it('mails nothing to a whitelisted address and accepts the fixed code', async () => {
    const before = mailer.sent.length;
    const asked = await request(app.getHttpServer())
      .post('/v1/auth/signup/email-code')
      .send({ email: TEST_EMAIL })
      .expect(200);
    expect(asked.body).toMatchObject({ required: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mailer.sent.filter((m) => m.to === TEST_EMAIL)).toHaveLength(0);
    expect(mailer.sent.length).toBe(before);

    await register(TEST_EMAIL, TEST_OTP, TEST_NATIONAL).expect(201);
  });

  it('is worthless on an address the list does not name', async () => {
    const stranger = `customer-${randomUUID()}@example.ng`;
    await request(app.getHttpServer())
      .post('/v1/auth/signup/email-code')
      .send({ email: stranger })
      .expect(200);
    const refused = await register(stranger, TEST_OTP, national()).expect(400);
    expect(refused.body.error).toBe('email_code_invalid');
  });
});

describe('resetting it', () => {
  it('refuses an account the list does not name, with 403', async () => {
    const refused = await reset({ email: `customer-${randomUUID()}@example.ng` }).expect(403);
    expect(refused.body.error).toBe('test_account_not_whitelisted');
  });

  it('refuses a staff account even when it is on the list', async () => {
    const refused = await reset({ email: ADMIN_EMAIL }).expect(409);
    expect(refused.body.error).toBe('test_account_is_staff');
    const still = await pool.query<{ status: string }>(
      `SELECT status FROM users WHERE email = $1`,
      [ADMIN_EMAIL],
    );
    expect(still.rows[0]?.status).toBe('active');
  });

  it('retires the account, switches its number off, logs it, and frees the email and phone', async () => {
    const old = (
      await pool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [TEST_EMAIL])
    ).rows[0]?.id as string;
    const accountId = `p91e2e_${randomUUID().slice(0, 8)}`;
    await pool.query(
      `INSERT INTO virtual_accounts
         (user_id, provider, provider_account_id, account_number, bank_name, account_name, status)
       VALUES ($1::bigint, 'paystack', $2, $3, 'Test Bank', 'XETRAL/ADAEZE O.', 'active')`,
      [old, accountId, String(1_000_000_000 + Math.floor(Math.random() * 8_999_999_999)).slice(0, 10)],
    );
    await pool.query(
      `INSERT INTO kyc_submissions
         (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4, address, bvn_fingerprint)
       VALUES ($1::bigint, 'Adaeze Okonkwo', '1994-03-11', $2, 'v1:x:y:z', '4321', 'Lagos',
               'v1:' || encode(sha256($3::bytea), 'hex'))`,
      [old, TEST_PHONE, `e2e-${accountId}`],
    );

    // By PHONE, the second way in.
    const done = await reset({ phone: TEST_PHONE }).expect(200);
    expect(done.body).toMatchObject({ reset: true, account_numbers_deactivated: 1 });
    expect(String(done.body.removed)).toContain('account number');
    expect(funding.deactivated).toContainEqual({ provider: 'paystack', id: accountId });

    const retired = await pool.query<{ email: string; phone: string | null; status: string }>(
      `SELECT email, phone, status FROM users WHERE id = $1::bigint`,
      [old],
    );
    expect(retired.rows[0]).toMatchObject({ phone: null, status: 'closed' });
    expect(retired.rows[0]?.email).toMatch(/^reset\+.+@invalid$/);

    const logged = await pool.query(
      `SELECT 1 FROM test_account_resets WHERE user_id = $1::bigint AND email = $2`,
      [old, TEST_EMAIL],
    );
    expect(logged.rows).toHaveLength(1);
    const audited = await pool.query<{ reason: string }>(
      `SELECT reason FROM admin_audit_log
        WHERE action = 'test_account.reset' AND subject_id = $1`,
      [TEST_PHONE],
    );
    expect(audited.rows[0]?.reason).toMatch(/^test account reset: /);

    // The same email and phone, registered again as a brand-new customer.
    await register(TEST_EMAIL, TEST_OTP, TEST_NATIONAL).expect(201);
    const fresh = await pool.query<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = $1`,
      [TEST_EMAIL],
    );
    expect(fresh.rows[0]?.id).not.toBe(old);
  });
});
