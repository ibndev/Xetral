import { describe, expect, it, vi } from 'vitest';

/**
 * The dark palette was defined and unreachable.
 *
 * `export const colors = light` was a module-level binding that nothing could
 * swap, so every screen importing it rendered light whatever the phone was
 * set to — while the file carried a full dark palette and a comment claiming
 * a provider swapped them. This asserts the two things that were not true:
 * that the hook actually returns the dark palette, and that the stylesheet
 * built from it carries dark colours rather than the ones frozen at import.
 */
const scheme = vi.hoisted(() => ({ value: 'light' as 'light' | 'dark' }));

vi.mock('react-native', () => ({
  useColorScheme: () => scheme.value,
  Platform: { select: (o: Record<string, unknown>) => o['default'] ?? {} },
  StyleSheet: { create: <T,>(s: T): T => s },
}));

const { dark, light, useStyles, useTheme } = await import('./theme');

describe('the mobile palette follows the device', () => {
  it('returns the dark palette when the device asks for dark', () => {
    scheme.value = 'dark';
    expect(useTheme()).toBe(dark);
    scheme.value = 'light';
    expect(useTheme()).toBe(light);
  });

  it('builds a stylesheet from the palette in force, not the one at import', () => {
    // The actual failure. `StyleSheet.create` freezes whatever colours it was
    // handed, so a sheet built once at module load can never follow anything.
    scheme.value = 'dark';
    const darkSheet = useStyles();
    scheme.value = 'light';
    const lightSheet = useStyles();

    expect(darkSheet.screen.backgroundColor).toBe(dark.bg);
    expect(lightSheet.screen.backgroundColor).toBe(light.bg);
    expect(darkSheet.screen.backgroundColor).not.toBe(lightSheet.screen.backgroundColor);
  });

  it('hands back the same sheet for the same palette', () => {
    // Rebuilding on every render would allocate a stylesheet per frame and
    // defeat the identity checks React uses to skip work.
    scheme.value = 'dark';
    expect(useStyles()).toBe(useStyles());
  });

  it('has every key in both palettes', () => {
    // A screen reading colors.x must not compile against one theme and be
    // undefined under the other — which renders as a transparent colour
    // rather than as an error.
    expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  });
});
