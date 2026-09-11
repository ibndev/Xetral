import { describe, expect, it } from 'vitest';
import type { TransactionDetail } from './client.js';
import { receiptText, statusWords } from './receipt.js';

const base: TransactionDetail = {
  id: 'e1',
  kind: 'wallet_withdrawal',
  description: 'bank payout reserved',
  amount: '-5000.00',
  currency: 'NGN',
  occurred_at: '2026-09-08T14:02:17.000Z',
  legs: [{ amount: '-5000.00', currency: 'NGN' }],
  reference: 'e1',
};

describe('what a shared receipt says', () => {
  it('carries the figure, the destination and the reference', () => {
    const text = receiptText({
      ...base,
      payout_state: 'sent',
      beneficiary: 'IDRIS OLAWALE',
      bank_name: 'Wema Bank',
      account_number: '9816959304',
      fee: '25.00',
    });

    expect(text).toContain('Sent');
    expect(text).toContain('₦5,000.00');
    expect(text).toContain('IDRIS OLAWALE');
    expect(text).toContain('Wema Bank');
    expect(text).toContain('₦25.00');
    expect(text).toContain('e1');
  });

  it('NEVER carries a full account number', () => {
    // The last four identifies a destination on every bank statement. A
    // receipt is forwarded, so one carrying the whole number is one that
    // should not be forwarded at all.
    const text = receiptText({
      ...base,
      payout_state: 'sent',
      bank_name: 'Wema Bank',
      account_number: '9816959304',
    });
    expect(text).not.toContain('9816959304');
    expect(text).toContain('••9304');
  });

  it('carries no balance, and no provider sentence', () => {
    const text = receiptText({ ...base, payout_state: 'returned' });
    // A receipt goes to the person who asked to be paid. What is left in the
    // account is nobody's business but the customer's.
    expect(text).not.toMatch(/balance/i);
    expect(text).not.toMatch(/paystack|flutterwave|bitnob/i);
  });

  it('drops a zero fee rather than printing one', () => {
    // "Fee ₦0.00" invites the question of what the fee is for.
    expect(receiptText({ ...base, fee: '0.00' })).not.toMatch(/Fee/);
  });

  it('reads the sign as words, so the figure reads as a figure', () => {
    // A customer forwarding "-5,000.00" to somebody has to explain the minus.
    const text = receiptText(base);
    expect(text).toContain('Sent');
    expect(text).not.toContain('-₦');
  });

  it('says Received for money coming in', () => {
    expect(receiptText({ ...base, amount: '5000.00' })).toContain('Received');
  });
});

describe('what the words say happened', () => {
  it('does NOT call an unanswered payout failed, or sent', () => {
    /*
     * `on_its_way` means nobody has answered for it yet: the money is held and
     * the sweep will ask. Telling a customer it failed would be a claim about
     * money that may already be in somebody's account.
     */
    const words = statusWords({ ...base, payout_state: 'on_its_way' });
    expect(words).toBe('On its way');
    expect(words).not.toMatch(/fail|sent/i);
  });

  it('says the money is BACK when a payout was returned', () => {
    expect(statusWords({ ...base, payout_state: 'returned' })).toMatch(/back in your wallet/);
  });

  it('lets the entry status beat the payout state', () => {
    // A reversed entry is a stronger statement than a payout state, and a
    // customer reading "Sent" on money that came back would be reading the
    // wrong one of two true things.
    expect(
      statusWords({ ...base, payout_state: 'sent', status: 'reversed' }),
    ).toMatch(/Reversed/);
  });
});
