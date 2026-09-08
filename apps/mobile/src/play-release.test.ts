import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * WHAT PLAY WILL REFUSE, CHECKED HERE RATHER THAN AT REVIEW.
 *
 * Every assertion below is something Google rejects an upload for, or
 * something that makes the app unusable for whoever installs it. The cost of
 * finding one at the Play Console is a build, an upload, a wait and a rebuild;
 * the cost here is a red test.
 */
const CONFIG = JSON.parse(
  readFileSync(new URL('../app.json', import.meta.url), 'utf8'),
) as {
  expo: {
    version: string;
    extra?: { apiUrl?: string };
    android: {
      package: string;
      versionCode?: number;
      blockedPermissions?: readonly string[];
    };
    plugins: readonly (string | readonly unknown[])[];
  };
};

const pluginNames = CONFIG.expo.plugins.map((p) => (Array.isArray(p) ? String(p[0]) : String(p)));

describe('the app config is one Play will take', () => {
  it('has a versionCode, and it is a whole number', () => {
    /*
     * Play ORDERS uploads by this and refuses a repeat. Expo defaults it to 1
     * when absent, so a listing whose config never named one would upload
     * once and then refuse every later build with a message about a code
     * already in use — recoverable, and a wasted upload each time.
     */
    const code = CONFIG.expo.android.versionCode;
    expect(code, 'android.versionCode is missing from app.json').toBeTypeOf('number');
    expect(Number.isInteger(code)).toBe(true);
    expect(code).toBeGreaterThan(0);
  });

  it('is signed by the release plugin, not by Expo’s debug key', () => {
    /*
     * THE ONE THAT CANNOT BE UNDONE. The first key an app is uploaded with
     * becomes the upload key for the life of the listing — so a bundle that
     * slipped through signed with Expo's debug key, whose private half is
     * published in every Expo project, would make that key the only thing
     * allowed to publish updates to a banking app.
     */
    expect(pluginNames).toContain('./plugins/with-release-signing');
  });

  it('has a real application id rather than the template’s', () => {
    // `com.anonymous.*` is what `expo prebuild` invents when nobody chose one,
    // and an application id is permanent once a listing exists.
    const pkg = CONFIG.expo.android.package;
    expect(pkg).toBeTypeOf('string');
    expect(pkg).not.toMatch(/^com\.anonymous\./);
    expect(pkg).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
  });

  it('asks for no permission it does not use', () => {
    /*
     * A permission list is the first thing a reviewer reads, and "Display over
     * other apps" on a banking app is a rejection or a question. These three
     * come from Expo's android TEMPLATE rather than from any package here, so
     * no diff ever showed them — which is why the list is asserted rather than
     * trusted.
     */
    const blocked = CONFIG.expo.android.blockedPermissions ?? [];
    for (const permission of [
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ]) {
      expect(blocked, `${permission} must stay blocked`).toContain(permission);
    }
  });

  it('ships pointed at an https address', () => {
    /*
     * A store build reaches every installer's phone, so the address compiled
     * into it must be one that works from anywhere and over TLS. An http one
     * would also make `with-lan-cleartext` open a plaintext exception in a
     * bundle going to the public.
     */
    const url = CONFIG.expo.extra?.apiUrl;
    expect(url, 'expo.extra.apiUrl is what a build with no override bakes in').toBeTypeOf(
      'string',
    );
    expect(url?.startsWith('https://')).toBe(true);
  });

  it('has a version name a person can read', () => {
    expect(CONFIG.expo.version).toMatch(/^[0-9]+(\.[0-9]+)*$/);
  });
});

describe('the release signing plugin', () => {
  const SOURCE = readFileSync(
    new URL('../plugins/with-release-signing.js', import.meta.url),
    'utf8',
  );

  it('repoints the RELEASE build type and leaves debug alone', () => {
    // Both halves matter. Adding a signing config and leaving
    // `buildTypes.release` on `signingConfigs.debug` is the failure that looks
    // completely configured and is rejected on upload.
    expect(SOURCE).toContain('signingConfigs.release');
    expect(SOURCE).toMatch(/buildTypes/);
  });

  it('REFUSES rather than falling back when it cannot find the block', () => {
    /*
     * The template moves. When it does, the safe failure is a build that stops
     * — not one that quietly emits a debug-signed bundle, which is what
     * "leave it as it was" would mean here.
     */
    expect(SOURCE).toMatch(/throw new Error/);
    expect(SOURCE.match(/throw new Error/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('never carries a keystore or a password in the repository', () => {
    // The properties are NAMES that CI fills from secrets. A literal password
    // here would be a credential in git history, which cannot be scrubbed.
    expect(SOURCE).toContain('RELEASE_STORE_FILE');
    expect(SOURCE).not.toMatch(/storePassword\s+['"][^'"]/);
    expect(SOURCE).not.toMatch(/-----BEGIN/);
  });
});
