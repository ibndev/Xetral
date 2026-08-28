import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { splitInclusiveTax } from '@xetral/shared';
import type { Currency, Money } from '@xetral/shared';
import { SettingsService } from '../settings/settings.service.js';

/**
 * Tax we collect on somebody else's behalf, and the postings that hold it.
 *
 * TAX IS A LIABILITY. Money collected for the FIRS is money owed to the FIRS,
 * so it lands in `liability_tax_payable` and never in `revenue_fees`. Booking
 * it as revenue overstates what the business earned and understates what it
 * owes, and both errors point the same way — the flattering one.
 *
 * NOTHING HERE IS TAX ADVICE. The rate, the levy and its threshold are
 * settings an operator reviews, for the same reason `risk_thresholds` are: a
 * platform running on a figure somebody copied from a migration is running on
 * a figure nobody reviewed.
 */
export interface FeeSplit<C extends Currency> {
  /** What the customer pays. Unchanged by turning VAT on, when fees are
   *  inclusive — which is the default, because a tax setting must not quietly
   *  become a pricing decision. */
  readonly gross: Money<C>;
  /** Ours. */
  readonly net: Money<C>;
  /** Not ours. Zero when the rate is zero, and the caller then posts no tax
   *  leg at all — a zero-amount posting is refused by the ledger. */
  readonly tax: Money<C>;
}

@Injectable()
export class TaxService {
  constructor(@Inject(SettingsService) private readonly settings: SettingsService) {}

  /**
   * Splits a fee into what we keep and what we owe.
   *
   * INCLUSIVE by default: the fee is what the customer pays and part of it is
   * VAT. Turning VAT on then changes the BOOKS and not the price, which is the
   * only version of this change that is safe to ship without a pricing
   * decision behind it.
   *
   * Exclusive mode adds VAT on top, raising every fee. It exists because some
   * businesses quote net prices, and it is a deliberate choice rather than a
   * default for exactly that reason.
   */
  async splitFee<C extends Currency>(fee: Money<C>): Promise<FeeSplit<C>> {
    const basisPoints = await this.settings.vatBasisPoints();
    if (basisPoints === 0 || fee.amount <= 0n) {
      return { gross: fee, net: fee, tax: { amount: 0n, currency: fee.currency } };
    }

    if (await this.settings.vatInclusive()) {
      const { net, tax } = splitInclusiveTax(fee, basisPoints);
      return { gross: fee, net, tax };
    }

    // Exclusive: the fee is net and VAT is added, so the customer pays more.
    // Rounded UP toward the revenue authority, the same direction the
    // inclusive split rounds, so neither mode can under-remit.
    const tax = {
      amount: (fee.amount * BigInt(basisPoints) + 9_999n) / 10_000n,
      currency: fee.currency,
    };
    return {
      gross: { amount: fee.amount + tax.amount, currency: fee.currency },
      net: fee,
      tax,
    };
  }

  /**
   * The flat levy on a qualifying transfer, or zero.
   *
   * OFF BY DEFAULT, and that is the important part. Whether the Electronic
   * Money Transfer Levy applies to a wallet like this one, at what threshold,
   * and borne by whom, is a question for a Nigerian tax adviser. Turning it on
   * CHANGES WHAT CUSTOMERS ARE CHARGED, so it is an act somebody takes having
   * read advice.
   *
   * NAIRA ONLY. The levy is published in kobo and is a statement about naira;
   * applying a kobo figure to dollars because both are integers is the same
   * mistake as adding kobo to cents.
   */
  async levyOn<C extends Currency>(amount: Money<C>): Promise<Money<C>> {
    const zero = { amount: 0n, currency: amount.currency };
    if (amount.currency !== 'NGN') return zero;
    if (!(await this.settings.transferLevyEnabled())) return zero;

    const threshold = await this.settings.transferLevyThresholdKobo();
    if (amount.amount < threshold) return zero;

    return { amount: await this.settings.transferLevyKobo(), currency: amount.currency };
  }

  /**
   * Records what was collected, against the entry that moved it.
   *
   * ON THE ENTRY'S OWN TRANSACTION, so a collection cannot exist without its
   * posting and a posting cannot exist without its record. Apart, the two
   * drift — and `tax_remittance_drift` exists because that drift is otherwise
   * discovered while filing a return.
   *
   * `ON CONFLICT DO NOTHING`, because a retried transfer is a replay at the
   * ledger and must be one here.
   */
  async record(
    client: PoolClient,
    input: {
      readonly kind: 'vat' | 'transfer_levy';
      readonly entryId: string;
      readonly userId: string;
      readonly amount: Money<Currency>;
      readonly baseMinor: bigint;
      readonly rateApplied: string;
      readonly occurredAt: Date;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO tax_collections
         (kind, entry_id, user_id, amount_minor, currency, base_minor, rate_applied,
          occurred_at)
       VALUES ($1::tax_kind, $2::bigint, $3::bigint, $4::bigint, $5, $6::bigint, $7, $8)
       ON CONFLICT (entry_id, kind) DO NOTHING`,
      [
        input.kind,
        input.entryId,
        input.userId,
        input.amount.amount.toString(),
        input.amount.currency,
        input.baseMinor.toString(),
        input.rateApplied,
        input.occurredAt,
      ],
    );
  }
}
