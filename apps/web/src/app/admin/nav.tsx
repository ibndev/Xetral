'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { resetXetral, xetral } from '@/lib/session';

const TABS = [
  { href: '/admin', label: 'Overview' },
  { href: '/admin/users', label: 'Customers' },
  { href: '/admin/kyc', label: 'Identity' },
  { href: '/admin/suspense', label: 'Suspense' },
  { href: '/admin/giftcards', label: 'Gift cards' },
  { href: '/admin/settings', label: 'Settings' },
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
      <nav className="nav">
        <strong>Xetral operations</strong>
        <span className="spacer" />
        <Link href="/wallet">My wallet</Link>
        <button className="ghost small" onClick={signOut}>
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
