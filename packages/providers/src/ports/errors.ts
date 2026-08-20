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
 * The provider replied with something the adapter cannot parse.
 *
 * Not retryable: the same request produces the same unparseable reply. It means
 * the provider changed their contract, and it should page someone rather than
 * spin.
 */
export class ProviderContractError extends ProviderError {
  readonly retryable = false;
}
