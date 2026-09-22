import { NotFoundException } from '@nestjs/common';
import type { PipeTransform } from '@nestjs/common';

/**
 * A MALFORMED ID ANSWERS AS AN UNKNOWN ONE, not as a broken platform.
 *
 * Every `:id` this API takes in a path is a uuid, and `WHERE uuid = $1`
 * against `'1'` does not return no rows — Postgres raises `invalid input
 * syntax for type uuid`, which reached the customer as "Something went wrong
 * on our side" with a reference number, and paged the error table with a
 * fingerprint for every typo. Forty requests across twenty-seven routes did
 * that before this existed, on the card screen, the device list, the address
 * book and most of the operations surface.
 *
 * It is checked BEFORE the query rather than caught after it: translating a
 * cast error back would mean reading a driver's message to decide what the
 * caller's id was, and a try/catch in one service does nothing for the next.
 *
 * The answer is the route's OWN not-found code, the body a well-formed id for
 * nothing already gets — "no such card" is the true statement, every client
 * already has words for it, and a code invented here would be one none does.
 * A pipe runs before the handler, so this answers before body validation and
 * before a feature flag is read: `/1` with a bad body is a 404 where a real
 * uuid with the same body is a 400. That tells nobody anything — a uuid's
 * shape is public, unlike the payment link's slug, whose malformed and unknown
 * answers must match for exactly that reason.
 *
 * `uuid-param.test.ts` fails the build on an `@Param('id')` that does not go
 * through this, so the next controller cannot forget.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_SHAPE.test(value);
}

/** `@Param('id', uuidOr404('card_not_found'))` */
export function uuidOr404(error: string): PipeTransform<string, string> {
  return {
    transform(value: string): string {
      if (!isUuid(value)) throw new NotFoundException({ error });
      return value;
    },
  };
}
