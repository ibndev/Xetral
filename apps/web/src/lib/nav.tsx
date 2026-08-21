'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { resetXetral, xetral } from '@/lib/session';

/**
 * The customer's navigation.
 *
 * One list rather than a hand-written set of links per page: a screen added
 * without a way to reach it is a screen nobody uses, and a link that survives
 * a screen being removed is a 404 a customer finds before we do.
 */
const LINKS = [
  { href: '/wallet', label: 'Wallet' },
  { href: '/transfer', label: 'Send' },
  { href: '/add-money', label: 'Add money' },
  { href: '/bills', label: 'Bills' },
  { href: '/cards', label: 'Cards' },
  { href: '/fx', label: 'Convert' },
  { href: '/crypto', label: 'Crypto' },
] as const;

export function Nav() {
  const router = useRouter();
  const pathname = usePathname();

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  return (
    <nav className="nav">
      <strong>Xetral</strong>
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={pathname === link.href ? 'active' : undefined}
          // Read by a screen reader as the current page rather than as one more
          // link that looks the same as the others.
          aria-current={pathname === link.href ? 'page' : undefined}
        >
          {link.label}
        </Link>
      ))}
      <span className="spacer" />
      <Link href="/settings">Account</Link>
      <button className="ghost small" onClick={signOut}>
        Sign out
      </button>
    </nav>
  );
}
