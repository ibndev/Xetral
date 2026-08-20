'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { resetXetral, xetral } from '@/lib/session';

export function Nav() {
  const router = useRouter();

  async function signOut() {
    await xetral().session.signOut();
    resetXetral();
    router.push('/signin');
  }

  return (
    <div className="nav">
      <strong>Xetral</strong>
      <Link href="/wallet">Wallet</Link>
      <Link href="/transfer">Send</Link>
      <Link href="/add-money">Add money</Link>
      <span className="spacer" />
      <button className="ghost" onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
