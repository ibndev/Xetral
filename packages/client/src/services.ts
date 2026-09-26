/**
 * WHICH PART OF THE PRODUCT A SCREEN BELONGS TO, for the kill switches.
 *
 * An operator pausing cards during an incident used to stop the REQUEST and
 * nothing else: the tile was still there, the screen still opened, and the
 * customer found out on the last step. With the switch readable
 * (`GET /v1/services`), a paused service reads "Coming soon" wherever it is
 * offered — and both apps decide that from this one table, so they cannot
 * disagree about which screen a switch covers.
 *
 * eSIM is `bills` because the purchase service asserts that one switch for
 * every provider purchase. Send is deliberately absent: a transfer between
 * two Xetral customers leaves nothing, and only its bank payout leg is
 * `payouts`, refused on that request.
 */
export type ServiceName = 'crypto' | 'fx' | 'cards' | 'bills' | 'payouts';

export type ServiceStates = Readonly<Record<ServiceName, boolean>>;

const BY_PATH: Readonly<Record<string, ServiceName>> = {
  '/cards': 'cards',
  '/bills': 'bills',
  '/esim': 'bills',
  '/crypto': 'crypto',
  '/fx': 'fx',
};

/** The switch a route belongs to, or undefined for one no switch covers. */
export function serviceForPath(path: string): ServiceName | undefined {
  const first = `/${path.split('?')[0]?.split('/').filter((p) => p !== '')[0] ?? ''}`;
  return BY_PATH[first];
}

/**
 * Whether a route is PAUSED. Unknown — still loading, or the read failed —
 * is NOT paused: the refusal on the request is the control, and a failed
 * courtesy read must not hide a working service.
 */
export function isPaused(states: ServiceStates | undefined, path: string): boolean {
  const service = serviceForPath(path);
  return service !== undefined && states !== undefined && states[service] === false;
}

/**
 * HOW A PAUSED SCREEN SAYS SO — and the two answers are not a style choice.
 *
 * `replace`: nothing is held there (bills, eSIM, Convert), so the screen
 * shows "Coming soon" and nothing else.
 *
 * `notice`: the customer may HOLD something there. A paused Cards screen
 * must still let somebody freeze a card they are watching charges land on,
 * and a paused Crypto screen must still show what they own — the kill-switch
 * suite asserts both. So the content stays, under a notice saying new
 * activity is paused.
 */
export function pausedMode(
  states: ServiceStates | undefined,
  path: string,
): 'replace' | 'notice' | undefined {
  if (!isPaused(states, path)) return undefined;
  const service = serviceForPath(path);
  return service === 'cards' || service === 'crypto' ? 'notice' : 'replace';
}
