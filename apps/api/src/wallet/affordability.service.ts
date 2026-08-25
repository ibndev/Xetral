import { Inject, Injectable } from '@nestjs/common';
import { UnprocessableEntityException } from '@nestjs/common';
import type { Currency, Money } from '@xetral/shared';
import { LedgerService } from '@xetral/ledger';
import { LEDGER } from '../tokens.js';

/**
 * "Can this wallet cover this, before we ask anyone?"
 *
 * READ THIS BEFORE CHANGING IT. CLAUDE.md says never pre-check a balance, and
 * that rule is right and still stands. This is not that check, and the
 * difference is the whole reason the file can exist:
 *
 *  - The rule forbids a pre-check that DECIDES whether a posting is allowed.
 *    Between such a check and the write, another request spends the same
 *    money — so it is a second, weaker copy of the overdraft guard plus a
 *    race. The database is still the only thing that decides here; nothing
 *    below is consulted at write time and removing this file changes no
 *    outcome, only how long the customer waits to hear it.
 *
 *  - What this decides is whether to make an EXTERNAL CALL. A customer with
 *    ₦0 asking to swap ₦50,000 currently reaches Bitnob for a rate before
 *    anyone looks at their balance. That is a round trip, a rate-limit slot
 *    and two seconds of a spinner spent to arrive at an answer we already
 *    held. On a Nigerian mobile connection those two seconds are the
 *    difference between an app that feels broken and one that does not.
 *
 * IT MUST ONLY EVER REFUSE WHAT THE LEDGER WOULD CERTAINLY REFUSE.
 *
 * That is the invariant that keeps it safe, and it is why every caller passes
 * a LOWER BOUND on what the operation will cost rather than the final figure.
 * A crypto withdrawal costs amount + network fee, and the fee is only known
 * after the quote — so the check is made against the amount alone. Fees are
 * never negative, so a wallet that cannot cover the amount cannot cover the
 * total either, and refusing early cannot refuse anything that would have
 * gone through.
 *
 * A stale read is therefore harmless in the one direction that matters. If
 * money lands between this check and the write, the operation proceeds and
 * the guard allows it. If money leaves, the guard refuses it — correctly, and
 * for the same reason it always would have.
 */
@Injectable()
export class AffordabilityService {
  constructor(@Inject(LEDGER) private readonly ledger: LedgerService) {}

  /**
   * Throws `insufficient_funds` if the wallet is already below `atLeast`.
   *
   * Generic over the currency because `Money` is invariant: a bare `Money`
   * parameter means `Money<Currency>` — the union — and `Money<'NGN'>` is not
   * assignable to it, so a non-generic signature compiles and then rejects
   * every real caller.
   */
  async assertWalletCanCover<C extends Currency>(
    ownerId: string,
    atLeast: Money<C>,
  ): Promise<void> {
    if (atLeast.amount <= 0n) return;

    const balance = await this.ledger.balanceOf({
      kind: 'customer_wallet',
      ownerId,
      currency: atLeast.currency,
    });

    // No account yet means no money yet. A customer's first ever action
    // cannot be a withdrawal, and creating the account to find that out would
    // be a write on a read path.
    const available = balance?.balanceMinor ?? 0n;
    if (available >= atLeast.amount) return;

    // NO FIGURE, for the same reason InsufficientFundsError carries none:
    // telling a caller that asked to send ₦5,000 that they have ₦4,300 turns
    // any spending endpoint into a balance oracle for a stolen session.
    throw new UnprocessableEntityException({ error: 'insufficient_funds' });
  }

  /**
   * The same question asked without throwing, for a screen that wants to grey
   * a button out rather than handle an error.
   */
  async walletCanCover<C extends Currency>(
    ownerId: string,
    atLeast: Money<C>,
  ): Promise<boolean> {
    try {
      await this.assertWalletCanCover(ownerId, atLeast);
      return true;
    } catch {
      return false;
    }
  }
}
