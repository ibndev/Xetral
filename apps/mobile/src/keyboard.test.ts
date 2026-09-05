import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE KEYBOARD MUST NOT COVER THE FIELD BEING TYPED IN.
 *
 * Reported as "when you're typing inside a textfield the keypad covers it",
 * and it is the kind of fault that comes back: nothing about it is visible in
 * a diff, no test would fail, and the compiler has no opinion at all. It is
 * also invisible on a simulator with a hardware keyboard attached, which is
 * how it survives a look.
 *
 * TWO THINGS ARE ASSERTED, and both are the SHAPE of the fix rather than its
 * effect — an effect needs a device, and this repo's mobile app has never run
 * on one. What can be checked here is that the handling exists in the one
 * place that covers every screen, and that no screen with its own scroll
 * region has been left without it.
 */

const SRC = new URL('.', import.meta.url).pathname;
const APP = join(SRC, '..', 'app');

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

describe('the keyboard and the field under it', () => {
  it('Shell handles it once, for every screen inside it', () => {
    // Here rather than on each screen, for the reason the entrance animation
    // is: a fix a screen has to remember to apply is a fix some screen will
    // not have.
    const shell = read(join(SRC, 'shell.tsx'));
    expect(shell.includes('KeyboardAvoidingView'), 'Shell no longer avoids the keyboard').toBe(
      true,
    );
    // The ScrollView must be INSIDE it. Outside, the frame never shortens and
    // the component does nothing at all.
    const opened = shell.indexOf('<KeyboardAvoidingView');
    const scroll = shell.indexOf('<ScrollView');
    expect(opened).toBeGreaterThan(-1);
    expect(scroll).toBeGreaterThan(opened);
  });

  it('every screen that brings its own scroll region avoids the keyboard too', () => {
    /*
     * The three auth screens are OUTSIDE `Shell` — they have no tab bar and no
     * header — so they carry their own. This is the direction that goes wrong:
     * a fourth screen added outside the shell would have no keyboard handling
     * and nothing would say so.
     */
    const strays: string[] = [];
    for (const name of readdirSync(APP)) {
      if (!name.endsWith('.tsx')) continue;
      const source = read(join(APP, name));
      const ownScroll = source.includes('<ScrollView');
      const shelled = source.includes('<Shell');
      if (!ownScroll || shelled) continue;
      if (!source.includes('KeyboardAvoidingView')) strays.push(name);
    }
    expect(
      strays,
      `screens with their own scroll region and no keyboard handling:\n  ${strays.join('\n  ')}`,
    ).toEqual([]);
  });

  it('Android gets a behaviour, not undefined', () => {
    /*
     * THIS IS THE BUG THAT WAS REPORTED. `behavior={... ? 'padding' : undefined}`
     * relies entirely on the window being resized by `adjustResize` — and
     * under the edge-to-edge Android 15 enforces, the platform draws behind
     * the keyboard and leaves the app to handle the inset. So on Android the
     * keyboard sat over the field.
     *
     * `height` is safe under BOTH, because `KeyboardAvoidingView` measures the
     * OVERLAP between its frame and the keyboard: where the window has already
     * been resized there is no overlap and it adds nothing.
     */
    const files = [
      join(SRC, 'shell.tsx'),
      ...readdirSync(APP)
        .filter((n) => n.endsWith('.tsx'))
        .map((n) => join(APP, n)),
    ];

    const undefinedOnAndroid = files.filter((file) =>
      /behavior=\{[^}]*:\s*undefined\s*\}/.test(read(file)),
    );
    expect(
      undefinedOnAndroid.map((f) => f.slice(SRC.length)),
      'a KeyboardAvoidingView that does nothing on Android',
    ).toEqual([]);
  });
});
