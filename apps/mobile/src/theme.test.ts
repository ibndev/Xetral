import { describe, expect, it, vi } from 'vitest';

/**
 * The dark palette was defined and unreachable, twice over.
 *
 * FIRST: `export const colors = light` was a module-level binding that nothing
 * could swap, so every screen importing it rendered light whatever the phone
 * was set to — while the file carried a full dark palette and a comment
 * claiming a provider swapped them.
 *
 * SECOND: once the hook read the device, the device was the ONLY thing that
 * could decide. The web has carried a sun/moon toggle since it was built, so a
 * customer could choose dark on a laptop and not on the phone — the same
 * account, the same brand, one control that existed in one place.
 *
 * The rule is a pure function now (`schemeFor`), which is what lets this test
 * put every combination through it without a renderer.
 */
vi.mock('react-native', () => ({
  useColorScheme: () => 'light',
  Platform: { select: (o: Record<string, unknown>) => o['default'] ?? {} },
  StyleSheet: { create: <T,>(s: T): T => s },
}));

const { dark, light, paletteFor, schemeFor, stylesFor } = await import('./theme');

describe('which palette is in force', () => {
  it('follows the device when the choice is `system`', () => {
    expect(schemeFor('system', 'dark')).toBe('dark');
    expect(schemeFor('system', 'light')).toBe('light');
  });

  it('lets an explicit choice BEAT the device, in both directions', () => {
    // The whole point of the toggle. A customer on a phone in dark mode who
    // asks this app for light must get light.
    expect(schemeFor('light', 'dark')).toBe('light');
    expect(schemeFor('dark', 'light')).toBe('dark');
  });

  it('falls back to light when the device cannot say', () => {
    // `useColorScheme` returns null before the OS has answered, and on some
    // Android builds it stays null. Neither may render an unreadable screen.
    expect(schemeFor('system', null)).toBe('light');
    expect(schemeFor('system', undefined)).toBe('light');
  });

  it('has every key in both palettes', () => {
    // A screen reading colors.x must not compile against one theme and be
    // undefined under the other — which renders as a transparent colour
    // rather than as an error.
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });
});

describe('the stylesheet', () => {
  it('is built from the palette it is handed, not the one frozen at import', () => {
    // The actual original failure. `StyleSheet.create` freezes whatever
    // colours it was given, so a sheet built once at module load can never
    // follow anything.
    const darkSheet = stylesFor(paletteFor('dark'));
    const lightSheet = stylesFor(paletteFor('light'));

    expect(darkSheet.screen.backgroundColor).toBe(dark.bg);
    expect(lightSheet.screen.backgroundColor).toBe(light.bg);
    expect(darkSheet.screen.backgroundColor).not.toBe(lightSheet.screen.backgroundColor);
  });

  it('hands back the same sheet for the same palette', () => {
    // Rebuilding on every render would allocate a stylesheet per frame and
    // defeat the identity checks React uses to skip work.
    expect(stylesFor(dark)).toBe(stylesFor(dark));
  });
});

describe('the light theme draws no outlines', () => {
  /*
   * The phone's half of the same rule the web's `light-edges.test.ts` keeps.
   *
   * A light container is already a shade DARKER than the ground, which is what
   * the eye reads as a recess; the hairline on top of it was a second cue for
   * one fact, and two cues read as an outline. On black there is no darker fill
   * to recess into, so dark keeps its border — which is why this cannot be
   * done by deleting `borderWidth`.
   *
   * The failure is invisible in review and invisible in dark: a screen written
   * with `colors.line` looks right on the theme most people build in and puts
   * one outlined box among a screen of recessed ones on the other.
   */
  it('makes the container and field edges transparent in light and real in dark', () => {
    expect(light.edge).toBe('transparent');
    expect(light.edgeStrong).toBe('transparent');
    // NOT transparent. A dark container that lost its border would be a shade
    // of near-black on black with nothing marking where it ends.
    expect(dark.edge).toBe(dark.line);
    expect(dark.edgeStrong).toBe(dark.lineStrong);
  });

  it('leaves DIVIDERS alone, in both themes', () => {
    // A divider separates things that would otherwise run together, which is
    // true on white as well as on black. Only the box border changed.
    expect(light.line).not.toBe('transparent');
    expect(light.lineStrong).not.toBe('transparent');
  });

  it('draws the shared card and input from the edge, not from the line', () => {
    const styles = stylesFor(light);
    expect(styles.card.borderColor).toBe('transparent');
    expect(styles.input.borderColor).toBe('transparent');
    // And they still HAVE a border, so dark gets one from the same rule rather
    // than needing a second copy of the component style.
    expect(styles.card.borderWidth).toBe(1);
    expect(styles.input.borderWidth).toBe(1);
    expect(stylesFor(dark).card.borderColor).toBe(dark.line);
    expect(stylesFor(dark).input.borderColor).toBe(dark.lineStrong);
  });
});
