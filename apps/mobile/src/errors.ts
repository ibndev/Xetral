/**
 * The refusal messages, from the one place they live.
 *
 * This file used to carry its own switch with FIFTEEN of the API's codes in
 * it. The web's had forty. So a customer whose card was declined, whose
 * password was too weak, or who hit a paused flow read "Something went wrong.
 * Please try again." on the phone and a sentence that named the problem on a
 * laptop — the same account, the same refusal, two different products.
 *
 * `@xetral/client` owns the list now. Re-exported so no screen has to change
 * its import to get the fix.
 */
export { codeOf, messageFor } from '@xetral/client';
