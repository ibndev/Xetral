import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Verifying an inbound Kora event.
 *
 * THE SCHEME, FROM THE WEBHOOKS GUIDE (read 3 October 2026), VERBATIM: "Valid
 * requests are sent with a header x-korapay-signature which is essentially an
 * HMAC SHA256 signature of ONLY the data object in response payload signed
 * using your secret key." Their reference implementation is
 * `createHmac('sha256', secretKey).update(JSON.stringify(req.body.data)).digest('hex')`.
 *
 * ONLY THE `data` OBJECT IS SIGNED, NOT THE BODY. So the `event` name beside
 * it is NOT covered: a request carrying a genuine `data` under a different
 * `event` verifies. Nothing here acts on the event name to move money —
 * every outcome is re-read from Kora by reference before a posting exists,
 * which is the rule 058 applies to a checkout and the one this rail needs
 * for its own reason.
 *
 * IT SIGNS `JSON.stringify` OF THE PARSED OBJECT, not the bytes on the wire,
 * and that is their scheme rather than our choice: the guide's Node, PHP and
 * Java samples all re-serialise. This file does the same, on the object the
 * body parsed to, and compares in constant time — the secret is the account's
 * API key, and a timing oracle on it is a way to learn it.
 */
export function verifyKoraWebhook(options: {
  readonly header: string | undefined;
  readonly payload: unknown;
  readonly secretKey: string | undefined;
}): boolean {
  const { header, payload, secretKey } = options;
  /*
   * NO KEY CONFIGURED MEANS REFUSE, never accept. Treating an unset secret
   * as "verification off" is an endpoint that credits wallets on anybody's
   * say-so, on the one deployment where somebody forgot a box.
   */
  if (secretKey === undefined || secretKey === '') return false;
  if (header === undefined || header === '') return false;
  if (typeof payload !== 'object' || payload === null) return false;
  const data = (payload as { data?: unknown }).data;
  if (data === undefined) return false;

  const expected = createHmac('sha256', secretKey).update(JSON.stringify(data)).digest('hex');
  const a = Buffer.from(header.trim().toLowerCase(), 'utf8');
  const b = Buffer.from(expected, 'utf8');
  // `timingSafeEqual` throws on unequal lengths; the same answer as a wrong
  // value is the one that leaks nothing.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * The slice of an event this platform reads — WHICH payment it is about, and
 * nothing that decides money. Amounts, status and currency are read back
 * from Kora; a schema that parsed them here would be one somebody trusted.
 */
const koraEvent = z.object({
  event: z.string().optional(),
  data: z
    .object({
      reference: z.string().optional(),
      payment_reference: z.string().optional(),
      status: z.string().optional(),
      /** `account_number.creation` carries the account's reference here. */
      account_reference: z.string().optional(),
      virtual_bank_account_details: z
        .object({
          virtual_bank_account: z
            .object({ account_reference: z.string().optional() })
            .partial()
            .optional(),
        })
        .partial()
        .optional(),
    })
    .optional(),
});

export interface KoraEvent {
  /** `charge.success`, `charge.failed`, `transfer.success`, `transfer.failed`,
   *  `refund.*`, `account_number.creation` (Webhooks and KES VBA guides). */
  readonly kind: string;
  /**
   * The transaction's reference. OURS on a checkout and a payout — we sent
   * it — and KORA'S (`KPY-PAY-…`) on a deposit into a virtual account, where
   * nobody on our side started the payment.
   */
  readonly reference: string | undefined;
  readonly status: string | undefined;
  /**
   * The reference a VIRTUAL ACCOUNT was opened under — ours — when the event
   * is a deposit into one. It decides only whether to ASK: the deposit is
   * then re-read by `reference` and credited on Kora's answer.
   */
  readonly accountReference: string | undefined;
}

export function parseKoraEvent(payload: unknown): KoraEvent | undefined {
  const parsed = koraEvent.safeParse(payload);
  if (!parsed.success) return undefined;
  const data = parsed.data.data;
  return {
    kind: parsed.data.event ?? '',
    reference: data?.reference ?? data?.payment_reference,
    status: data?.status,
    accountReference:
      data?.virtual_bank_account_details?.virtual_bank_account?.account_reference ??
      data?.account_reference,
  };
}
