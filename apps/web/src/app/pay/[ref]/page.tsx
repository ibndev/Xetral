import { redirect } from 'next/navigation';

/**
 * WHERE A PAYMENT LINK LANDS, and until it existed, nowhere.
 *
 * `ProfileService` builds `${appBaseUrl}/pay/${digits}`, the Add Money screen
 * shows it with a Copy button and both apps invite the customer to share it —
 * and this route did not exist, so every one of those links answered 404. The
 * generating half and the receiving half were written in different rounds and
 * nothing compared them: a string built in the API cannot be checked by the
 * compiler against a directory in a Next app. `payment-link.test.ts` is what
 * compares them now.
 *
 * THE SEGMENT IS A PHONE NUMBER, and may still be an `@handle` on a link
 * shared before the identifier settled. This route does not care which — it
 * hands the segment to the transfer screen, which asks the server, which reads
 * both.
 *
 * IT RESOLVES NOTHING ITSELF, and that is the security decision. Showing the
 * payee's name here would need a PUBLIC endpoint turning an identifier into a
 * person — an enumeration surface reachable by anybody. Instead the customer
 * is signed in by the time anything is resolved, and the existing
 * authenticated lookup answers "no such recipient" identically for an unknown
 * number and an unknown address.
 *
 * A REDIRECT RATHER THAN A PAGE, because there is nothing to say that the
 * transfer screen does not say better. An interstitial reading "you are about
 * to pay somebody" before a form that asks the same question is a step that
 * exists only to be clicked through.
 */
export default async function PayLink({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = await params;

  /*
   * Passed on as text and NOT validated here.
   *
   * A rejection at this layer would have to answer differently for a
   * well-formed identifier nobody holds and a malformed one — which is the
   * distinction that tells somebody which accounts exist. The transfer screen
   * gives one answer to both.
   *
   * The `+` a number needs is put back here rather than left to the field,
   * because the link deliberately drops it: a plus in a URL is a space to
   * enough software that a link carrying one breaks when it is shared.
   * `encodeURIComponent` because this value came from a URL somebody else
   * wrote.
   */
  const target = /^[0-9]{7,15}$/.test(ref) ? `+${ref}` : ref;
  redirect(`/transfer?to=${encodeURIComponent(target)}`);
}
