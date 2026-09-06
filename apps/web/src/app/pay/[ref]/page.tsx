'use client';

import { use, useEffect, useState } from 'react';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';

/**
 * THE PUBLIC CHECKOUT. No account, no sign-in, no app.
 *
 * WHAT THIS REPLACES. `/pay/<x>` redirected to the SEND screen, which is
 * behind a sign-in — so the link a customer was told to share "to accept
 * payment globally" was payable only by somebody who already had a Xetral
 * account with money in it. For everybody else it was a sign-in page. That is
 * a shortcut for existing customers, and not the thing the screen promised.
 *
 * The payer types an amount and an email address, and the provider renders
 * the methods they actually have — mobile money, a bank transfer, a card. NO
 * CARD DETAIL EVER TOUCHES THIS PAGE: the only thing it does with money is
 * hand the payer to the provider's own hosted page, which is what keeps this
 * out of scope for everything a form that took a card number would drag in.
 *
 * WHICH PROVIDER IS DECIDED BY THE CURRENCY AND NOT BY THIS PAGE. Naira goes
 * to Paystack; cedis and shillings go to Flutterwave, because a Paystack
 * account registered in Nigeria settles in naira and asked for cedis will
 * either refuse or convert at a rate nobody chose. The page never names a
 * provider for that reason — the routing is data, in `provider_routes`, and
 * an operator can move a corridor without a release.
 *
 * IT IS ITS OWN LAYOUT, deliberately — no `Shell`, no tab bar, no theme
 * toggle. Every one of those is furniture for somebody signed in, and the
 * person reading this page is a stranger who has been sent a link.
 *
 * A LINK THAT NEVER EXISTED AND ONE WHOSE OWNER CLOSED THEIR ACCOUNT GET THE
 * SAME ANSWER, from the API. Distinguishing them would say which slugs are
 * real, on a page anybody can open.
 */
export default function PayLink({ params }: { params: Promise<{ ref: string }> }) {
  const { ref } = use(params);
  return <Checkout slug={ref} />;
}

interface Payee {
  readonly name: string;
  /** The payee's own, which the picker opens on. */
  readonly currency: string;
  /**
   * WHAT THIS DEPLOYMENT CAN ACTUALLY COLLECT, from the API.
   *
   * Not a list in this file. A hardcoded one would be a claim about which
   * rails exist, made in a screen, and it would go stale the first time an
   * operator opened a corridor — offering a payer a currency that then fails
   * after they have typed an amount.
   */
  readonly currencies?: readonly string[];
}

