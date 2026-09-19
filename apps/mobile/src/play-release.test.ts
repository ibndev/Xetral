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

const APK_WORKFLOW = readFileSync(
  new URL('../../../.github/workflows/mobile-apk.yml', import.meta.url),
  'utf8',
);
const AAB_WORKFLOW = readFileSync(
  new URL('../../../.github/workflows/mobile-aab.yml', import.meta.url),
  'utf8',
);
const PERMISSION_SCRIPT = 'apps/mobile/scripts/assert-permissions.sh';

describe('both workflows check the manifest the same way', () => {
  /*
   * ONE ASSERTION, TWO WORKFLOWS, AND THE SECOND COPY IS WHY THIS TEST EXISTS.
   *
   * `mobile-apk.yml` had the permission check written out inline and
   * `mobile-aab.yml` grew a hand-written second version of "the same" thing.
   * It was not the same: it grepped for the permission NAME and treated a hit
   * as a failure — but `blockedPermissions` marks a line `tools:node="remove"`
   * rather than deleting it, so the AAB workflow's FIRST EVER RUN reported all
   * three template permissions as errors against a build that was entirely
   * correct, and no bundle could be uploaded.
   *
   * The same argument the fulfilment port makes about three hand-written
   * contract suites: copies drift into checking different things while both
   * read as green. So the check is a script, and this fails the build on a
   * workflow that stops calling it or starts spelling one out again.
   */
  it('both call the shared script and neither spells the check out again', () => {
    for (const [name, workflow] of [
      ['mobile-apk.yml', APK_WORKFLOW],
      ['mobile-aab.yml', AAB_WORKFLOW],
    ] as const) {
      expect(workflow, `${name} no longer runs ${PERMISSION_SCRIPT}`).toContain(
        PERMISSION_SCRIPT,
      );
      /*
       * A workflow that names a permission in a `run:` block is writing its
       * own copy again. The script is the only place these belong — and the
       * one that got it wrong got it wrong precisely by naming them.
       */
      expect(
        workflow.includes('SYSTEM_ALERT_WINDOW'),
        `${name} names SYSTEM_ALERT_WINDOW itself instead of leaving it to the script`,
      ).toBe(false);
    }
  });

  it('both also check the manifest that becomes the artifact', () => {
    /*
     * THE SOURCE MANIFEST IS SEVEN PERMISSIONS AND THE APK SHIPS THIRTEEN.
     * The other nine are merged in from the native modules' own manifests at
     * build time, so the run before the build is structurally incapable of
     * seeing them — which is how READ_MEDIA_IMAGES came to be on the install
     * screen of an app that opens no picker and no camera.
     *
     * The same shape as the AAB signing check: interrogate what the build
     * produced, not the configuration that produced it. Asserted here because
     * the pre-build run passes on its own and looks like the whole check.
     */
    for (const [name, workflow] of [
      ['mobile-apk.yml', APK_WORKFLOW],
      ['mobile-aab.yml', AAB_WORKFLOW],
    ] as const) {
      expect(
        workflow,
        `${name} checks the source manifest and never the merged one`,
      ).toContain(`${PERMISSION_SCRIPT} --merged`);
    }
  });

  it('the merged run refuses to pass when it cannot find its input', () => {
    // A check that does nothing when its input is missing is the
    // reconciliation check that reported through a SELECT and exited zero.
    // The AGP output path moves between plugin versions, so this is the
    // failure that will actually happen one day.
    const script = readFileSync(
      new URL('../scripts/assert-permissions.sh', import.meta.url),
      'utf8',
    );
    expect(script).toContain('--merged');
    expect(script).toContain('no merged manifest under');
  });

  it('the script refuses a permission that would ship AND one that is blocked', () => {
    // BOTH DIRECTIONS, because the failing one is not the obvious one: a typo
    // in `blockedPermissions` marks something the app NEEDS for removal, the
    // line is still in the file, and a name-only check calls that fine. It
    // presents as "Face ID does not work on Android".
    const script = readFileSync(
      new URL('../scripts/assert-permissions.sh', import.meta.url),
      'utf8',
    );
    expect(script).toContain('tools:node="remove"');
    expect(script).toContain('is blocked, and the app needs it');
    expect(script).toContain('would ship and nothing uses it');
    // Every permission the two directions rest on.
    for (const perm of [
      'SYSTEM_ALERT_WINDOW',
      'READ_EXTERNAL_STORAGE',
      'WRITE_EXTERNAL_STORAGE',
      // Blocked on the strength of a decision rather than of the template:
      // expo-notifications wants it for a picture in a notification and this
      // app sends none.
      'READ_MEDIA_IMAGES',
      'INTERNET',
      'USE_BIOMETRIC',
    ]) {
      expect(script, `the script stopped checking ${perm}`).toContain(perm);
    }
  });
});

describe('what happens to the bundle after it is built', () => {
  const EAS = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')) as {
    submit?: Record<string, { android?: { track?: string; serviceAccountKeyPath?: string } }>;
  };

  it('submits to the INTERNAL track, never straight to production', () => {
    /*
     * `internal` is testers-only and has no review wait, which is what makes
     * automatic upload safe to do on every build. `production` would publish
     * a banking app to the public from a workflow_dispatch — an irreversible
     * outward-facing action taken by a build, which is the one thing a
     * pipeline must never be able to do on its own.
     */
    const android = EAS.submit?.['production']?.android;
    expect(android, 'eas.json has no submit profile').toBeDefined();
    expect(android?.track).toBe('internal');
  });

  it('reads its Play key from a path nothing can commit', () => {
    // It publishes releases of this listing. `.gitignore` covers both the
    // repo-root and apps/mobile spellings, and this fails if the profile is
    // pointed somewhere that is not covered.
    const path = EAS.submit?.['production']?.android?.serviceAccountKeyPath;
    expect(path).toBe('./play-service-account.json');

    const ignored = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
    expect(ignored).toContain('apps/mobile/play-service-account.json');
  });

  it('the AAB workflow submits the artifact IT built', () => {
    /*
     * `--auto-submit` is an `eas build` flag and this bundle is built by
     * GRADLE on the runner — which is what lets the signing key, the
     * permissions and the version code be interrogated here rather than
     * trusted to a remote builder. `eas submit --path` is the same upload
     * against that exact file.
     *
     * `--path` is the load-bearing part: without it EAS resolves one of its
     * own builds and would submit a bundle none of these checks has seen.
     */
    expect(AAB_WORKFLOW).toContain('eas-cli');
    expect(AAB_WORKFLOW).toContain('submit');
    expect(AAB_WORKFLOW, 'submits an EAS build rather than the one built here').toContain(
      '--path',
    );
    expect(AAB_WORKFLOW).toContain('--profile production');
  });

  it('SKIPS rather than failing when the credentials are absent', () => {
    /*
     * A missing secret must not turn a working build pipeline red — 059's
     * rule that a missing answer falls through rather than becoming an
     * outage. The other half is that it has to SAY so: the failure that
     * matters here is somebody believing a bundle was submitted when it was
     * not, which is why the skip writes a warning and a summary line.
     */
    expect(AAB_WORKFLOW).toContain('NOT SUBMITTED');
    expect(AAB_WORKFLOW).toContain('Not submitted to Play');
  });
});

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
