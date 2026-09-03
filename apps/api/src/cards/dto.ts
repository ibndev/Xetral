import { z } from 'zod';

/** Amounts are major-unit STRINGS for the same reason as transfers: a JSON
 *  number has already settled the precision question, badly. */
/**
 * Buying a card. It carries NO NAME and NO STARTING BALANCE, deliberately.
 *
 * THE NAME IS NOT THE CUSTOMER'S TO TYPE. A card is issued in a person's legal
 * name, which is `kyc_submissions.full_name` — what a reviewer read off a
 * document — and a card cannot be issued at all until that record is approved.
 * A free-text field here was a name-on-card box that could disagree with the
 * identity the card was issued against, on the one screen where the two must
 * match.
 *
 * THE STARTING BALANCE IS A SECOND DECISION. Buying a card and putting money on
 * it are different acts and were asked as one, so somebody who just wanted a
 * card had to name an amount before they had a card to put it on. Funding is
 * `POST /v1/cards/:id/fund`, which already exists and is what the card screen
 * offers the moment the card is there.
 *
 * THE PIN STAYS. Issuing a card MOVES MONEY — the issuance fee — so it is
 * authorised like everything else that does. It is asked for on the confirm
 * step rather than on the form, which is a client concern; the route's
 * requirement is unchanged.
 */
/**
 * The three finishes a card can have.
 *
 * A zod enum AND a database CHECK, and the duplication is deliberate — the
 * two answer different questions. This one refuses a bad request with a field
 * name a client can act on; the CHECK refuses a row however it was written,
 * including from a psql prompt. `card-colours.test.ts` fails the build if
 * they disagree, because a value one accepts and the other refuses is a
 * request that 500s instead of 400s.
 */
export const CARD_COLOURS = ['graphite', 'sapphire', 'emerald'] as const;

export const issueCardSchema = z.object({
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
  /** Optional: a customer who does not choose gets the default finish. */
  colour: z.enum(CARD_COLOURS).optional(),
});

/**
 * What the customer calls this card.
 *
 * NOT `name_on_card`, which is the cardholder's legal name and is not theirs to
 * set. This is a label on their own list — "Subscriptions", "Work travel" —
 * and it exists because a second card is otherwise indistinguishable from the
 * first: every card face reads four digits and the same verified name.
 *
 * `null` clears it, which is how a card goes back to being known by its last
 * four digits. Naming a card moves no money, so it takes no PIN.
 */
export const nameCardSchema = z.object({
  label: z.union([z.string().trim().min(1).max(40), z.null()]),
});

export const fundCardSchema = z.object({
  amount: z.string().trim().min(1).max(32),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

/**
 * Replacing a card whose number the customer no longer trusts.
 *
 * Carries no amount: the replacement is funded back to whatever the old card
 * held, so "replace this card" cannot be misread as "and change the balance".
 */
export const reissueCardSchema = z.object({
  name_on_card: z.string().trim().min(2).max(64),
  transaction_pin: z.string().min(1).max(32),
  idempotency_key: z.string().trim().min(8).max(128),
});

/** Freeze carries no PIN: it is the protective action, and asking a customer
 *  whose card is being used fraudulently to remember a PIN first is hostile.
 *  Unfreeze and terminate DO require one — see routes.ts. */
export const pinOnlySchema = z.object({
  transaction_pin: z.string().min(1).max(32),
});
