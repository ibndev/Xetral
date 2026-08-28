import { describe, expect, it } from 'vitest';
// The plugin is CommonJS because Expo's prebuild requires it from Node; the
// test is ESM because that is what vitest runs. Vite bridges the two.
import plugin from './with-lan-cleartext.js';

const { configFor, cleartextHostFrom } = plugin;

/**
 * THE FILE THIS PLUGIN WRITES IS THE ONE NOBODY REVIEWS.
 *
 * It is generated into `android/`, which is gitignored and rebuilt on every
 * prebuild, so it appears in no diff and no pull request. The only thing that
 * ever reads it is aapt2, three and a half minutes into a Gradle build, on a
 * runner — and when it refused the file, the message was
 * `The string "--" is not permitted within comments`, from a step nobody
 * associates with a config plugin.
 *
 * A plain JS test, next to the plugin it tests, because the plugin is
 * CommonJS that runs under Node rather than TypeScript that runs in the app.
 */

/**
 * Well-formedness, to the extent this can be checked without a parser.
 *
 * Node ships no XML parser and adding one to test eleven lines would be the
 * wrong trade. What is asserted instead is the SPECIFIC rule that broke the
 * build, plus the structural claims a reader would want.
 */
function assertParseable(xml) {
  const comments = [...xml.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  expect(comments.length).toBeGreaterThan(0);
  for (const body of comments) {
    // The rule aapt2 enforced and the plugin had broken.
    expect(body, 'an XML comment may not contain "--"').not.toContain('--');
  }
  // Every tag opened is closed, at the depth this document uses.
  expect(xml).toContain('<network-security-config>');
  expect(xml).toContain('</network-security-config>');
  expect((xml.match(/<domain /g) ?? []).length).toBe(
    (xml.match(/<\/domain>/g) ?? []).length,
  );
}

describe('the generated network security config', () => {
  it('is XML aapt2 will accept', () => {
    assertParseable(configFor(['10.0.2.2', 'localhost', '127.0.0.1']));
  });

  it('stays legal however many hosts it names', () => {
    assertParseable(configFor(['10.0.2.2']));
    assertParseable(configFor(['10.0.2.2', 'localhost', '127.0.0.1', '192.168.1.20']));
  });

  it('permits cleartext to exactly the hosts it was given', () => {
    const xml = configFor(['10.0.2.2', '192.168.1.20']);
    expect(xml).toContain('>10.0.2.2<');
    expect(xml).toContain('>192.168.1.20<');
    // Not a blanket permission. The whole point of the file is that everything
    // NOT listed keeps Android's default, which is that plaintext is refused.
    //
    // Asserted on the BODY, with comments stripped: the note explains why a
    // blanket `usesCleartextTraffic` would be wrong, and the first version of
    // this assertion matched that sentence and failed on prose describing the
    // very thing it was checking for.
    const body = xml.replace(/<!--[\s\S]*?-->/g, '');
    expect(body).not.toContain('usesCleartextTraffic');
    expect((xml.match(/<domain /g) ?? []).length).toBe(2);
  });
});

describe('which host gets an exception', () => {
  it('takes the hostname out of an http URL', () => {
    expect(cleartextHostFrom('http://192.168.1.20:3100')).toBe('192.168.1.20');
  });

  it('gives https NO exception at all', () => {
    // Adding one would weaken a build that did not need weakening.
    expect(cleartextHostFrom('https://api.xetral.com')).toBeUndefined();
  });

  it('gives an unset or unparseable URL no exception either', () => {
    // Not this plugin's error to raise: the app itself refuses to start
    // without a usable URL, and failing prebuild here would report a bad
    // address as a plugin crash.
    expect(cleartextHostFrom(undefined)).toBeUndefined();
    expect(cleartextHostFrom('')).toBeUndefined();
    expect(cleartextHostFrom('not a url')).toBeUndefined();
  });

  it('takes a HOSTNAME, never a subnet', () => {
    // The first version of this plugin listed the private ranges as CIDR
    // blocks, which reads perfectly and does nothing: Android's <domain>
    // element has no notion of a subnet. Recorded here so the shape of the
    // input cannot quietly go back to being a range.
    expect(cleartextHostFrom('http://192.168.0.0/16')).toBe('192.168.0.0');
  });
});
