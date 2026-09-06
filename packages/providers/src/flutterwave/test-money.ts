import { money } from '@xetral/shared';
import type { Money } from '@xetral/shared';

/**
 * Concrete amounts for the payout tests.
 *
 * They exist so the suite holds `Money<'GHS'>` rather than `Money<Currency>`:
 * `Money` is INVARIANT, so a test written against the union would compile
 * against a non-generic `send()` and prove nothing about the trap this
 * codebase has fallen into twice.
 */
export const ghs = (minor: bigint): Money<'GHS'> => money(minor, 'GHS');
export const kes = (minor: bigint): Money<'KES'> => money(minor, 'KES');
export const ngn = (minor: bigint): Money<'NGN'> => money(minor, 'NGN');
