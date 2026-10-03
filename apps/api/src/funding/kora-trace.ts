import { Logger } from '@nestjs/common';
import { redactPayload } from '@xetral/identity';
import type { KoraTrace, KoraTraceEvent } from '@xetral/providers';

const logger = new Logger('Kora');

/**
 * ONE LINE PER KORA CALL, SAYING WHAT WE SENT AND WHAT THEY ANSWERED.
 *
 * A refused checkout or payout has several plausible causes — a channel the
 * account is not enabled for, a currency, a key from the other environment,
 * a refusal of their own — and `checkout_refusals` records only THAT it was
 * refused. This is what was on the wire, while somebody is looking.
 *
 * `redactPayload` runs over every body, so the payer's email address, a BVN
 * and a wallet's full number are masked while the currency, the channel, the
 * amount, the reference and the bank code — everything a diagnosis turns on —
 * print in full. A log line is copied into tickets, and 006's rule that a
 * provider's sentence names OUR integration is why it goes here rather than
 * to the customer.
 */
export const koraTrace: KoraTrace = (event: KoraTraceEvent) => {
  const where = `${event.method} ${event.path}`;

  if (event.outcome === 'sent') {
    // DEBUG: this fires on every call, healthy ones included.
    logger.debug(`-> ${where} ${render(event.body)}`);
    return;
  }

  if (event.outcome === 'unreachable') {
    logger.warn(`!! ${where} did not answer`);
    return;
  }

  const said = [
    event.httpStatus === undefined ? undefined : `http ${event.httpStatus}`,
    event.message === undefined ? undefined : `"${event.message}"`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  if (event.outcome === 'refused') {
    /* WARN, not ERROR: a refusal is Kora understanding and saying no, and an
     * alert on every declined payer is one people mute (037). */
    logger.warn(`<- ${where} REFUSED ${said} — we sent ${render(event.body)}`);
    return;
  }

  logger.debug(`<- ${where} ok ${said}`);
};

function render(body: unknown): string {
  if (body === undefined) return '(no body)';
  try {
    return JSON.stringify(redactPayload(body));
  } catch {
    return '(unserialisable body)';
  }
}
