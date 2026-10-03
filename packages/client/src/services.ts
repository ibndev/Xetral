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
import { CRYPTO_ASSETS } from './catalogues.js';

export type ServiceName = 'crypto' | 'fx' | 'cards' | 'bills' | 'payouts';

/**
 * WHAT A SERVICE LOOKS LIKE, in three states (093).
 *
 * `coming_soon` is what "off" always meant: still offered, marked, and its
 * screen says so. `hidden` is the product not existing here at all — off
 * every list, every rail, every picker, and a link to it lands on the home
 * screen. The server refuses a hidden service's routes either way; this is
 * what keeps the apps from drawing a door that leads nowhere.
 */
export type ServiceState = 'enabled' | 'coming_soon' | 'hidden';

export type ServiceStates = Readonly<Record<ServiceName, ServiceState>>;

const NAMES: readonly ServiceName[] = ['crypto', 'fx', 'cards', 'bills', 'payouts'];

/**
 * The API's answer, read into three states.
 *
 * `states` is new with 093; an API older than that sends only the booleans,
 * and off there can only have meant Coming soon. Anything unrecognised in
 * `states` reads as Coming soon too — never as Enabled, because that would
 * draw a service the server is refusing.
 */
export function readServiceStates(body: {
  readonly services?: Readonly<Partial<Record<string, boolean>>>;
  readonly states?: Readonly<Partial<Record<string, string>>>;
}): ServiceStates {
  const out = {} as Record<ServiceName, ServiceState>;
  for (const name of NAMES) {
    const state = body.states?.[name];
    out[name] =
      state === 'enabled' || state === 'coming_soon' || state === 'hidden'
        ? state
        : body.services?.[name] === false
          ? 'coming_soon'
          : 'enabled';
  }
  return out;
}

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
 * Whether a route is PAUSED — Coming soon. Unknown — still loading, or the
 * read failed — is NOT paused: the refusal on the request is the control, and
 * a failed courtesy read must not hide a working service.
 */
export function isPaused(states: ServiceStates | undefined, path: string): boolean {
  const service = serviceForPath(path);
  return service !== undefined && states !== undefined && states[service] === 'coming_soon';
}

/** Whether a route belongs to a HIDDEN service. Unknown is not hidden. */
export function isHidden(states: ServiceStates | undefined, path: string): boolean {
  const service = serviceForPath(path);
  return service !== undefined && states !== undefined && states[service] === 'hidden';
}

/** Whether a service is hidden. Unknown is not hidden. */
export function serviceHidden(states: ServiceStates | undefined, service: ServiceName): boolean {
  return states !== undefined && states[service] === 'hidden';
}

/**
 * The currencies a hidden service takes with it — crypto's assets, so a
 * hidden crypto leaves no Bitcoin card, USDT tab or USDC option behind. The
 * server drops them from what it returns and refuses them on every request;
 * this is the same rule for the lists the apps hold themselves.
 */
export function hiddenCurrencies(states: ServiceStates | undefined): ReadonlySet<string> {
  return new Set(serviceHidden(states, 'crypto') ? CRYPTO_ASSETS : []);
}

/** A list of currency codes without the ones a hidden service took. */
export function visibleCurrencies<T extends string>(
  states: ServiceStates | undefined,
  codes: readonly T[],
): readonly T[] {
  const hidden = hiddenCurrencies(states);
  return codes.filter((c) => !hidden.has(c));
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

/**
 * WHAT A SCREEN SHOWS WHILE THE SWITCHES ARE STILL BEING READ.
 *
 * A screen a pause would REPLACE (bills, eSIM, Convert) drew its whole form
 * first and swapped it for "Coming soon" a moment later, when the read came
 * back — the customer saw the service, then saw it taken away. So until the
 * read has SETTLED such a screen shows nothing (`wait`). Settled includes a
 * failed read, which still means "not paused": a courtesy read must not hide
 * a working service for longer than it takes to fail.
 *
 * EVERY GATED SCREEN WAITS NOW, the notice screens too, because any of them
 * may be HIDDEN (093) — and a crypto screen drawn for a moment before being
 * taken away is the flash of a product the platform does not offer. Once a
 * visit has an answer nothing waits again.
 *
 * `hidden` is not a way of drawing the screen; the caller sends the customer
 * home rather than drawing anything at all.
 */
export function screenGate(
  states: ServiceStates | undefined,
  settled: boolean,
  path: string,
): 'replace' | 'notice' | 'wait' | 'hidden' | undefined {
  const service = serviceForPath(path);
  if (service === undefined) return undefined;
  if (!settled) return 'wait';
  if (isHidden(states, path)) return 'hidden';
  return pausedMode(states, path);
}
