import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE } from '../tokens.js';

/**
 * Which products need a verified identity, in ONE list.
 *
 * WHAT CHANGED AND WHY. Identity used to be collected at sign-up: register,
 * then straight to a form asking for a full legal name, a date of birth and a
 * BVN. That is the most sensitive identifier a Nigerian fintech holds, and it
 * was being asked for before the customer had seen a single screen of the
 * product or had any reason to trust us with it. Most people close the tab,
 * and the ones who do not have handed over a BVN to look at an empty wallet.
 *
 * So opening an account now takes an email and a password, and identity is
 * asked for at the FIRST MOMENT IT IS ACTUALLY REQUIRED — which is a real
 * moment, not a policy we invented:
 *
 *   USD cards        Bitnob issues cards to ITS identified customers. There
 *                    is no card without a `provider_customers` row.
 *   Crypto           Same mapping, same provider requirement, plus the
 *                    travel-rule obligations that come with on-chain value.
 *   Gift cards       We pay out cash against a bearer instrument we cannot
 *                    verify at the moment we pay. Of everything here this is
 *                    the one where an anonymous counterparty is the whole
 *                    fraud model.
 *   NGN account      A Nigerian bank account cannot be issued to an
 *                    unidentified person. This is law, not product design.
 *
 * And what deliberately does NOT need it: opening an account, holding naira,
 * receiving a transfer from another Xetral customer, sending one, buying
 * airtime, data, or paying a bill. A customer can use most of the product on
 * the day they sign up.
 *
 * The list is here rather than inline at each call site because "which
 * products need KYC" is a compliance question with one answer, and four
 * copies of it drift — the version that drifts being the one nobody reads
 * until an auditor asks.
 */
export const KYC_GATED = {
  card: 'a USD card',
  crypto: 'crypto',
  giftcard: 'gift card trading',
  ngn_account: 'a Nigerian account number',
} as const;

export type KycGatedProduct = keyof typeof KYC_GATED;

@Injectable()
export class KycGateService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}

  /**
   * Refuses unless the customer has a provider identity.
   *
   * `provider_customers` is the gate rather than `kyc_submissions.status`,
   * and the difference matters: the row is created by an approving reviewer
   * inside the same transaction that marks the submission approved. Reading
   * the submission instead would let a customer whose approval failed halfway
   * look verified to us and be refused by every provider-backed route — which
   * is the exact state the pre-deployment audit found every customer stuck
   * in, and it is much harder to diagnose than a plain refusal.
   */
  async assertVerified(userId: string, product: KycGatedProduct): Promise<void> {
    const row = await this.pool.query<{ provider_customer_id: string }>(
      `SELECT provider_customer_id FROM provider_customers
        WHERE user_id = $1::bigint AND provider = 'bitnob'`,
      [userId],
    );

    if (row.rows[0] !== undefined) return;

    // `product` tells the client WHAT the customer was reaching for, so the
    // screen can say "verify your identity to get a USD card" rather than a
    // bare "kyc required" that gives them no reason to bother.
    throw new ConflictException({
      error: 'kyc_required',
      product,
      detail: `Identity verification is required for ${KYC_GATED[product]}.`,
    });
  }

  /** The same question without throwing, for the session payload. */
  async isVerified(userId: string): Promise<boolean> {
    const row = await this.pool.query(
      `SELECT 1 FROM provider_customers WHERE user_id = $1::bigint AND provider = 'bitnob'`,
      [userId],
    );
    return row.rowCount !== null && row.rowCount > 0;
  }
}
