/**
 * The refusal messages, from the one place they live.
 *
 * They were written out here and again in `apps/mobile/src/errors.ts`, and the
 * two had drifted by twenty-five codes. `@xetral/client` owns the list now —
 * both apps already depend on it, and a screen that reads a sentence from a
 * package cannot be the reason the other platform says something else.
 *
 * Re-exported rather than having every call site change its import: the module
 * boundary is right, and moving 40 imports to prove it would be churn.
 */
export { codeOf, messageFor } from '@xetral/client';
