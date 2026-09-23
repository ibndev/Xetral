'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { useAdmin } from '@/lib/hooks';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
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
      // "I did not do this". Its own `dispute_reviewer` role, and beside the
      // other queues about a PERSON rather than under Money: raising one
      // posts nothing, so until a reviewer decides there is no money in it.
      { href: '/admin/disputes', label: 'Disputes', icon: 'alert' },
    ],
  },
  {
    title: 'Money',
    items: [
      { href: '/admin/suspense', label: 'Suspense', icon: 'wallet' },
      // Money that left a wallet and never arrived. Beside Suspense, and the
      // mirror of it: suspense is money we hold and cannot attribute, this is
      // money we took and did not deliver.
      { href: '/admin/recovery', label: 'Recovery', icon: 'swap' },
      { href: '/admin/tax', label: 'Tax', icon: 'receipt' },
      // What the platform has earned. Beside Tax, and distinct from it: Tax
      // is what is owed onward, this is what was kept.
      { href: '/admin/earnings', label: 'Earnings', icon: 'trend' },
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
      // Whether anything is actually being sent. The failure it answers is
      // silent by construction: with the worker interval unset the outbox
      // fills, the API keeps saying "check your email", and nothing errors.
      { href: '/admin/notifications', label: 'Notifications', icon: 'bell' },
      // Announcements to customer handsets. Beside Notifications and not
      // inside it: that screen answers "is email being sent", this one is
      // where somebody WRITES something, and its own silent failure is a
      // different unset interval.
      { href: '/admin/broadcasts', label: 'Announcements', icon: 'bell' },
      { href: '/admin/audit', label: 'Audit', icon: 'clock' },
      { href: '/admin/readiness', label: 'Readiness', icon: 'check' },
      // Beside Readiness, and distinct from it: Readiness asks whether a
      // value is SET, and every reason the naira rail refuses survives that
      // question. This one ASKS the provider.
      { href: '/admin/diagnostics', label: 'Diagnostics', icon: 'alert' },
      // What is currently failing. The overview has linked here since
      // `QUEUE_SCREENS` was written and the page did not exist, so the link
      // answered 404 — which reads as a queue somebody could be working.
      { href: '/admin/errors', label: 'Errors', icon: 'alert' },
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

/**
 * THE SCREEN'S NAME, DERIVED FROM THE SAME LIST THE SIDEBAR IS BUILT FROM.
 *
 * The admin comp puts an `h1` in the top bar — `800 20px`, left of the
 * controls — and on a wide screen that bar was EMPTY here, because the brand
 * is hidden there and everything else is right-aligned. So the only thing
 * naming the screen was whatever heading the page happened to write inside
 * its own first panel, which is why several of them opened with a panel
 * wrapping a heading wrapping the content: a container drawn to hold a title
 * the chrome should have been holding.
 *
 * Derived rather than passed in, for the reason `route-coverage.test.ts`
 * refuses a hand-written controller list: twenty-six pages each declaring
 * their own title is twenty-six chances for one to disagree with the sidebar
 * entry an operator clicked to get there.
 *
 * The LONGEST matching prefix wins, so `/admin/risk/cases` is "Compliance"
 * rather than whichever entry happened to be first.
 */
function screenName(pathname: string): string {
  let best = '';
  let label = 'Operations';
  for (const group of GROUPS) {
    for (const item of group.items) {
      if (!isActive(pathname, item.href)) continue;
      if (item.href.length < best.length) continue;
      best = item.href;
      label = item.label;
    }
  }
  return label;
}

/**
 * A SCREEN THAT NAMES ITSELF SOMETHING MORE SPECIFIC THAN ITS SIDEBAR ENTRY.
 *
 * Most do not: "Customers", "Providers", "Tax" are the entry an operator
 * clicked. Some are one of SEVERAL screens under one entry — `/admin/risk` is
 * the compliance QUEUE and `/admin/risk/cases` is the compliance CASES, both
 * under "Compliance" — and there the sidebar label is the right thing in the
 * sidebar and the wrong thing over the table.
 *
 * Rendered where the heading used to be, rather than passed down from a
 * layout: the name belongs beside the screen it names, and a page that stops
 * rendering this falls back to its sidebar entry rather than to nothing.
 *
 * `useLayoutEffect` rather than `useEffect`, so the bar is never painted with
 * the previous screen's name — which on a fast navigation is exactly the kind
 * of half-second wrongness nobody reports and everybody sees.
 */
const TitleContext = createContext<((name: string | undefined) => void) | undefined>(undefined);

/**
 * WHAT SITS BESIDE THE TITLE. The comp puts the Overview's "All ledgers
 * balanced" pill in the top bar, next to the screen's name — the one place an
 * operator's eye lands first. A screen declares it the way it declares its
 * title, so the bar stays one component.
 */
const StatusContext = createContext<((node: ReactNode) => void) | undefined>(undefined);

export function AdminStatus({ children }: { readonly children: ReactNode }) {
  const set = useContext(StatusContext);
  useLayoutEffect(() => {
    set?.(children);
    return () => set?.(undefined);
  }, [set, children]);
  return null;
}

/** "Sat 20 Sep · 03:34 UTC" — UTC, because an operations team is not in one
 *  timezone and every timestamp the database records is UTC. */
function useUtcClock(): string {
  const [now, setNow] = useState<string>('');
  useEffect(() => {
    const tick = () => {
      const d = new Date();
      const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
      const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
      // en-GB spells September "Sept"; the comp, and every other date on
      // this surface, says "Sep".
      setNow(`${day.replace(',', '').replace('Sept', 'Sep')} · ${time} UTC`);
    };
    tick();
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * WHICH QUEUES A SIDEBAR ENTRY OWNS. The comp puts a count beside Identity,
 * Compliance and Suspense — the entries an operator opens because something is
 * waiting there. Read from the same `admin_work_queue` the overview lists, so
 * the badge and the "Needs a person" row cannot disagree.
 */
const QUEUE_ENTRY: Readonly<Record<string, string>> = {
  kyc: '/admin/kyc',
  bvn_collisions: '/admin/kyc',
  risk_signals: '/admin/risk',
  risk_cases: '/admin/risk',
  suspense: '/admin/suspense',
  giftcard_review: '/admin/giftcards',
  data_requests: '/admin/data-requests',
  disputes: '/admin/disputes',
  bank_payouts_stuck: '/admin/recovery',
  errors: '/admin/errors',
};
/** A count here is a regulatory clock or money in limbo, so it is red. */
const URGENT_ENTRY = new Set(['/admin/risk', '/admin/recovery']);

interface Badge { readonly count: number; readonly urgent: boolean }

function useQueueBadges(): ReadonlyMap<string, Badge> {
  const admin = useAdmin();
  const [badges, setBadges] = useState<ReadonlyMap<string, Badge>>(new Map());
  useEffect(() => {
    let live = true;
    const load = () =>
      admin
        .overview()
        .then((o) => {
          if (!live) return;
          const next = new Map<string, Badge>();
          for (const q of o.queues) {
            const href = QUEUE_ENTRY[q.queue];
            const n = Number(q.waiting);
            if (href === undefined || !(n > 0)) continue;
            next.set(href, { count: (next.get(href)?.count ?? 0) + n, urgent: URGENT_ENTRY.has(href) });
          }
          setBadges(next);
        })
        // A badge is a courtesy. A staff member without the overview's role
        // still gets a working sidebar, just an unannotated one.
        .catch(() => undefined);
    void load();
    const id = setInterval(load, 60_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [admin]);
  return badges;
}

/** Who is signed in, as the comp's footer chip draws it: initials, a name, a role. */
function useStaffChip(): { initials: string; name: string; role: string } | undefined {
  const admin = useAdmin();
  const [chip, setChip] = useState<{ initials: string; name: string; role: string }>();
  useEffect(() => {
    let live = true;
    Promise.all([xetral().client.currentSession(), admin.myRoles().catch(() => [] as readonly string[])])
      .then(([s, roles]) => {
        if (!live) return;
        const name = s.full_name ?? s.first_name ?? 'Staff';
        const parts = name.trim().split(/\s+/);
        const initials = ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1]?.[0] ?? '' : '')).toUpperCase();
        const short = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]?.[0] ?? ''}.` : name;
        const top = roles.includes('admin') ? 'admin' : roles[0];
        const role = top === undefined ? 'Staff' : top.replace(/_/g, ' ').replace(/^./, (c: string) => c.toUpperCase());
        setChip({ initials: initials || 'X', name: short, role });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [admin]);
  return chip;
}

export function AdminTitle({ children }: { readonly children: string }) {
  const set = useContext(TitleContext);
  useLayoutEffect(() => {
    set?.(children);
    return () => set?.(undefined);
  }, [set, children]);
  return null;
}

export function AdminShell({ children }: { readonly children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  /* What the SCREEN calls itself, when that is not its sidebar entry. */
  const [declared, setDeclared] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<ReactNode>(undefined);
  const clock = useUtcClock();
  const badges = useQueueBadges();
  const chip = useStaffChip();

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

        {/*
          THE GROUPS SCROLL AND NOTHING ELSE DOES. The brand above and the
          footer below stay put, so Sign out is reachable without scrolling a
          list of twenty-five destinations first — and, more to the point, the
          list can no longer be silently CLIPPED. It was: the whole sidebar was
          one scrolling column at viewport height, so on a laptop the last
          seven entries simply were not there, with nothing on screen saying a
          scroll would reveal them.
        */}
        <div className="admin-side-scroll">
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
                  {badges.get(item.href) !== undefined && (
                    <span className={badges.get(item.href)?.urgent ? 'side-badge danger' : 'side-badge'}>
                      {badges.get(item.href)!.count > 99 ? '99+' : badges.get(item.href)!.count}
                    </span>
                  )}
                </Link>
              ))}
            </div>
          ))}
        </div>

        <div className="admin-side-foot">
          <Link href="/wallet">
            <Icon name="wallet" size={17} />
            My wallet
          </Link>
          <button type="button" className="ghost small" onClick={signOut}>
            <Icon name="logout" size={17} />
            Sign out
          </button>
          {chip !== undefined && (
            <div className="admin-chip">
              <span className="avatar" aria-hidden="true">{chip.initials}</span>
              <span>
                <strong>{chip.name}</strong>
                <small>{chip.role}</small>
              </span>
            </div>
          )}
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

      <TitleContext.Provider value={setDeclared}>
      <StatusContext.Provider value={setStatus}>
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
          {/* THE BRAND IS IN THE SIDEBAR, which on a wide screen is always
              showing and on a handset is one tap away. What the bar carries
              is the screen's name — the only thing on it that differs between
              twenty-six screens. */}
          {/* The comp's `.top h1` — `800 20px`, and the one place this screen
              is named. Hidden where the compact brand is showing, because two
              of them do not fit on a handset. */}
          <h1 className="admin-title">{declared ?? screenName(pathname)}</h1>
          {status}
          <span className="spacer" />
          <span className="admin-clock">{clock}</span>
          {/*
            THE SAME TOGGLE THE CUSTOMER APP USES, not a second one.

            The dashboard inherited whatever `data-theme` the customer app had
            last been left on — and since nothing here could change it, an
            operator who had never opened the customer app in light mode had a
            dark dashboard with no way out. It is one preference for one
            person across both surfaces, so it is one control: the toggle
            writes the same attribute and the same stored choice, and a second
            implementation here would be a second thing to keep in step with
            the pre-paint bootstrap.
          */}
          <ThemeToggle />
          {/* THE COMP'S BELL, and where it goes is the queue of messages the
              platform owed somebody — the surface an operator checks when a
              customer says an email never came. My wallet and Sign out are in
              the sidebar, where the comp puts them; they were ALSO here on a
              laptop, two copies of two links. */}
          <Link href="/admin/notifications" className="icon-btn" aria-label="Notifications">
            <Icon name="bell" size={19} />
          </Link>
        </header>

        <main className="shell wide">{children}</main>
      </div>
      </StatusContext.Provider>
      </TitleContext.Provider>
    </div>
  );
}
