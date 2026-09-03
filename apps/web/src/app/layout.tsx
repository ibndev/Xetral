import './globals.css';
import localFont from 'next/font/local';
import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import { LogoGradient } from '@/ui/logo';

/*
 * The three families from the approved design, SELF-HOSTED.
 *
 * Not Google Fonts, for two reasons that both matter here. The app's CSP is
 * `font-src 'self'`, and widening it to a third party to fetch a typeface is
 * a poor trade on a page that shows somebody's balance. And a request to
 * fonts.gstatic.com tells that third party which of our customers loaded a
 * page and when — which is exactly the kind of quiet leak a bank should not
 * have.
 *
 * Both are VARIABLE fonts, so one file per family covers every weight the
 * product uses.
 */
/*
 * ONE FAMILY FOR EVERYTHING THAT IS NOT A FIGURE.
 *
 * This was Bricolage Grotesque for headings and Instrument Sans for body.
 * Bricolage is a DISPLAY face with deliberately idiosyncratic forms — that is
 * what it is for, and it is the wrong register on a screen showing somebody
 * their balance. Two grotesques doing similar jobs also read as an accident
 * rather than a pairing.
 *
 * Inter is the neutral one: designed for interface text at small sizes, which
 * is what a heading, a title and a label all are here. It carries the whole
 * product except the figures, which keep the mono so a column of amounts still
 * lines up.
 *
 * One variable file, 48KB, covering every weight from 100 to 900.
 */
const inter = localFont({
  src: './fonts/Inter.woff2',
  variable: '--font-inter',
  display: 'swap',
  weight: '100 900',
});

const spline = localFont({
  src: './fonts/SplineSansMono.woff2',
  variable: '--font-spline',
  display: 'swap',
  weight: '300 700',
});

export const metadata: Metadata = {
  title: 'Xetral',
  description: 'Multi-currency wallet — naira, dollars, and everything between',
  // No indexing. Every page behind sign-in is a customer's money, and the
  // sign-in page itself in a search index is a phishing target's template.
  robots: { index: false, follow: false },
  formatDetection: { telephone: false },
  appleWebApp: { capable: true, title: 'Xetral', statusBarStyle: 'default' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // NOT `maximumScale: 1`. Locking zoom is the usual way apps stop iOS
  // resizing on focus, and it also stops anyone who needs to enlarge an
  // account number from doing so. The inputs are 16px instead, which fixes
  // the zoom without taking the control away.
  viewportFit: 'cover',
  /*
   * THE BROWSER CHROME, AND IT MUST FOLLOW THE APP'S THEME RATHER THAN THE
   * OPERATING SYSTEM'S.
   *
   * These were keyed on `prefers-color-scheme`, which is the OS preference —
   * and this app's theme is `data-theme`, which the CUSTOMER chooses and
   * `localStorage` remembers. The two disagree the moment anybody uses the
   * toggle: on a light-OS phone somebody who picks the dark theme gets a
   * BLACK page under a WHITE status bar and a white gesture bar under it,
   * which is exactly the "separate section at the top that does not match"
   * this looked like.
   *
   * A media-keyed value cannot express "whatever the customer last chose", so
   * the media queries are gone and the tag is written by the same script that
   * sets `data-theme` before first paint, and updated by the toggle. One
   * value, one source, no state where they can disagree. The static value
   * here is only what a page renders with before that script runs.
   */
  themeColor: '#FFFFFF',
};

/*
 * Reads the stored theme BEFORE first paint.
 *
 * Without this the page renders light, then swaps to dark once React
 * hydrates — a white flash in a dark room, on the screen where somebody
 * checks their balance at night. It has to be inline and synchronous, which
 * is why it carries the CSP nonce.
 */
const THEME_BOOTSTRAP = `
(function(){try{
  var t = localStorage.getItem('xetral-theme');
  if (!t) t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  // The status bar and the gesture bar, painted with the same decision and in
  // the same tick — so there is never a frame where the chrome says one theme
  // and the page says the other. The colours are --bg from globals.css; they
  // are literals here because this runs before any stylesheet has loaded,
  // which is the whole reason it is inline.
  var m = document.querySelector('meta[name="theme-color"]');
  if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.appendChild(m); }
  m.setAttribute('content', t === 'dark' ? '#000000' : '#FFFFFF');
}catch(e){}})();
`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Touching headers() opts the tree into per-request rendering, which is what
  // lets Next stamp the CSP nonce onto its own inline scripts. Prerendered
  // HTML has nothing to stamp, and the page then renders and never hydrates.
  const nonce = (await headers()).get('x-nonce') ?? undefined;

  return (
    <html
      lang="en"
      data-theme="light"
      className={`${inter.variable} ${spline.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {/*
          The metal gradient the dark-theme mark is filled with, defined once
          for the whole document. Every `<LogoMark>` references it by id, so
          repeating the `<defs>` inside each mark — a dozen copies of the same
          id in one document — is not necessary.
        */}
        <LogoGradient />
        {children}
      </body>
    </html>
  );
}
