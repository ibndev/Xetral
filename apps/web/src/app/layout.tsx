import './globals.css';
import { headers } from 'next/headers';
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'Xetral',
  description: 'Multi-currency wallet',
  // No indexing. Every page behind sign-in is a customer's money, and the
  // sign-in page itself in a search index is a phishing target's template.
  robots: { index: false, follow: false },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // NOT `maximumScale: 1`. Locking zoom is the usual way apps stop iOS
  // resizing on focus, and it also stops anyone who needs to enlarge an
  // account number from doing so. The form inputs are 16px instead, which
  // fixes the zoom without taking the control away.
  themeColor: '#0b0f14',
};

/**
 * `async` and reading headers, deliberately.
 *
 * Touching `headers()` opts the whole tree into per-request rendering, and
 * that is what makes the Content-Security-Policy nonce work: Next stamps the
 * nonce onto its own inline bootstrap scripts as it renders them, and there is
 * nothing to stamp if the HTML was generated at build time.
 *
 * Prerendering these pages and serving them under a nonce CSP produced a page
 * that renders and never hydrates — every button inert, and a screenshot that
 * looks perfect. There is nothing to prerender here in any case: every screen
 * is behind a sign-in and shows live money.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await headers();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
