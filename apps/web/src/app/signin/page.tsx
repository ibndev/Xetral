'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { deviceFingerprint } from '@/lib/device';
import { messageFor } from '@/lib/errors';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
import { AuthAside } from '@/ui/auth-aside';

export default function SignIn() {
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      resetXetral();
      await xetral().session.signIn(identifier, password, {
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
    <main className="auth">
      <AuthAside />

      <div className="auth-main">
        <div className="auth-toggle">
          <ThemeToggle />
        </div>

        <div className="auth-inner">
      <div className="auth-brand animate-in">
        <Logo size={32} />
      </div>

      <div className="auth-head animate-in d1">
        <h1>Welcome back</h1>
        <p>Sign in to your Xetral account</p>
      </div>

      <form className="auth-card animate-in d2" onSubmit={submit}>
        <div className="field">
          <label htmlFor="identifier">Email address</label>
          <input
            id="identifier"
            type="email"
            inputMode="email"
            placeholder="you@example.com"
            value={identifier}
            autoComplete="username"
            onChange={(e) => setIdentifier(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <div className="input-affix">
            <input
              id="password"
              type={show ? 'text' : 'password'}
              placeholder="••••••••••"
              value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button
              type="button"
              className="affix"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide password' : 'Show password'}
            >
              <Icon name={show ? 'eyeOff' : 'eye'} size={19} />
            </button>
          </div>
        </div>

        {/* ABOVE the button, not under it. A customer who cannot get in is
            looking at the password field, and a link below the control they
            have already failed to use is a link they scroll past. */}
        <p className="auth-forgot">
          <Link href="/forgot">Forgot your password?</Link>
        </p>

        <button type="submit" className="block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>

        {error !== undefined && (
          <p className="error"><Icon name="alert" size={16} /> {error}</p>
        )}
      </form>

      <p className="auth-foot animate-in d3">
        New to Xetral? <Link href="/signup">Create an account</Link>
      </p>

      <p className="auth-trust animate-in d3">
        <Icon name="lock" size={14} /> Your session is encrypted end to end
      </p>
        </div>
      </div>
    </main>
  );
}
