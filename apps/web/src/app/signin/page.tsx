'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { messageFor } from '@/lib/errors';

/** A stable-ish per-browser device fingerprint. Not a security control — the
 *  server binds sessions to it, so it only needs to be consistent. */
function deviceFingerprint(): string {
  const key = 'xetral_device';
  let value = window.localStorage.getItem(key);
  if (value === null) {
    value = crypto.randomUUID();
    window.localStorage.setItem(key, value);
  }
  return value;
}

export default function SignIn() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);

    try {
      resetXetral();
      const { session } = xetral();
      await session.signIn(identifier, password, {
        fingerprint: deviceFingerprint(),
        platform: 'web',
      });
      router.push('/wallet');
    } catch (cause) {
      setError(messageFor(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <div className="nav">
        <strong>Xetral</strong>
      </div>

      <form className="panel" onSubmit={submit}>
        <h1>Sign in</h1>
        <h2>Multi-currency wallet</h2>

        <label>
          Email
          <input
            type="email"
            value={identifier}
            autoComplete="username"
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error !== undefined && <p className="error">{error}</p>}
      </form>
    </main>
  );
}
