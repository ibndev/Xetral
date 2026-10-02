/**
 * THE ACCOUNT TIERS, AS A CUSTOMER COUNTS THEM — one place for both apps and
 * the admin dashboard.
 *
 * THE DATABASE COUNTS FROM ZERO AND PEOPLE COUNT FROM ONE. `users.kyc_tier`
 * is 0 for an account that has only signed up, 1 once a reviewer approved a
 * BVN, and 2 once an administrator established address and source of funds
 * (029). The owner's words for the same three are Tier 1, Tier 2 and Tier 3,
 * and a screen saying "tier 0" to a customer reads as "no account at all".
 * So the number shown is always the stored one plus one, and nothing here
 * changes what any tier ALLOWS — that is `kyc_tier_limits`, enforced by the
 * ledger precondition.
 */
export interface AccountTier {
  /** As stored in `users.kyc_tier`. */
  readonly tier: number;
  /** As a customer reads it. */
  readonly label: string;
  /** What reaching it takes, in a few words. */
  readonly requirement: string;
}

export const ACCOUNT_TIERS: readonly AccountTier[] = [
  { tier: 0, label: 'Tier 1', requirement: 'Signed up' },
  { tier: 1, label: 'Tier 2', requirement: 'BVN verified' },
  { tier: 2, label: 'Tier 3', requirement: 'Address verified' },
];

/** "Tier 1" for a stored 0, and a sensible label for a tier added later. */
export function tierLabel(storedTier: number): string {
  return ACCOUNT_TIERS.find((t) => t.tier === storedTier)?.label ?? `Tier ${storedTier + 1}`;
}

/**
 * A ceiling as a figure without the pennies: "50,000" rather than
 * "50,000.00". A limit is a round number somebody chose, and two decimal
 * places of zeros make a short line read like a statement.
 */
export function wholeFigure(majorAmount: string): string {
  return majorAmount.replace(/\.0+$/, '');
}
