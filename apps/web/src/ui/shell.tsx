'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { Logo } from './logo';
import { Icon } from './icon';
import type { IconName } from './icon';
import { ThemeToggle } from './theme-toggle';

/**
 * One navigation, two shapes.
 *
 * A phone gets a bottom tab bar — four destinations, reachable by thumb. A
 * desktop gets a sidebar with the full list. Both render from the SAME array,
 * because a screen added to one and forgotten in the other is a screen half
 * the customers cannot reach.
 */
interface Dest {
  readonly href: string;
  readonly label: string;
  readonly icon: IconName;
  /** On the phone's tab bar, which is four items wide. */
  readonly tab?: boolean;
}

const DESTINATIONS: readonly Dest[] = [
  { href: '/wallet',    label: 'Home',     icon: 'home',     tab: true },
  { href: '/cards',     label: 'Cards',    icon: 'card',     tab: true },
  { href: '/activity',  label: 'Activity', icon: 'activity', tab: true },
  { href: '/transfer',  label: 'Send',     icon: 'send' },
  { href: '/add-money', label: 'Add money', icon: 'plus' },
  { href: '/bills',     label: 'Bills',    icon: 'receipt' },
  { href: '/fx',        label: 'Convert',  icon: 'swap' },
  { href: '/crypto',    label: 'Crypto',   icon: 'bitcoin' },
  { href: '/settings',  label: 'Account',  icon: 'user' },
];

const TABS: readonly Dest[] = [
  ...DESTINATIONS.filter((d) => d.tab === true),
  { href: '/more', label: 'More', icon: 'grid', tab: true },
];

export function Shell({
  title,
  children,
  back,
}: {
  readonly title?: string;
  readonly children: ReactNode;
  /** Show a back chevron instead of the logo — for a screen one level down. */
  readonly back?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [scrolled, setScrolled] = useState(false);

  /*
   * NOBODY SEES THE DASHBOARD BEFORE THEY ARE SIGNED IN, not even for a frame.
   *
   * WHAT WAS HAPPENING. Every screen rendered its chrome immediately — the tab
   * bar, the sidebar, the balance card's skeleton — and only THEN did a hook
   * call the API, get a 401, and push to /signin. So opening the site while
   * signed out flashed somebody else's dashboard shape at them before the sign
   * in page arrived. Nothing was leaked, because no data had loaded yet; what
   * it looked like was the product briefly letting them in and then changing
   * its mind, which for a bank is the worst possible first impression.
   *
   * THE GATE IS HERE RATHER THAN ON EACH PAGE for the reason the keyboard fix
   * is in the root layout: there are nine customer screens and a tenth is
   * always about to be added, and a gate somebody has to remember is a gate
   * that is missing on exactly one of them. `shell-gate.test.ts` fails the
   * build on a screen that renders customer chrome without it.
   *
   * IT ASKS THE TOKEN STORE, not the API. `read()` returns what is in memory
   * or exchanges the httpOnly cookie for an access token, behind the store's
   * own single-flight latch — so this costs at most the one refresh the first
   * data call was going to make anyway, and never a second one.
   */
  const [allowed, setAllowed] = useState<boolean | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const signedIn = await xetral().session.hasSession();
        if (!live) return;
        if (!signedIn) {
          setAllowed(false);
          router.replace('/signin');
          return;
        }
        setAllowed(true);
      } catch {
        if (!live) return;
        setAllowed(false);
        router.replace('/signin');
      }
    })();
    return () => {
      live = false;
    };
  }, [router]);

  // The appbar grows a hairline border once the page moves under it, so the
  // header separates from the content only when there is content behind it.
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  const isActive = (href: string) =>
    href === '/wallet' ? pathname === href : pathname.startsWith(href);

  /*
   * NOTHING AT ALL until the answer is in, and `replace` rather than `push`
   * so the back button does not walk a signed-out visitor into the screen
   * they were just sent away from.
   *
   * A spinner was the other option and is worse: it is one more thing a
   * stranger sees before the sign in page, and on a signed-in customer's
   * usual case — a warm cookie — the whole wait is a single already-cached
   * refresh. An empty frame that becomes the app is invisible; a spinner that
   * becomes the app is a flash of its own.
   */
  if (allowed !== true) return <div className="app-frame" aria-busy="true" />;

  return (
    <div className="app-frame">
      <nav className="sidenav" aria-label="Main">
        <div className="brand">
          <Link href="/wallet" aria-label="Xetral home">
            <Logo size={26} />
          </Link>
        </div>

        {DESTINATIONS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className={isActive(d.href) ? 'active' : undefined}
            aria-current={isActive(d.href) ? 'page' : undefined}
          >
            <Icon name={d.icon} size={19} />
            {d.label}
          </Link>
        ))}

        <span className="spacer" />
        <button type="button" className="ghost small" onClick={signOut}>
          <Icon name="logout" size={17} />
          Sign out
        </button>
      </nav>

      <div>
        <header className={scrolled ? 'appbar scrolled' : 'appbar'}>
          {back !== undefined ? (
            <>
              <Link href={back} className="icon-btn" aria-label="Back">
                <Icon name="chevronLeft" size={22} />
              </Link>
              <span className="appbar-title">{title}</span>
            </>
          ) : (
            <Link href="/wallet" className="appbar-brand" aria-label="Xetral home">
              <Logo size={26} />
            </Link>
          )}
          <span className="spacer" />
          <ThemeToggle />
          <Link href="/settings" className="icon-btn" aria-label="Notifications">
            <Icon name="bell" size={20} />
          </Link>
        </header>

        {/*
          EVERY SCREEN ARRIVES, not just the five that remembered the class.
          `animate-in` existed and was applied by hand, so ten of fifteen
          screens appeared instantly — which is the "no transitions" report.
          Keying the wrapper on the PATH restarts the animation on navigation;
          without the key React reuses the element and the entrance plays once
          per session.
        */}
        <main className="shell screen-in" key={pathname}>
          {children}
        </main>
      </div>

      <nav className="tabbar" aria-label="Primary">
        {TABS.map((d) => (
          <Link
            key={d.href}
            href={d.href}
            className={isActive(d.href) ? 'active' : undefined}
            aria-current={isActive(d.href) ? 'page' : undefined}
          >
            <Icon name={d.icon} size={22} />
            {d.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
