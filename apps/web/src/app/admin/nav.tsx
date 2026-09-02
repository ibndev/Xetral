'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import type { IconName } from '@/ui/icon';

/**
 * The operations navigation, as a SIDEBAR.
 *
 * It was a horizontal strip of sixteen tabs under the header, which is a shape
 * that works for four and stops working somewhere around eight: on a laptop
 * the last entries wrapped or scrolled out of sight, so Provider keys, Staff,
 * Audit and Readiness were the four an operator had to go looking for — and
 * they are the four somebody reaches for during an incident.
 *
 * Vertical also gives the list room to be GROUPED, which a strip cannot be.
 * The groups are presentation only: every destination that was in the strip is
 * still here, and `nav-coverage.test.ts` fails the build if a page under
 * /admin becomes unreachable, or an entry points at a page that does not
 * exist. Removing one entry from this list was tried, and it went red.
 */
interface Destination {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
}

interface Group {
  /** Absent on the first group — an eyebrow over a single Overview link is a
   *  label saying "navigation" above some navigation. */
  readonly title?: string;
  readonly items: readonly Destination[];
}

export const GROUPS: readonly Group[] = [
  {
    items: [{ href: '/admin', label: 'Overview', icon: 'grid' }],
  },
  {
    title: 'People',
    items: [
      { href: '/admin/users', label: 'Customers', icon: 'users' },
      { href: '/admin/kyc', label: 'Identity', icon: 'shield' },
      { href: '/admin/risk', label: 'Compliance', icon: 'alert' },
      { href: '/admin/consents', label: 'Consent', icon: 'check' },
      { href: '/admin/data-requests', label: 'Data requests', icon: 'file' },
    ],
  },
  {
    title: 'Money',
    items: [
      { href: '/admin/suspense', label: 'Suspense', icon: 'wallet' },
      { href: '/admin/tax', label: 'Tax', icon: 'receipt' },
      { href: '/admin/prices', label: 'Prices', icon: 'trend' },
      { href: '/admin/giftcards', label: 'Gift cards', icon: 'gift' },
    ],
  },
  {
    title: 'Platform',
    items: [
      { href: '/admin/providers', label: 'Providers', icon: 'globe' },
      { href: '/admin/credentials', label: 'Provider keys', icon: 'lock' },
      // Where the platform operates. Beside the other things an operator
      // configures rather than works through.
      { href: '/admin/countries', label: 'Countries', icon: 'globe' },
      { href: '/admin/settings', label: 'Settings', icon: 'settings' },
      { href: '/admin/staff', label: 'Staff', icon: 'user' },
      // Reachable from the sidebar deliberately, and it is the one operations
      // screen that works before the second factor exists. Hiding it behind
      // the thing it configures is the loop it was written to break.
      { href: '/admin/security', label: 'Your authenticator', icon: 'shield' },
      { href: '/admin/audit', label: 'Audit', icon: 'clock' },
      { href: '/admin/readiness', label: 'Readiness', icon: 'check' },
    ],
  },
];

/**
 * Exact for the overview, prefix for the rest — otherwise /admin/users/<id>
 * would highlight nothing and an operator two levels deep loses track of where
 * they are. /admin/risk/cases sits under /admin/risk, which is correct.
 */
function isActive(pathname: string, href: string): boolean {
  return href === '/admin' ? pathname === href : pathname.startsWith(href);
}

export function AdminShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Navigating closes the drawer. Without this a tap on a narrow screen
  // renders the new page behind a sheet that is still covering it, which reads
  // as the link having done nothing.
  useEffect(() => setOpen(false), [pathname]);

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  return (
    <div className={open ? 'admin-frame drawer-open' : 'admin-frame'}>
      {/*
        One list, rendered once, in both layouts. A separate copy for small
        screens is how an entry ends up in one and not the other — the mistake
        this codebase already made with the API's `controllers` array.
      */}
      <nav className="admin-side" aria-label="Operations">
        <div className="admin-side-brand">
          <Link href="/admin" className="admin-brand" aria-label="Xetral operations">
            <Logo size={22} />
            <span className="admin-brand-suffix">operations</span>
          </Link>
        </div>

        {GROUPS.map((group, index) => (
          <div className="admin-side-group" key={group.title ?? index}>
            {group.title !== undefined && <span className="eyebrow">{group.title}</span>}
            {group.items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={isActive(pathname, item.href) ? 'active' : undefined}
                aria-current={isActive(pathname, item.href) ? 'page' : undefined}
              >
                <Icon name={item.icon} size={17} />
                {item.label}
              </Link>
            ))}
          </div>
        ))}

        <span className="spacer" />

        <div className="admin-side-group">
          <Link href="/wallet">
            <Icon name="wallet" size={17} />
            My wallet
          </Link>
          <button type="button" className="ghost small" onClick={signOut}>
            <Icon name="logout" size={17} />
            Sign out
          </button>
        </div>
      </nav>

      {/* Closes the drawer on a tap outside it. Rendered only while open, so
          it cannot swallow clicks on the desktop layout. */}
      {open && (
        <button
          type="button"
          className="admin-scrim"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        />
      )}

      <div className="admin-main">
        <header className="appbar">
          <button
            type="button"
            className="icon-btn admin-menu"
            aria-label="Navigation"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
          >
            <Icon name={open ? 'close' : 'menu'} size={22} />
          </button>
          <Link
            href="/admin"
            className="admin-brand admin-brand-compact"
            aria-label="Xetral operations"
          >
            <Logo size={22} />
            <span className="admin-brand-suffix">operations</span>
          </Link>
          <span className="spacer" />
          <Link href="/wallet" className="btn ghost small admin-wide-only">
            My wallet
          </Link>
          <button type="button" className="ghost small admin-wide-only" onClick={signOut}>
            Sign out
          </button>
        </header>

        <main className="shell wide">{children}</main>
      </div>
    </div>
  );
}
