/**
 * Provider failures, classified by what the caller should DO about them.
 *
 * The classification is the point. "The request failed" is not actionable; the
 * question a money-moving caller has to answer is whether retrying could
 * double-charge somebody. That is why `retryable` is a required property and
 * not a convention — a new error class cannot be added without someone deciding.
 */
export abstract class ProviderError extends Error {
  abstract readonly retryable: boolean;

  constructor(
    readonly provider: string,
    message: string,
    // `override` because Error itself declares `cause` under ES2022. Reusing
    // the standard field rather than inventing a parallel one keeps it visible
    // to anything that already knows how to walk a cause chain.
    override readonly cause?: unknown,
  ) {
    super(`[${provider}] ${message}`);
    this.name = new.target.name;
  }
}

/** The provider could not be reached, or answered 5xx. The request may or may
 *  not have been processed, so a retry needs an idempotency key. */
export class ProviderUnavailableError extends ProviderError {
  readonly retryable = true;
}

/**
 * THE REQUEST NEVER LEFT: no credential to send it with, or a connection that
 * was refused before a byte of the body went out. Unlike its parent this is a
 * statement about what the PROVIDER did — nothing — and it is the only kind
 * of "unavailable" after which a money-moving caller may give the money back.
 *
 * WHY IT IS A SUBCLASS. `ProviderUnavailableError` also covers a 5xx and a
 * connection that dropped after the request was written, and after either of
 * those a transfer may well have been made. A payout that reversed on the
 * parent refunded the customer for money that could already be in the
 * beneficiary's account. Everything that treats both alike — health
 * recording, retries on a read — still sees an `instanceof` match.
 */
export class ProviderNotSentError extends ProviderUnavailableError {}

/**
 * Did a failed `fetch` fail BEFORE the request was written? True only for the
 * connection-level codes that mean no socket was ever established — refused,
 * no such host, a DNS lookup that did not answer. A reset, a hang-up or an
 * unrecognised failure is NOT one of them: those can happen after the body
 * went out, so they stay ambiguous, which is the safe direction.
 */
export function neverConnected(cause: unknown): boolean {
  const codes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
  let current: unknown = cause;
  for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && codes.has(code)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The provider understood the request and refused it: insufficient float, a
 * frozen card, a rejected KYC. Retrying sends the same refusal back.
 */
export class ProviderRejectedError extends ProviderError {
  readonly retryable = false;

  constructor(
    provider: string,
    message: string,
    readonly providerCode: string | undefined,
    cause?: unknown,
  ) {
    super(provider, message, cause);
  }
}

/**
 * The request timed out. Deliberately NOT retryable by default, which is the
 * opposite of the usual instinct.
 *
 * A timeout means we do not know whether the provider acted. For a read that is
 * harmless; for "fund this card" it is the single most dangerous state, because
 * the naive retry is how one funding becomes two. The recovery path is to
 * reconcile — ask the provider what actually happened — not to send it again.
 */
export class ProviderTimeoutError extends ProviderError {
  readonly retryable = false;
}

/**
 * THE PROVIDER ACCEPTED IT AND HAS NOT FINISHED, and that is neither a
 * success nor a failure.
 *
 * Distinct from every other error here, and the distinction is the whole
 * point. A timeout means we do not know whether they acted. Unavailable means
 * we could not ask. A contract error means their API has changed. This one
 * means they answered, in full, to say the work is in progress — which is a
 * NORMAL outcome for an operation somebody designed to be asynchronous.
 *
 * The case that forced it: Paystack assigns a dedicated account number after
 * answering the request that asked for one. Modelled as any of the above, a
 * customer opening an account is told something is broken; modelled as
 * success, the adapter has to invent an account number it was not given.
 * Neither is true, and the caller's correct behaviour — say "in a moment" and
 * look again — is available only if the state has a name.
 *
 * Retryable: asking again is exactly right, and the operation it describes is
 * one the provider is already idempotent about by construction.
 */
export class ProviderPendingError extends ProviderError {
  readonly retryable = true;
}

/**
 * The provider replied with something the adapter cannot parse.
 *
 * Not retryable: the same request produces the same unparseable reply. It means
 * the provider changed their contract, and it should page someone rather than
 * spin.
 */
export class ProviderContractError extends ProviderError {
  readonly retryable = false;
}

/**
 * DID THE PROVIDER CERTAINLY DO NOTHING? The one question a money-moving
 * caller must answer before giving money back.
 *
 * True for a refusal (they understood and said no) and for a request that
 * never left. False for EVERYTHING else — a timeout, a 5xx, a reset, a reply
 * we could not parse, a fault on our side of the port — because after each
 * of those the transfer, the broadcast or the purchase may have happened.
 * Every money path asks this one function rather than listing error classes,
 * so a new class of failure lands on the safe side by default: held and
 * reconciled, never refunded on a guess.
 */
export function providerDidNothing(error: unknown): boolean {
  return error instanceof ProviderRejectedError || error instanceof ProviderNotSentError;
}
