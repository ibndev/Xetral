import { Logger } from '@nestjs/common';
import { redactPayload } from '@xetral/identity';
import type { FlutterwaveTrace, FlutterwaveTraceEvent } from '@xetral/providers';

const logger = new Logger('Flutterwave');

/**
 * ONE LINE PER FLUTTERWAVE CALL, SAYING WHAT WE SENT AND WHAT THEY ANSWERED.
 *
 * THE FAILURE THIS EXISTS FOR. A payment link in cedis answered
 * `checkout_unavailable` — "try again shortly" — while the same link in naira
 * was paid without trouble, and there were at least four candidate
 * explanations with nothing to choose between them: a currency field carrying
 * something other than the literal `GHS`, a `payment_options` value the
 * account is not enabled for, a credential that authorises Nigeria only, or
 * Flutterwave refusing for a reason of their own. `checkout_refusals` records
 * THAT a checkout was refused; nothing recorded what it was refused ABOUT.
 *
 * WHAT IT DELIBERATELY DOES NOT PRINT. `redactPayload` runs over every body,
 * so the payer's email address and the beneficiary's full wallet number are
 * masked while the currency, the payment options, the amount, the reference
 * and the bank code — everything a diagnosis actually turns on — are printed
 * in full. A log line is copied into a ticket, a screenshot and a chat
 * thread, and 006's rule that a provider's sentence names OUR integration is
 * the reason it goes here rather than to the customer.
 *
 * AND IT IS NOT A REPLACEMENT FOR `checkout_refusals`. That view answers "why
 * did this customer's link fail" days later, from the database. This answers
 * "what exactly is on the wire" while somebody is looking.
 */
export const flutterwaveTrace: FlutterwaveTrace = (event: FlutterwaveTraceEvent) => {
  const where = `${event.method} ${event.path}`;

  if (event.outcome === 'sent') {
    // DEBUG, because this one fires on every call including the healthy ones.
    // An operator turns the level up while they are looking; a platform that
    // logged every request body at `log` would bury the refusals in the
    // successes, which is 015's rule about alerting applied to a log.
    logger.debug(`-> ${where} ${render(event.body)}`);
    return;
  }

  if (event.outcome === 'unreachable') {
    logger.warn(`!! ${where} did not answer`);
    return;
  }

  const said = [
    event.httpStatus === undefined ? undefined : `http ${event.httpStatus}`,
    event.envelopeStatus === undefined ? undefined : `status=${event.envelopeStatus}`,
    event.message === undefined ? undefined : `"${event.message}"`,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' ');

  if (event.outcome === 'refused') {
    /*
     * WARN AND NOT ERROR. A refusal is Flutterwave understanding and saying
     * no — an unenabled payment option, an amount below their floor, a
     * declined card. 037 draws exactly this line for provider health and it
     * is the same line: an alert that fires every time a payer's card is
     * declined is one people mute.
     */
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
    // A body that will not serialise must not turn a diagnostic into a second
    // failure on top of the one being diagnosed.
    return '(unserialisable body)';
  }
}
