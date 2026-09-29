import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * iOS IS BUILT IN EXPO'S CLOUD, BECAUSE THERE IS NO MAC.
 *
 * Every binary that runs on a physical iPhone is signed by an Apple Developer
 * account, and signing plus compiling needs macOS — which this project only
 * reaches through EAS Build. So the whole iOS release path is `eas.json`, and a
 * profile that quietly built for the SIMULATOR would succeed in the cloud and
 * produce a file the owner has no machine to open.
 */
type Profile = {
  extends?: string;
  distribution?: string;
  developmentClient?: boolean;
  ios?: { simulator?: boolean };
};

const EAS = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')) as {
  build: Record<string, Profile>;
};
const APP = JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')) as {
  expo: {
    ios?: { bundleIdentifier?: string; infoPlist?: Record<string, string> };
    android?: { package?: string };
  };
};
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  scripts: Record<string, string>;
};

/** A profile with its `extends` chain applied, the way EAS reads it. */
function resolved(name: string): Profile {
  const own = EAS.build[name];
  if (own === undefined) throw new Error(`eas.json has no "${name}" profile`);
  const parent = own.extends === undefined ? {} : resolved(own.extends);
  return { ...parent, ...own, ios: { ...parent.ios, ...own.ios } };
}

describe('the iOS build profiles', () => {
  it('ios-internal is an INTERNAL build for a real iPhone', () => {
    /*
     * `internal` is ad hoc provisioning: installed from a link onto phones
     * registered with `eas device:create`, no TestFlight and no review. A
     * simulator build here would be a file only a Mac can run.
     */
    const profile = resolved('ios-internal');
    expect(profile.distribution).toBe('internal');
    expect(profile.ios?.simulator).toBe(false);
    // Standalone: the JavaScript is inside, so a tester needs no laptop.
    expect(profile.developmentClient).not.toBe(true);
  });

  it('device is the development build that replaces Expo Go on an iPhone', () => {
    const profile = resolved('device');
    expect(profile.distribution).toBe('internal');
    expect(profile.developmentClient).toBe(true);
    expect(profile.ios?.simulator).toBe(false);
  });

  it('production goes to the STORE, for a device', () => {
    // Anything but `store` is a binary App Store Connect refuses to accept.
    const profile = resolved('production');
    expect(profile.distribution ?? 'store').toBe('store');
    expect(profile.ios?.simulator).not.toBe(true);
    expect(profile.developmentClient).not.toBe(true);
  });
});

describe('what App Review reads', () => {
  it('has a bundle identifier of the listing shape', () => {
    /*
     * Like Play's application id, this is the listing for its life — so the
     * SHAPE is asserted and not the value (`play-release.test.ts`' reason).
     * It matches Android's so one name identifies one product in both stores.
     */
    const id = APP.expo.ios?.bundleIdentifier;
    expect(id).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/);
    expect(id).toBe(APP.expo.android?.package);
  });

  it('says why it uses Face ID', () => {
    // iOS terminates an app that asks for Face ID without this string, and
    // review rejects one whose purpose is not stated.
    expect(APP.expo.ios?.infoPlist?.['NSFaceIDUsageDescription']).toBeTruthy();
  });
});

describe('the scripts', () => {
  it('start:go targets Expo Go, not the development build', () => {
    /*
     * With `expo-dev-client` a direct dependency, a bare `expo start` serves a
     * DEVELOPMENT BUILD — so the script called start:go was sending an iPhone
     * running Expo Go a QR code for an app it does not have. `--go` is what
     * makes the name true.
     */
    expect(PKG.scripts['start:go']).toContain('--go');
    expect(PKG.scripts['start']).toContain('--dev-client');
  });

  it('builds and submits iOS from the cloud', () => {
    expect(PKG.scripts['build:ios:internal']).toContain('--profile ios-internal');
    expect(PKG.scripts['build:ios']).toContain('--profile production');
    expect(PKG.scripts['build:ios']).toContain('--platform ios');
  });
});
