'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { deviceFingerprint } from '@/lib/device';
import { useSubmit } from '@/lib/hooks';

/**
 * Opening an account.
 *
 * Email and a password, and nothing else. Identity documents are a SEPARATE,
 * reviewed step — folding a BVN into this form would make a regulatory
 * decision a side effect of choosing a password, and would collect the most
 * sensitive identifier a Nigerian fintech holds from someone who has not yet
 * proved they can receive mail at the address they typed.
 */
export default function SignUp() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, run } = useSubmit();
  const [mismatch, setMismatch] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();

    // Checked here rather than on the server, because the server never sees
    // the second field — a confirmation is about what the customer typed, not
    // about what we store.
    if (password !== confirm) {
      setMismatch(true);
      return;
    }
    setMismatch(false);

    await run(async () => {
      resetXetral();
      const { session } = xetral();
      await session.register({
        email,
        password,
        device: { fingerprint: deviceFingerprint(), platform: 'web' },
      });
      router.push('/kyc');
      return undefined;
    });
  }

  return (
    <main className="shell">
      <div className="nav">
        <strong>Xetral</strong>
      </div>

      <form className="panel" onSubmit={submit}>
        <h1>Open an account</h1>
        <h2>Naira, dollars, and everything in between</h2>

        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <span className="hint">At least 12 characters. Length beats punctuation.</span>
        </label>

        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>

        {mismatch && <p className="error">Those two passwords are not the same.</p>}
        {error !== undefined && <p className="error">{error}</p>}

        <p className="hint">
          Already have an account? <Link href="/signin">Sign in</Link>
        </p>
      </form>

      <div className="notice">
        <p>
          You will be asked to verify your identity before you can be issued a
          bank account number or a card. That is a legal requirement in Nigeria,
          not a formality we could skip.
        </p>
      </div>
    </main>
  );
}
