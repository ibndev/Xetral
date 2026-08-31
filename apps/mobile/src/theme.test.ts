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
