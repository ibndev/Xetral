import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE APK SHIPPED WITH EXPO'S DEFAULT ICON, and `app.json` simply had no
 * `icon` key at all.
 *
 * There is no error for that — Expo's template supplies its own artwork, so
 * `expo prebuild` succeeds, the build succeeds, and the only thing that says
 * anything is the phone's home screen. A banking app wearing a framework's
 * placeholder is the first thing a customer sees and the last thing a test
 * suite looks at.
 *
 * THE MARK IS THE SITE'S OWN FILE, copied rather than redrawn. `apps/web`
 * already serves `icon-512-maskable.png`, and a second hand-made X would be
 * two marks for one brand that drift the first time either is touched — the
 * argument `@xetral/client` makes about the currency flags being DATA drawn
 * by both apps.
 *
 * FULL-BLEED, NOT PRE-ROUNDED. iOS applies its own corner mask and Android's
 * adaptive icon crops to whatever shape the launcher uses, so a square with
 * the mark inset and the ground carried to the edges is the one image both
 * platforms can cut correctly. The site's ROUNDED file would give iOS
 * double-rounded corners with dark wedges in them.
 */
describe('the app has its own icon', () => {
  const root = join(new URL('.', import.meta.url).pathname, '..');
  const config = JSON.parse(readFileSync(join(root, 'app.json'), 'utf8')) as {
    expo: {
      icon?: string;
      android?: { adaptiveIcon?: { foregroundImage?: string; backgroundColor?: string } };
    };
  };

  it('names an icon, and the file is there', () => {
    const icon = config.expo.icon;
    expect(icon, 'expo.icon — without it the APK wears the framework default').toBeDefined();
    expect(existsSync(join(root, icon ?? ''))).toBe(true);
  });

  it('gives Android an adaptive icon on the brand ground', () => {
    const adaptive = config.expo.android?.adaptiveIcon;
    expect(adaptive?.foregroundImage).toBeDefined();
    expect(existsSync(join(root, adaptive?.foregroundImage ?? ''))).toBe(true);
    // The navy the site's own mark sits on — `--brand` in globals.css. A
    // launcher that masks the foreground to a circle shows this behind it, so
    // a wrong value is a coloured ring around the logo.
    expect(adaptive?.backgroundColor).toBe('#0D1B3E');
  });

  it('is a real PNG rather than an empty placeholder', () => {
    const bytes = readFileSync(join(root, config.expo.icon ?? ''));
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.length).toBeGreaterThan(2000);
  });
});
