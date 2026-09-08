const { withAppBuildGradle } = require('@expo/config-plugins');

/**
 * SIGNS A RELEASE BUILD WITH AN UPLOAD KEY INSTEAD OF EXPO'S DEBUG KEY.
 *
 * WHY THIS EXISTS. Expo's Android template points `buildTypes.release` at
 * `signingConfigs.debug` — a key checked into every Expo project on earth,
 * with the password `android`. That is fine for an APK somebody sideloads to
 * look at a screen, and it is the reason the two existing variants share one
 * key and replace each other on install.
 *
 * IT IS NOT FINE FOR PLAY. Google rejects an artifact signed with the debug
 * key outright; and worse, the FIRST key an app is uploaded with becomes the
 * upload key for the life of the listing. Shipping a debug-signed bundle that
 * somehow got through would mean a key whose private half is public is the one
 * thing allowed to publish updates to a banking app.
 *
 * THE KEYSTORE IS NEVER IN THE REPOSITORY. It arrives as four Gradle
 * properties that CI writes from GitHub secrets, and the whole config is
 * CONDITIONAL on the store file existing — so a developer with no keystore
 * still gets a working debug-signed local build rather than a Gradle error
 * about a file they were never given.
 *
 * `RELEASE_STORE_FILE` and friends are the names React Native's own signing
 * documentation uses. Kept identical so anybody following that page finds what
 * they expect.
 */
const MARKER = '// xetral: release signing';

/** The signing block, inserted before the existing `debug` config. */
const SIGNING = `${MARKER}
        release {
            /*
             * CONDITIONAL, and that is the point. A checkout with no keystore
             * — every developer's machine, and CI for any variant but the Play
             * one — leaves this empty and Gradle falls back to the debug
             * config below, exactly as the template does today. Failing here
             * would break a local build over a file only the release needs.
             */
            if (project.hasProperty('RELEASE_STORE_FILE')) {
                storeFile file(RELEASE_STORE_FILE)
                storePassword RELEASE_STORE_PASSWORD
                keyAlias RELEASE_KEY_ALIAS
                keyPassword RELEASE_KEY_PASSWORD
            }
        }
`;

module.exports = function withReleaseSigning(config) {
  return withAppBuildGradle(config, (mod) => {
    let contents = mod.modResults.contents;

    // Idempotent: `expo prebuild` may run more than once, and a second
    // insertion would produce two `release` configs and a Gradle failure that
    // reads as a corrupt template.
    if (contents.includes(MARKER)) return mod;

    if (!contents.includes('signingConfigs {')) {
      throw new Error(
        'with-release-signing: no signingConfigs block in the generated ' +
          'build.gradle. The Expo template changed shape; this plugin must be ' +
          're-read against it rather than patched blind.',
      );
    }
    contents = contents.replace('signingConfigs {', `signingConfigs {\n${SIGNING}`);

    /*
     * AND THE RELEASE BUILD TYPE HAS TO POINT AT IT. Adding the config and
     * leaving `buildTypes.release` on `signingConfigs.debug` is the failure
     * this plugin is most likely to have: everything looks configured, the
     * build succeeds, and Play rejects the upload — a round trip measured in
     * somebody's afternoon.
     *
     * THE RELEASE BLOCK IS LOCATED, NOT PATTERN-MATCHED. `signingConfig
     * signingConfigs.debug` appears TWICE in the template — once in the debug
     * build type, where it is correct and must stay — so a plain replace would
     * either change the wrong one or, with a regex anchored on whatever
     * happens to follow it, break the day the template gains a line. It
     * gained one: the release block carries two comment lines above the
     * statement, which is what the first version of this ran into.
     */
    const buildTypes = contents.indexOf('buildTypes {');
    const releaseAt = buildTypes === -1 ? -1 : contents.indexOf('release {', buildTypes);
    const target = releaseAt === -1
      ? -1
      : contents.indexOf('signingConfig signingConfigs.debug', releaseAt);

    if (target === -1) {
      throw new Error(
        'with-release-signing: could not find buildTypes.release\'s signing ' +
          'config in the generated build.gradle. Refusing to emit a bundle ' +
          'that would be signed with the debug key and rejected by Play.',
      );
    }

    contents =
      contents.slice(0, target) +
      "signingConfig project.hasProperty('RELEASE_STORE_FILE') " +
      '? signingConfigs.release : signingConfigs.debug' +
      contents.slice(target + 'signingConfig signingConfigs.debug'.length);

    mod.modResults.contents = contents;
    return mod;
  });
};
