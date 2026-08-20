/**
 * Ledger failures, named for what actually happened.
 *
 * Every one of these is a rejection the DATABASE made, translated. That
 * direction matters: the service does not pre-check a balance and then write,
 * because between the check and the write another request can spend the same
 * money. It writes, lets the constraint decide, and turns the resulting error
 * into something a caller can act on.
 */
export abstract class LedgerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A customer account would have gone negative.
 *
 * Deliberately carries no balance figure. Returning "you have ₦4,300" to a
 * caller that asked to send ₦5,000 turns a transfer endpoint into a balance
 * oracle for anyone holding a stolen session — and the customer can read their
 * own balance from the endpoint that exists for it.
 */
export class InsufficientFundsError extends LedgerError {}

/** An account role named no account, and creating it was not permitted here. */
export class UnknownAccountError extends LedgerError {}

/** The entry did not balance, or broke another structural rule. */
export class InvalidEntryError extends LedgerError {}
