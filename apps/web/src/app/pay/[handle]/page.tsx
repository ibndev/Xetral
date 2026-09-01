import { redirect } from 'next/navigation';

/**
 * WHERE A PAYMENT LINK LANDS, and until now nowhere.
 *
 * `ProfileService` builds `${appBaseUrl}/pay/${handle}`, the settings screen
 * shows it with a Copy button, and both apps invite the customer to share it —
 * and this route did not exist, so every one of those links answered 404. The
 * generating half and the receiving half were written in different rounds and
 * nothing compared them: a string built in the API cannot be checked by the
 * compiler against a directory in a Next app. `payment-link.test.ts` is what
 * compares them now.
 *
 * IT RESOLVES NOTHING ITSELF, and that is the security decision. Showing the
 * payee's name here would need a PUBLIC endpoint that turns a handle into a
 * person — an enumeration surface reachable by anybody, on a platform where
 * `payable_handles` exists precisely to keep a resolver from leaking contact
 * details. Instead the handle is handed to the transfer screen, where the
 * customer is signed in and the existing authenticated resolution already
 * answers "no such recipient" identically for an unknown handle and an unknown
 * address.
 *
 * A REDIRECT RATHER THAN A PAGE, because there is nothing to say that the
 * transfer screen does not say better. An interstitial reading "you are about
 * to pay somebody" before a form that asks the same question is a step that
 * exists only to be clicked through.
 */
export default async function PayLink({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle } = await params;

  /*
   * The handle is passed on as text and NOT validated here.
   *
   * A rejection at this layer would have to answer differently for a
   * well-formed handle nobody holds and a malformed one — which is the
   * distinction that tells somebody which handles exist. The transfer screen
   * gives one answer to both. `encodeURIComponent` because this value came
   * from a URL somebody else wrote.
   */
  redirect(`/transfer?to=${encodeURIComponent(`@${handle}`)}`);
}
