import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * What only the wiring can get wrong about push notifications.
 *
 * NONE OF THIS NEEDS A DEVICE, and all of it has a failure mode the compiler
 * cannot see. A native module missing from `plugins` is what killed `expo
 * prebuild` when `expo-screen-capture` was listed there and had never shipped
 * one; a version that does not match the SDK is a build that fails forty
 * minutes in; and a token minted against no EAS project is stored, looks
 * valid, and never delivers anything.
 */
const HERE = new URL('.', import.meta.url).pathname;
const app = JSON.parse(readFileSync(`${HERE}/../app.json`, 'utf8')) as {
  expo: { plugins: unknown[]; extra?: Record<string, unknown> };
};
const pkg = JSON.parse(readFileSync(`${HERE}/../package.json`, 'utf8')) as {
  dependencies: Record<string, string>;
};
const source = readFileSync(`${HERE}/push.ts`, 'utf8');

describe('push notifications are wired the way a build needs', () => {
  it('declares expo-notifications as a config plugin', () => {
    // The opposite of the `expo-screen-capture` failure: that package was
    // listed under `plugins` and ships none, so `expo config` — and therefore
    // `expo prebuild` — died. This one does ship one, and leaving it out means
    // the Android channel and the iOS entitlement are never configured.
    expect(app.expo.plugins).toContain('expo-notifications');
  });

  it('pins expo-notifications to the range SDK 54 bundles', () => {
    // `npm install expo-notifications` resolved 57.x, which is for a later
    // SDK. Expo's own `bundledNativeModules.json` says ~0.32.x for SDK 54, and
    // a mismatched native module is a failure at build time rather than here.
    expect(pkg.dependencies['expo-notifications']).toMatch(/^~0\.32\./);
  });

  it('REFUSES to mint a token with no EAS projectId rather than guessing', () => {
    // Since SDK 49 a token is minted against a specific EAS project. A wrong
    // or absent one produces a token that is stored, looks valid and delivers
    // to nothing — silently, which is the worst failure available here.
    expect(source).toMatch(/projectId === undefined/);
    expect(source).toMatch(/eas init/);
  });

  it('creates the Android channel, without which nothing is ever shown', () => {
    // Android 8+ drops a notification with no channel, silently and with no
    // error anywhere.
    expect(source).toContain('setNotificationChannelAsync');
  });

  it('swallows every failure, because being reachable is not a precondition', () => {
    // A permission sheet or a failed request must never stop a sign-in. The
    // same argument the provider-health recorder makes about never failing the
    // call it records.
    expect(source).toMatch(/catch/);
    expect(source).not.toMatch(/throw new/);
  });

  it('retires the handset on sign-out', () => {
    const settings = readFileSync(`${HERE}/../app/settings.tsx`, 'utf8');
    // For the reason the stored PIN is forgotten: a phone somebody hands over
    // must not go on showing the previous account's notifications on its lock
    // screen.
    expect(settings).toContain('unregisterFromPush');
  });

  it('registers it after sign-in and after sign-up, not during either form', () => {
    for (const screen of ['signin', 'signup']) {
      const text = readFileSync(`${HERE}/../app/${screen}.tsx`, 'utf8');
      expect(text).toContain('registerForPush');
    }
  });
});
