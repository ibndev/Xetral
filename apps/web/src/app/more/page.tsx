'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Shell } from '@/ui/shell';
import { Icon } from '@/ui/icon';
import type { IconName } from '@/ui/icon';
import { resetXetral, xetral } from '@/lib/session';
import { useLoad, useXetral } from '@/lib/hooks';

/**
 * The fourth tab: everything that does not earn a place in the other three.
 *
 * Grouped, because a flat list of eleven links is a list nobody reads. The
 * groups are the customer's own mental model — what I can do with my money,
 * who I am, and what happens if something is wrong.
 */
const GROUPS: readonly {
  readonly title: string;
  readonly items: readonly { href: string; label: string; sub: string; icon: IconName }[];
}[] = [
  {
    title: 'Money',
    items: [
      { href: '/transfer',  label: 'Send money',   sub: 'To another Xetral account', icon: 'send' },
      { href: '/add-money', label: 'Add money',    sub: 'How money reaches your wallet', icon: 'bank' },
      { href: '/fx',        label: 'Convert',      sub: 'Between your currencies, or send abroad', icon: 'swap' },
      { href: '/crypto',    label: 'Crypto',       sub: 'USDT and Bitcoin, on chain', icon: 'bitcoin' },
    ],
  },
  {
    title: 'Services',
    items: [
      { href: '/bills',  label: 'Airtime & bills', sub: 'Data, electricity, TV', icon: 'receipt' },
      { href: '/bills',  label: 'eSIM',            sub: 'Travel data plans', icon: 'sim' },
      { href: '/cards',  label: 'Virtual cards',   sub: 'Spend online in dollars', icon: 'card' },
    ],
  },
  {
    title: 'Account',
    items: [
      { href: '/settings', label: 'Security',  sub: 'Transaction PIN and sessions', icon: 'shield' },
      { href: '/kyc',      label: 'Identity',  sub: 'Verification status', icon: 'user' },
    ],
  },
  {
    // Reachable without signing in too, at /legal/privacy and /legal/terms.
    // Linked from here as well because a customer looking for "what do they
    // keep about me?" looks inside the app, not on a marketing page.
    title: 'Legal',
    items: [
      { href: '/legal/privacy', label: 'Privacy', sub: 'What we keep, and for how long', icon: 'shield' },
      { href: '/legal/terms',   label: 'Terms',   sub: 'How disputes and limits work', icon: 'receipt' },
    ],
  },
];

export default function More() {
  const router = useRouter();
  const client = useXetral();
  const kyc = useLoad(() => client.kyc(), [client]);

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  const verified = kyc.data?.status === 'approved';

  return (
    <Shell>
      <h1 className="animate-in">More</h1>

      {/* Verification is the gate on cards and account numbers, so it is the
          first thing here rather than buried under Account. */}
      {!kyc.loading && !verified && (
        <Link href="/kyc" className="notice warn animate-in d1">
          <span className="notice-icon"><Icon name="shield" size={19} /></span>
          <span>
            <strong>Verify your identity</strong>
            <p className="hint" style={{ margin: '2px 0 0' }}>
              Required before you can be issued an account number or a card.
            </p>
          </span>
          <Icon name="chevronRight" size={18} />
        </Link>
      )}

      {GROUPS.map((g, i) => (
        <section className={`card animate-in d${Math.min(i + 1, 4)}`} key={g.title}>
          <div className="card-head"><h2>{g.title}</h2></div>
          <div className="list">
            {g.items.map((item) => (
              <Link className="list-row" key={item.label} href={item.href}>
                <span className="row-icon"><Icon name={item.icon} size={19} /></span>
                <span className="row-main">
                  <span className="row-title">{item.label}</span>
                  <span className="row-sub">{item.sub}</span>
                </span>
                <Icon name="chevronRight" size={18} />
              </Link>
            ))}
          </div>
        </section>
      ))}

      <div className="actions animate-in d4">
        <button type="button" className="ghost block" onClick={signOut}>
          <Icon name="logout" size={18} /> Sign out
        </button>
      </div>
    </Shell>
  );
}