function Checkout({ slug }: { readonly slug: string }) {
  const [payee, setPayee] = useState<Payee | undefined>();
  const [missing, setMissing] = useState(false);
  const [amount, setAmount] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  /*
   * EMPTY UNTIL THE PAYEE LOADS, then resolved rather than stored.
   *
   * Seeding this with a currency would capture whatever was there on the
   * first render — which is nothing — and a hardcoded 'NGN' is the exact bug
   * the Send screen had: a Ghanaian shown naira on a screen about their own
   * money. `chosen` below falls back to the payee's own currency, so the
   * commonest payment needs no decision at all.
   */
  const [currency, setCurrency] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [paid, setPaid] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const response = await fetch(`/api/x/v1/pay/${encodeURIComponent(slug)}`);
        if (!response.ok) {
          if (live) setMissing(true);
          return;
        }
        const body = (await response.json()) as Payee;
        if (live) setPayee(body);
      } catch {
        if (live) setMissing(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [slug]);

  /*
   * THE PAYER COMING BACK FROM PAYSTACK.
   *
   * Their return is a plain navigation with `?paid=<reference>` on it, and it
   * is NOT evidence of anything — anybody can type that URL. What makes it
   * safe is that the API verifies the reference WITH PAYSTACK before crediting
   * anything, which is the same check the webhook makes. What it buys is that
   * the payee sees their money in the second it takes the payer to come back
   * rather than whenever the webhook lands.
   */
  useEffect(() => {
    const reference = new URLSearchParams(window.location.search).get('paid');
    if (reference === null) return;
    void (async () => {
      try {
        const response = await fetch('/api/x/v1/pay/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference }),
        });
        const body = (await response.json()) as { status?: string };
        if (body.status === 'credited' || body.status === 'replayed') setPaid(true);
      } catch {
        // Silent. The webhook is the path that must work; this one only makes
        // it quicker, and a failure here must not tell the payer their money
        // went nowhere when it did.
      }
    })();
  }, []);

  /*
   * THE PAYEE'S OWN CURRENCY FIRST, and whatever else this deployment
   * collects after it. `payee.currencies` is absent on an API that predates
   * the route table, and the fallback is the single currency that page always
   * offered — so an older API loses the picker rather than the checkout.
   */
  const options = payee === undefined ? [] : (payee.currencies ?? [payee.currency]);
  const chosen = currency === '' ? (payee?.currency ?? '') : currency;

  async function pay(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/x/v1/pay/${encodeURIComponent(slug)}/charge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amount: amount.trim(),
          email: email.trim(),
          ...(name.trim() === '' ? {} : { name: name.trim() }),
          currency: chosen,
          ...(note.trim() === '' ? {} : { note: note.trim() }),
        }),
      });
      const body = (await response.json()) as {
        authorization_url?: string;
        error?: string;
      };
      if (!response.ok || body.authorization_url === undefined) {
        setError(
          body.error === 'invalid_amount'
            ? 'Enter an amount to pay.'
            : body.error === 'currency_not_supported'
              ? `${chosen} cannot be paid to this link. Choose another currency.`
              : body.error === 'checkout_unavailable'
                ? 'Payments are unavailable right now. Try again shortly.'
                : 'That did not work. Check the amount and try again.',
        );
        return;
      }
      // Paystack's own page. It renders the methods this payer has, which is
      // the whole reason the money never passes through here.
      window.location.href = body.authorization_url;
    } catch {
      setError('We could not reach the payment page. Check your connection.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-main">
        <div className="auth-inner">
          <div className="auth-brand animate-in">
            <Logo size={32} />
          </div>

          {paid ? (
            <div className="auth-card animate-in d2">
              <h1>Payment received</h1>
              <p className="lead">
                Thank you. {payee?.name ?? 'They'} have been paid, and a receipt is on its way to
                your email address.
              </p>
            </div>
          ) : missing ? (
            /* The same words for a link that never existed and one whose owner
               has closed their account — the API answers identically, and a
               page that did not would say which links are real. */
            <div className="auth-card animate-in d2">
              <h1>This link is not active</h1>
              <p className="lead">
                Check the link you were sent, or ask whoever sent it for a new one.
              </p>
            </div>
          ) : (
            <>
              <div className="auth-head animate-in d1">
                <h1>Pay {payee?.name ?? '…'}</h1>
                <p>They receive it in their Xetral wallet</p>
              </div>

              <form className="auth-card animate-in d2" onSubmit={pay}>
                {options.length > 1 && (
                  <div className="field">
                    <label htmlFor="pay-currency" id="pay-currency-label">
                      Currency
                    </label>
                    <Select
                      labelledBy="pay-currency-label"
                      value={chosen}
                      onChange={setCurrency}
                      renderMark={(code) => <CurrencyMark currency={code} size={18} />}
                      options={options.map((code) => ({ value: code, label: code }))}
                    />
                  </div>
                )}

                <div className="field">
                  {/* THE LABEL FOLLOWS THE CHOICE. It was the payee's currency,
                      fixed, so a payer who picked another one was typing into a
                      box that still said the old code — and the amount is the
                      one field where reading the wrong unit costs money. */}
                  <label htmlFor="amount">Amount ({chosen})</label>
                  <input
                    id="amount"
                    // `text` with a decimal keypad, not `number`: money is a
                    // string on this platform from end to end, and a number
                    // input hands back a value the browser has already parsed.
                    type="text"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                </div>

                <div className="field">
                  <label htmlFor="email">Your email</label>
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
                  <p className="hint">Your receipt goes here. It is not shared with anyone else.</p>
                </div>

                <div className="field">
                  <label htmlFor="name">Your name (optional)</label>
                  <input
                    id="name"
                    type="text"
                    placeholder="So they know who paid"
                    value={name}
                    autoComplete="name"
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>

                <div className="field">
                  <label htmlFor="note">What&apos;s this for? (optional)</label>
                  <textarea
                    id="note"
                    rows={2}
                    maxLength={140}
                    placeholder="Rent, invoice 24, lunch…"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <p className="hint">
                    They see this beside the payment. It cannot change the amount.
                  </p>
                </div>

                <button
                  type="submit"
                  className="block"
                  disabled={busy || payee === undefined || chosen === ''}
                >
                  {busy ? 'Opening…' : 'Continue to pay'}
                </button>

                {error !== undefined && (
                  <p className="error">
                    <Icon name="alert" size={16} /> {error}
                  </p>
                )}

                {/* NO PROVIDER IS NAMED HERE. It used to say "Paystack's
                    secure page", which is wrong the moment a cedi payment
                    goes to Flutterwave — and a payer does not need to know
                    which processor we route to, only that we never see their
                    card. */}
                <p className="hint">
                  You pay on a secure page. Xetral never sees your card details.
                </p>
              </form>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
