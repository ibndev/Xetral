import type { MetadataRoute } from 'next';

/**
 * The installed-app identity: the mark ALONE, which is the one place a logo
 * appears with nothing beside it to say what it is.
 *
 * `display: 'standalone'` matters more here than it looks. Installed from the
 * home screen, the app runs without a URL bar — and a customer who cannot see
 * the address is a customer who cannot tell this page from a copy of it. The
 * scope is therefore pinned to the origin root, so a link out of it opens in
 * the real browser, chrome and all, rather than inside our frame.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Xetral',
    short_name: 'Xetral',
    description: 'Multi-currency wallet — naira, dollars, and everything between',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#F2F4F8',
    theme_color: '#0D1B3E',
    icons: [
      // Two FILES, not one file declared twice. A maskable icon is cropped to
      // the launcher's shape — a circle of 80% of the width on most Android
      // launchers — and the chevron tips sit at the corners of the mark's
      // bounding box, 222px from centre against a 204.8px safe radius at the
      // tab icon's scale. Serving the same artwork for both purposes shaves
      // both tips off on every round-icon launcher.
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
