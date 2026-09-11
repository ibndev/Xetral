import { z } from 'zod';

/**
 * What the one Send flow accepts.
 *
 * `.strict()` throughout, the rule `payoutSchema` follows: Zod strips unknown
 * keys by default, so without it a field a client believes it is sending is
 * silently ignored and the request succeeds while meaning something else.
 */

/**
 * WHICH RAIL REACHES THEM, and it is derived rather than chosen.
 *
 * The customer is never asked this. They type a number or pick a country and a
 * network; the kind follows from that, and the screen shows a person rather
 * than a plumbing decision. It is on the wire because the SERVER has to know
 * which resolver to use, not because anybody typed it.
 */
export const recipientKind = z.enum(['xetral', 'bank', 'momo']);
export type RecipientKind = z.infer<typeof recipientKind>;

/**
 * A DESTINATION AS THE CUSTOMER TYPES IT, not as the rail wants it.
 *
 * `0553921133`, `+233 55 392 1133` and `233553921133` are one wallet, and the
 * server normalises rather than refusing — a form that rejects the spelling
 * somebody's own phone shows them is a form they abandon. The narrow
 * digits-only shape belongs on the COLUMN, after normalisation.
 */
const typedDestination = z.string().trim().min(6).max(32);

export const resolveRecipientSchema = z
  .object({
    kind: recipientKind,
    /**
     * ISO-3166 alpha-2 — where the money is going.
     *
     * OPTIONAL EVEN FOR `xetral`, AND SUPPLYING IT IS WHAT MAKES A NATIONAL
     * NUMBER WORK. `08031234567` has no country in it, so without one the
     * server can only match a number already carrying its dialling code.
     * Absent, that is exactly what happens; present, the number is normalised
     * through that country's own dial code — never through the SENDER's,
     * which would be wrong for the cross-border payments this screen is for.
     */
    country: z.string().trim().length(2).toUpperCase().optional(),
    /** Bank code or mobile money network. Absent for `xetral`. */
    rail_code: z.string().trim().min(1).max(32).optional(),
    destination: typedDestination,
  })
  .strict();

export type ResolveRecipientBody = z.infer<typeof resolveRecipientSchema>;

export const createRecipientSchema = z
  .object({
    kind: recipientKind,
    country: z.string().trim().length(2).toUpperCase().optional(),
    rail_code: z.string().trim().min(1).max(32).optional(),
    destination: typedDestination,
    /**
     * WHAT THE CUSTOMER CALLS THEM, and it is only used where the rail cannot
     * say. Kenya's M-PESA has no name enquiry, so without this a saved
     * recipient there would be a bare number in a list — which is how somebody
     * pays the wrong person from their own address book.
     *
     * DELIBERATELY ABSENT FROM WHAT IS SHOWN AS CONFIRMED. The server records
     * the rail's answer separately and only that one is ever presented as a
     * name the destination holds; this is a label on the customer's own list.
     */
    label: z.string().trim().min(1).max(140).optional(),
  })
  .strict();

export type CreateRecipientBody = z.infer<typeof createRecipientSchema>;
