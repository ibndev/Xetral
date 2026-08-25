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
 * All three are VARIABLE fonts, so one file per family covers every weight
 * the product uses: 140KB for the whole type system.
 */
const bricolage = localFont({
  src: './fonts/BricolageGrotesque.woff2',
  variable: '--font-bricolage',
  display: 'swap',
  weight: '200 800',
});

const instrument = localFont({
  src: './fonts/InstrumentSans.woff2',
  variable: '--font-instrument',
  display: 'swap',
  weight: '400 700',
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
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#FFFFFF' },
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
  ],
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
      className={`${bricolage.variable} ${instrument.variable} ${spline.variable}`}
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
