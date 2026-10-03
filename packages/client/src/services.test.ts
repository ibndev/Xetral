import { describe, expect, it } from 'vitest';
import {
  hiddenCurrencies,
  isHidden,
  isPaused,
  pausedMode,
  readServiceStates,
  screenGate,
  serviceForPath,
  visibleCurrencies,
} from './services.js';
import type { ServiceStates } from './services.js';
import { convertPreset } from './catalogues.js';

const all: ServiceStates = { crypto: 'enabled', fx: 'enabled', cards: 'enabled', bills: 'enabled', payouts: 'enabled' };
const off: ServiceStates = {
  crypto: 'coming_soon',
  fx: 'coming_soon',
  cards: 'coming_soon',
  bills: 'coming_soon',
  payouts: 'coming_soon',
};

describe('serviceForPath', () => {
  it('maps a gated screen, its sub-paths and its query to one switch', () => {
    expect(serviceForPath('/cards')).toBe('cards');
    expect(serviceForPath('/cards/123')).toBe('cards');
    expect(serviceForPath('/fx?from=NGN&to=USD')).toBe('fx');
    expect(serviceForPath('/esim')).toBe('bills');
  });

  it('covers nothing it has no switch for', () => {
    expect(serviceForPath('/wallet')).toBeUndefined();
    expect(serviceForPath('/transfer')).toBeUndefined();
    expect(serviceForPath('/')).toBeUndefined();
  });
});

describe('readServiceStates', () => {
  it('reads the three states the API sends', () => {
    expect(
      readServiceStates({
        services: { crypto: false, fx: true, cards: true, bills: false, payouts: true },
        states: { crypto: 'hidden', fx: 'enabled', cards: 'enabled', bills: 'coming_soon', payouts: 'enabled' },
      }),
    ).toEqual({ crypto: 'hidden', fx: 'enabled', cards: 'enabled', bills: 'coming_soon', payouts: 'enabled' });
  });

  it('reads an API older than 093 — off there was only ever Coming soon', () => {
    expect(readServiceStates({ services: { crypto: false, fx: true, cards: true, bills: true, payouts: true } }).crypto).toBe(
      'coming_soon',
    );
  });

  it('never reads an unrecognised state as enabled', () => {
    expect(
      readServiceStates({ services: { crypto: false }, states: { crypto: 'Hidden' } }).crypto,
    ).toBe('coming_soon');
  });
});

describe('isPaused', () => {
  it('is paused only when the service is known to be Coming soon', () => {
    expect(isPaused({ ...all, cards: 'coming_soon' }, '/cards')).toBe(true);
    expect(isPaused(all, '/cards')).toBe(false);
  });

  it('a HIDDEN service is not "paused" — it is not there', () => {
    expect(isPaused({ ...all, crypto: 'hidden' }, '/crypto')).toBe(false);
    expect(isHidden({ ...all, crypto: 'hidden' }, '/crypto')).toBe(true);
  });

  it('treats an unknown state as NOT paused and NOT hidden — the refusal is the control', () => {
    expect(isPaused(undefined, '/cards')).toBe(false);
    expect(isHidden(undefined, '/crypto')).toBe(false);
  });
});

describe('pausedMode', () => {
  it('keeps a screen where something is HELD, and replaces one where nothing is', () => {
    expect(pausedMode(off, '/cards')).toBe('notice');
    expect(pausedMode(off, '/crypto')).toBe('notice');
    expect(pausedMode(off, '/bills')).toBe('replace');
    expect(pausedMode(off, '/esim')).toBe('replace');
    expect(pausedMode(off, '/fx')).toBe('replace');
    expect(pausedMode(all, '/cards')).toBeUndefined();
  });
});

describe('screenGate', () => {
  it('waits on EVERY gated screen until the answer is in, so a hidden one never flashes', () => {
    expect(screenGate(undefined, false, '/crypto')).toBe('wait');
    expect(screenGate(undefined, false, '/bills')).toBe('wait');
    expect(screenGate(undefined, false, '/wallet')).toBeUndefined();
  });

  it('says hidden for a hidden service, and Coming soon exactly as before', () => {
    expect(screenGate({ ...all, crypto: 'hidden' }, true, '/crypto')).toBe('hidden');
    expect(screenGate(off, true, '/crypto')).toBe('notice');
    expect(screenGate(off, true, '/fx')).toBe('replace');
    expect(screenGate(all, true, '/crypto')).toBeUndefined();
  });

  it('a failed read settles to "not hidden, not paused"', () => {
    expect(screenGate(undefined, true, '/crypto')).toBeUndefined();
  });
});

describe('hidden currencies', () => {
  it('a hidden crypto takes BTC, USDT and USDC with it', () => {
    const states = { ...all, crypto: 'hidden' } as const;
    expect([...hiddenCurrencies(states)].sort()).toEqual(['BTC', 'USDC', 'USDT']);
    expect(visibleCurrencies(states, ['NGN', 'USD', 'USDT', 'USDC', 'BTC'])).toEqual(['NGN', 'USD']);
  });

  it('Coming soon takes nothing — the wallets stay, as they always have', () => {
    expect(hiddenCurrencies({ ...all, crypto: 'coming_soon' }).size).toBe(0);
    expect(hiddenCurrencies(undefined).size).toBe(0);
  });

  it('a Convert link naming a hidden currency opens on the default pair', () => {
    expect(convertPreset('NGN', 'USDT', hiddenCurrencies({ ...all, crypto: 'hidden' }))).toEqual({ from: 'NGN', to: 'USD' });
    expect(convertPreset('NGN', 'USDT')).toEqual({ from: 'NGN', to: 'USDT' });
  });
});
