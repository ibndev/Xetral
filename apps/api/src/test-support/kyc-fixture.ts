import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';

/**
 * WHAT KYC APPROVAL ACTUALLY WRITES, for a fixture that stands in for it.
 *
 * THE RULE THIS EXISTS FOR. `KycService.approve()` writes THREE things in ONE
 * transaction: an approved `kyc_submissions` row, the `provider_customers`
 * mapping, and `users.kyc_tier`. Every e2e suite that needed a verified
 * customer wrote the second, most wrote the third after a round of debugging,
 * and NONE wrote the first — because until cards took the name from it,
 * nothing read it.
 *
 * A fixture performing part of an atomic operation describes a state
 * production cannot reach, and the failure it produces reads as a bug in the
 * code under test. That has now cost two rounds: once when a customer whom
 * every provider accepted had an unverified account's ceiling, and once when
 * issuing a card refused `kyc_required` for a customer holding a provider
 * mapping. This is the one place it is written down.
 *
 * IT IS NOT A SHORTCUT PAST THE DATABASE'S RULES. The submission goes in with
 * a real reviewer (who cannot be the customer — there is a CHECK), a sealed
 * BVN shaped like an envelope, and a UNIQUE fingerprint, because 025 refuses
 * two approved submissions that share one. The fingerprint is derived from the
 * customer's own id so two fixtures in one database cannot collide.
 */
export async function approveKyc(
  pool: Pool,
  userId: string,
  options: { readonly fullName?: string; readonly tier?: number } = {},
): Promise<void> {
  // A reviewer who is NOT the customer. `kyc_nobody_reviews_their_own` is a
  // CHECK, so a fixture reusing the customer's own id is refused — correctly,
  // and confusingly if it happens inside somebody else's test.
  const reviewer = await pool.query<{ id: string }>(
    `INSERT INTO users (email, status) VALUES ($1, 'active') RETURNING id`,
    [`reviewer-${randomUUID()}@example.ng`],
  );

  const fingerprint = `v1:${createHash('sha256').update(`fixture:${userId}`).digest('hex')}`;

  await pool.query(
    `INSERT INTO kyc_submissions
       (user_id, full_name, date_of_birth, phone, bvn_sealed, bvn_last4,
        bvn_fingerprint, address, status, reviewed_by, reviewed_at)
     VALUES ($1::bigint, $2, '1990-01-01', '+2348031234567',
             'v1:fixture-sealed-bvn', '1234', $3, '1 Test Street, Lagos',
             'approved', $4::bigint, now())`,
    [userId, options.fullName ?? 'Ada Obi', fingerprint, reviewer.rows[0]?.id],
  );

  await pool.query(
    `INSERT INTO provider_customers (user_id, provider, provider_customer_id)
     VALUES ($1::bigint, 'bitnob', $2)
     ON CONFLICT (user_id, provider) DO NOTHING`,
    [userId, `cus_${randomUUID()}`],
  );

  // AND THE TIER. Approval sets it in the same transaction, and a fixture that
  // skips it describes a customer whom every provider accepts and whose daily
  // ceiling is an unverified account's — the limit in force being the LOWER of
  // the tier's and the flow's.
  await pool.query(`UPDATE users SET kyc_tier = $2 WHERE id = $1::bigint`, [
    userId,
    options.tier ?? 1,
  ]);
}
