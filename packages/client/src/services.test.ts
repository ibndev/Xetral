import { describe, expect, it } from 'vitest';
import { isPaused, pausedMode, serviceForPath } from './services.js';

const all = { crypto: true, fx: true, cards: true, bills: true, payouts: true } as const;

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

describe('isPaused', () => {
  it('is paused only when the switch is known to be off', () => {
    expect(isPaused({ ...all, cards: false }, '/cards')).toBe(true);
    expect(isPaused(all, '/cards')).toBe(false);
  });

  it('treats an unknown state as NOT paused — the refusal is the control', () => {
    expect(isPaused(undefined, '/cards')).toBe(false);
  });
});

describe('pausedMode', () => {
  it('keeps a screen where something is HELD, and replaces one where nothing is', () => {
    const off = { crypto: false, fx: false, cards: false, bills: false, payouts: false } as const;
    expect(pausedMode(off, '/cards')).toBe('notice');
    expect(pausedMode(off, '/crypto')).toBe('notice');
    expect(pausedMode(off, '/bills')).toBe('replace');
    expect(pausedMode(off, '/esim')).toBe('replace');
    expect(pausedMode(off, '/fx')).toBe('replace');
    expect(pausedMode(all, '/cards')).toBeUndefined();
  });
});
