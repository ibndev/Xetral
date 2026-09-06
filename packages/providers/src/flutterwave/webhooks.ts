import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifying an inbound Flutterwave event.
 *
 * IT IS NOT A SIGNATURE, and that is the whole reason this file has a header.
 * Paystack HMACs the body with its secret key; Bitnob HMAC-SHA512s it with a
 * webhook secret. Flutterwave does NEITHER: it sends back, verbatim in a
 * `verif-hash` header, the secret string an operator typed into their
 * dashboard. There is nothing to recompute and nothing about the body is
 * covered by it.
 *
 * TWO CONSEQUENCES, both worth stating rather than discovering.
 *
 * The check is an EQUALITY, so writing an HMAC here — the instinct built by
 * the two adapters either side of it — rejects every real event, which reads
 * as a wrong secret. It is compared in constant time anyway: the value is a
 * shared secret and a timing oracle on it is a way to learn it a byte at a
 * time.
 *
 * And because the body is unsigned, A VALID HEADER PROVES THE SENDER AND
 * NOTHING ABOUT WHAT THEY SENT. So nothing here is trusted to move money:
 * every event is re-verified against Flutterwave by our OWN reference before
 * a posting is written, which is the same rule 058 already applies to the
 * Paystack checkout for a different reason. The header decides whether to
 * listen; the verify call decides what is true.
 */
export function verifyFlutterwaveWebhook(options: {
  readonly header: string | undefined;
  readonly secretHash: string | undefined;
}): boolean {
  const { header, secretHash } = options;
  /*
   * NO HASH CONFIGURED MEANS REFUSE, never accept.
   *
   * The alternative — treating an unset secret as "verification off" — is an
   * endpoint that credits wallets on anybody's say-so, on the one deployment
   * where somebody forgot a box. Failing closed costs a support call; failing
   * open costs the float.
   */
  if (secretHash === undefined || secretHash === '') return false;
  if (header === undefined || header === '') return false;

  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(secretHash, 'utf8');
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // length oracle if it escaped. Answering false is the same answer a wrong
  // value of the right length gets.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The slice of an event this platform reads.
 *
 * Deliberately narrow. Everything that decides money — whether it was paid,
 * for how much, in what currency — is read back from `verify` rather than
 * from here, so this needs only enough to know WHICH payment the event is
 * about. A schema that parsed the amount would be a schema somebody later
 * trusted.
 */
const flutterwaveEvent = z.object({
  event: z.string().optional(),
  /** `charge.completed`, `transfer.completed`. */
  'event.type': z.string().optional(),
  data: z
    .object({
      id: z.union([z.number(), z.string()]).optional(),
      tx_ref: z.string().optional(),
      reference: z.string().optional(),
      status: z.string().optional(),
    })
    .optional(),
});

export interface FlutterwaveEvent {
  readonly kind: string;
  /** OUR reference — `tx_ref` on a charge, `reference` on a transfer. */
  readonly reference: string | undefined;
  readonly status: string | undefined;
}

export function parseFlutterwaveEvent(payload: unknown): FlutterwaveEvent | undefined {
  const parsed = flutterwaveEvent.safeParse(payload);
  if (!parsed.success) return undefined;
  const data = parsed.data.data;
  return {
    kind: parsed.data.event ?? parsed.data['event.type'] ?? '',
    /*
     * A CHARGE NAMES IT `tx_ref` AND A TRANSFER NAMES IT `reference`, and
     * both are the string WE minted. Reading only one of them would make
     * half of the events unresolvable — and an unresolvable event is not a
     * loud failure, it is a payment that silently never lands.
     */
    reference: data?.tx_ref ?? data?.reference,
    status: data?.status,
  };
}
