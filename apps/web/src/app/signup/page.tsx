'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { resetXetral, xetral } from '@/lib/session';
import { deviceFingerprint } from '@/lib/device';
import { useSubmit } from '@/lib/hooks';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { ThemeToggle } from '@/ui/theme-toggle';
import { AuthAside } from '@/ui/auth-aside';

/**
 * Opening an account.
 *
 * Email and a password, and nothing else — and then straight into the
 * product.
 *
 * Identity documents are a SEPARATE, reviewed step, asked for at the first
 * moment they are actually required rather than at the door. Folding a BVN
 * into this form would make a regulatory decision a side effect of choosing a
 * password, and would collect the most sensitive identifier a Nigerian
 * fintech holds from someone who has not yet proved they can receive mail at
 * the address they typed.
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
      // The WALLET, not the identity form.
      //
      // Sign-up used to land here on /kyc, so the first thing a new customer
      // saw was a demand for their full legal name, date of birth and BVN —
      // the most sensitive identifier a Nigerian fintech holds — before they
      // had seen one screen of the product or had any reason to trust us with
      // it. Identity is now asked for at the first moment it is actually
      // required: a USD card, crypto, gift cards, or a Nigerian account
      // number. Naira, transfers, airtime, data and bills all work on day one.
      router.push('/wallet');
      return undefined;
    });
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
        <h1>Create your account</h1>
        <p>Naira, dollars, and everything in between</p>
      </div>

      <form className="auth-card animate-in d2" onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email address</label>
          <input
            id="email"
            type="email"
            inputMode="email"
            placeholder="you@example.com"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            type="password"
            placeholder="At least 10 characters"
            value={password}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
            required
          />
          <p className="hint">Length beats punctuation — a phrase you remember is stronger than P@ssw0rd.</p>
        </div>

        <div className="field">
          <label htmlFor="confirm">Confirm password</label>
          <input
            id="confirm"
            type="password"
            placeholder="Type it again"
            value={confirm}
            autoComplete="new-password"
            onChange={(e) => setConfirm(e.target.value)}
            required
          />
        </div>

        {/* Above the button, not below it. Consent has to be readable BEFORE
            the account exists — a link under the control that creates one is a
            link nobody reads, and this is the only moment the notice is for.

            There is deliberately NO mailing-list checkbox here. Consent must
            be specific and freely given, and one act covering the terms and a
            mailing list is not consent to the mailing list — which the
            database enforces rather than trusting this page: a consent whose
            source is `registration` cannot be a marketing one. Opting in
            lives in settings, as its own decision. */}
        <p className="hint" style={{ margin: '0 0 14px' }}>
          By creating an account you agree to our{' '}
          <Link href="/legal/terms">terms</Link> and{' '}
          <Link href="/legal/privacy">privacy notice</Link>. We record which
          version you agreed to, and when.
        </p>

        <button type="submit" className="block" disabled={busy}>
          {busy ? 'Creating your account…' : 'Create account'}
        </button>

        {mismatch && (
          <p className="error"><Icon name="alert" size={16} /> Those two passwords are not the same.</p>
        )}
        {error !== undefined && (
          <p className="error"><Icon name="alert" size={16} /> {error}</p>
        )}
      </form>

      <p className="auth-foot animate-in d3">
        Already have an account? <Link href="/signin">Sign in</Link>
      </p>

      {/*
        Says what identity is for and WHEN, rather than implying it is a step
        between here and using the product. Most of Xetral works the moment
        this form is submitted.
      */}
      <div className="notice animate-in d3" style={{ marginTop: 20 }}>
        <span className="notice-icon"><Icon name="shield" size={19} /></span>
        <p>
          Your wallet, transfers, airtime, data and bills work straight away.
          A card, crypto or a Nigerian account number needs identity
          verification first — a legal requirement here, not a step we chose.
        </p>
      </div>
        </div>
      </div>
    </main>
  );
}
