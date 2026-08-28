'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { resetXetral, xetral } from '@/lib/session';
import { Logo } from '@/ui/logo';

const TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Customers' },
  { href: '/admin/kyc', label: 'Identity' },
  { href: '/admin/risk', label: 'Compliance' },
  { href: '/admin/suspense', label: 'Suspense' },
  { href: '/admin/tax', label: 'Tax' },
  { href: '/admin/consents', label: 'Consent' },
  { href: '/admin/data-requests', label: 'Data requests' },
  { href: '/admin/giftcards', label: 'Gift cards' },
  { href: '/admin/prices', label: 'Prices' },
  { href: '/admin/providers', label: 'Providers' },
  { href: '/admin/settings', label: 'Settings' },
  { href: '/admin/credentials', label: 'Provider keys' },
  { href: '/admin/staff', label: 'Staff' },
  { href: '/admin/audit', label: 'Audit' },
] as const;

export function AdminNav() {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  return (
    <>
      {/*
        `.appbar`, the same header the customer app uses. This was `.nav` with
        a `.spacer` — two class names that exist in no stylesheet, so the
        operations header had been rendering as bare inline text with the
        brand, the wallet link and the sign-out button touching each other.
        It looked deliberate enough in a diff to survive a migration.
      */}
      <nav className="appbar">
        <Link href="/admin" className="admin-brand" aria-label="Xetral operations">
          <Logo size={22} />
          <span className="admin-brand-suffix">operations</span>
        </Link>
        <span className="spacer" />
        <Link href="/wallet" className="btn ghost small">
          My wallet
        </Link>
        <button className="btn ghost small" onClick={signOut}>
          Sign out
        </button>
      </nav>

      <div className="tabs">
        {TABS.map((tab) => (
          <Link
            key={tab.href}
            href={tab.href}
            // Exact for the overview, prefix for the rest — otherwise
            // /admin/users/<id> would highlight nothing and an operator two
            // levels deep would lose track of where they are.
            className={
              (tab.href === '/admin' ? pathname === tab.href : pathname.startsWith(tab.href))
                ? 'active'
                : undefined
            }
          >
            {tab.label}
          </Link>
        ))}
      </div>
    </>
  );
}
