import Link from 'next/link';
import type { ReactNode } from 'react';
import { Logo } from './logo';
import { ThemeToggle } from './theme-toggle';

/**
 * The frame the legal pages use, and NOT `Shell`.
 *
 * `Shell` carries the signed-in navigation and a sign-out control. A privacy
 * notice behind a session is a privacy notice nobody can read before deciding
 * whether to open an account — which is the one moment it exists for. These
 * pages are reachable by anybody, and are the only pages in the app that are.
 *
 * A SERVER COMPONENT: no `'use client'`, no hooks, no session. That is not an
 * optimisation. It means the page renders identically whether or not the API
 * is reachable, so the document a regulator or an app store reviewer asks for
 * cannot be taken down by an outage.
 */
export function LegalPage({
  title,
  updated,
  children,
}: {
  title: string;
  updated: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div className="legal-shell">
      <header className="legal-head">
        <Link href="/" aria-label="Xetral"><Logo /></Link>
        <ThemeToggle />
      </header>

      <main className="legal-body">
        <h1>{title}</h1>
        <p className="hint">Last updated {updated}</p>
        {children}

        <nav className="legal-foot">
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
          <Link href="/signin">Sign in</Link>
        </nav>
      </main>
    </div>
  );
}
