'use client';

import { use, useEffect, useState } from 'react';
import { Logo } from '@/ui/logo';
import { Icon } from '@/ui/icon';
import { Select } from '@/ui/select';
import { CurrencyMark } from '@/ui/currency-mark';
import { formatAmount, PAY_METHOD_LABEL, payMethodsFor, readRequest, REQUEST_NOTE_MAX, symbolFor } from '@xetral/client';
import type { PayMethod } from '@xetral/client';
import { LegalLine } from '@/ui/legal-line';

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
  const [picked, setPicked] = useState<PayMethod | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [paid, setPaid] = useState(false);
  /*
   * WHAT THE PAYER SEES ON COMING BACK FROM THE PROVIDER. It was only `paid`,
   * so a return whose settle said "pending" — the webhook not yet landed, the
   * ordinary case — or "failed" showed the EMPTY CHECKOUT again with no word
   * at all: a payer who had just paid was looking at a form inviting them to
   * pay again.
   */
  const [returned, setReturned] = useState<'checking' | 'pending' | 'failed' | undefined>();
  /* A lookup that could not be ANSWERED is not a link that does not exist. */
  const [lookupFailed, setLookupFailed] = useState(false);
  const [lookupNonce, setLookupNonce] = useState(0);

  /*
   * A REQUEST'S PREFILL, off the query string — the amount, currency and
   * reason the customer typed on their Request screen. Validated by
   * `readRequest` and still only a suggestion: the payer sees it in the box
   * and can change it, and the server credits what the provider says was
   * PAID, never what a link claimed.
   */
  const [asked, setAsked] = useState<{ amount?: string; currency?: string; note?: string }>({});
  /*
   * THE AMOUNT AS IT WAS ASKED OR TYPED, AND IN WHICH CURRENCY.
   *
   * Changing the currency used to change only the symbol: a request for
   * ₦5,000 paid in cedis asked the payer for ₵5,000 — about a hundred times
   * the request — and the rail then refused it, which read as "check the
   * amount". The box now shows what the base amount is in the chosen
   * currency, always converted FROM this base rather than from whatever the
   * box held last, so switching back and forth cannot compound rounding.
   * Typing in the box makes what was typed the new base.
   */
  const [base, setBase] = useState<{ amount: string; currency: string } | undefined>();
  const [converting, setConverting] = useState(false);
  const [noRate, setNoRate] = useState(false);
  useEffect(() => {
    const request = readRequest(new URLSearchParams(window.location.search));
    setAsked(request);
    if (request.amount !== undefined) {
      setAmount(request.amount);
      if (request.currency !== undefined) setBase({ amount: request.amount, currency: request.currency });
    }
    if (request.currency !== undefined) setCurrency(request.currency);
    if (request.note !== undefined) setNote(request.note);
  }, []);

  useEffect(() => {
    let live = true;
    setLookupFailed(false);
    void (async () => {
      try {
        const response = await fetch(`/api/x/v1/pay/${encodeURIComponent(slug)}`);
        /*
         * ONLY A 404 MEANS "NOT ACTIVE". A dropped connection, a 5xx or a 429
         * all read "This link is not active" — a working link reported dead
         * to the stranger it was sent to, who then tells the sender it is
         * broken.
         */
        if (response.status === 404) {
          if (live) setMissing(true);
          return;
        }
        if (!response.ok) {
          if (live) setLookupFailed(true);
          return;
        }
        const body = (await response.json()) as Payee;
        if (live) setPayee(body);
      } catch {
        if (live) setLookupFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [slug, lookupNonce]);

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
    setReturned('checking');
    void (async () => {
      try {
        const response = await fetch('/api/x/v1/pay/settle', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reference }),
        });
        const body = (await response.json()) as { status?: string };
        if (body.status === 'credited' || body.status === 'replayed') {
          setPaid(true);
          setReturned(undefined);
        } else if (body.status === 'failed') {
          setReturned('failed');
        } else {
          setReturned('pending');
        }
      } catch {
        // NOT KNOWING IS "PENDING", never "failed". The webhook is the path
        // that must work; a failure here must not tell the payer their money
        // went nowhere when it may have arrived.
        setReturned('pending');
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
  /* A requested currency this link cannot collect falls back to the payee's
     own rather than opening a checkout that refuses on submit. */
  const chosen =
    currency !== '' && (options.length === 0 || options.includes(currency))
      ? currency
      : (payee?.currency ?? '');
  /* A request link without a currency was asked in the payee's own. */
  const from = base ?? (asked.amount !== undefined && payee !== undefined
    ? { amount: asked.amount, currency: payee.currency }
    : undefined);

  useEffect(() => {
    if (from === undefined || chosen === '' || from.amount === '') return;
    if (from.currency === chosen) {
      setAmount(from.amount);
      setNoRate(false);
      return;
    }
    let live = true;
    setConverting(true);
    void (async () => {
      try {
        const query = new URLSearchParams({ amount: from.amount, from: from.currency, to: chosen });
        const response = await fetch(
          `/api/x/v1/pay/${encodeURIComponent(slug)}/equivalent?${query.toString()}`,
        );
        const body = (await response.json()) as { amount?: string };
        if (!live) return;
        if (response.ok && body.amount !== undefined) {
          setAmount(body.amount.replace(/\.0+$/, ''));
          setNoRate(false);
        } else {
          // No published rate between the two: an empty box and a sentence,
          // never the old figure under the new symbol.
          setAmount('');
          setNoRate(true);
        }
      } catch {
        if (live) {
          setAmount('');
          setNoRate(true);
        }
      } finally {
        if (live) setConverting(false);
      }
    })();
    return () => {
      live = false;
    };
    // `from` is rebuilt every render; its two fields are what matter.
  }, [chosen, from?.amount, from?.currency, slug]);

  /*
   * HOW THEY PAY, chosen HERE. A payer who chose cedis was sent straight to
   * the provider's page, which opens on a card form — mobile money sat behind
   * a menu most payers in Accra never find, and the link read as card-only.
   * The first method for the currency is the default, and the provider's page
   * opens on whichever was picked.
   */
  const methods = chosen === '' ? [] : payMethodsFor(chosen);
  const method: PayMethod | undefined =
    picked !== undefined && methods.includes(picked) ? picked : methods[0];
  const initials = (payee?.name ?? '')
    .split(/\s+/)
    .filter((w) => w !== '')
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

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
          ...(method === undefined ? {} : { method }),
        }),
      });
      const body = (await response.json()) as {
        authorization_url?: string;
        error?: string;
      };
      if (!response.ok || body.authorization_url === undefined) {
        setError(chargeRefusal(body.error, chosen));
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
              {/* NO RECEIPT IS PROMISED. Nothing here sends the payer one —
                  there is no template for it — so promising one was a claim
                  about somebody else's inbox. */}
              <p className="lead">Thank you. {payee?.name ?? 'They'} have been paid.</p>
            </div>
          ) : returned === 'checking' || returned === 'pending' ? (
            <div className="auth-card animate-in d2" aria-live="polite">
              <h1>{returned === 'checking' ? 'Confirming your payment…' : 'Payment being confirmed'}</h1>
              <p className="lead">
                {returned === 'checking'
                  ? 'This takes a moment.'
                  : `We are waiting for the bank to confirm it. You do not need to pay again — ${payee?.name ?? 'they'} will be credited as soon as it is confirmed.`}
              </p>
            </div>
          ) : lookupFailed ? (
            <div className="auth-card animate-in d2">
              <h1>We could not load this payment page</h1>
              <p className="lead">Check your connection and try again.</p>
              <button type="button" className="block" onClick={() => setLookupNonce((n) => n + 1)}>
                Try again
              </button>
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
              {/*
                THE REQUEST CARD — the same card the customer filled in on
                their Request screen, so asking and paying read as one thing.
                The figure is the whole of what is being asked, so it leads,
                centred and large; everything a payer must type sits under it.
              */}
              {/* A DECLINED OR CANCELLED PAYMENT IS SAID — it came back to the
                  same empty form with nothing on it. */}
              {returned === 'failed' && (
                <p className="error animate-in" role="alert">
                  That payment did not go through, and nothing was taken. You can try again.
                </p>
              )}
              <form className="req-card animate-in d1" onSubmit={pay}>
                <div className="req-payee">
                  <span className="req-avatar" aria-hidden>{initials === '' ? '·' : initials}</span>
                  <span className="req-eyebrow">
                    {asked.amount !== undefined ? `${payee?.name ?? '…'} requests` : `Pay ${payee?.name ?? '…'}`}
                  </span>
                </div>

                <label className="req-amount">
                  <span className="req-symbol" aria-hidden>{symbolFor(chosen)}</span>
                  <input
                    id="amount"
                    // `text` with a decimal keypad, not `number`: money is a
                    // string on this platform from end to end, and a number
                    // input hands back a value the browser has already parsed.
                    type="text"
                    inputMode="decimal"
                    placeholder="0"
                    aria-label={`Amount (${chosen})`}
                    value={amount}
                    style={{ width: `${Math.max(1, amount.length || 1) + 0.4}ch` }}
                    onChange={(e) => {
                      const typed = e.target.value.replace(/[^0-9.]/g, '');
                      setAmount(typed);
                      setNoRate(false);
                      setBase(typed === '' ? undefined : { amount: typed, currency: chosen });
                    }}
                    required
                  />
                </label>

                {options.length > 1 && (
                  <div className="req-currency">
                    <Select
                      labelledBy="pay-currency-label"
                      value={chosen}
                      onChange={setCurrency}
                      renderMark={(code) => <CurrencyMark currency={code} size={18} />}
                      options={options.map((code) => ({ value: code, label: code }))}
                    />
                    <span id="pay-currency-label" hidden>Currency</span>
                  </div>
                )}

                {from !== undefined && from.currency !== chosen && chosen !== '' && (
                  <p className="req-converted" aria-live="polite">
                    {converting
                      ? 'Converting…'
                      : noRate
                        ? `We cannot convert ${from.currency} to ${chosen} here. Enter the amount in ${chosen}.`
                        : `${formatAmount(from.amount, from.currency)} requested, at today's rate`}
                  </p>
                )}

                {asked.note !== undefined ? (
                  /* WHAT IT IS FOR, as the requester wrote it. Shown, not an
                     input: it is their words, and it cannot change the amount. */
                  <p className="req-note">
                    <span className="req-note-label">What it&apos;s for</span>
                    {asked.note}
                  </p>
                ) : (
                  <input
                    className="req-for"
                    type="text"
                    maxLength={REQUEST_NOTE_MAX}
                    placeholder="What's it for? (optional)"
                    aria-label="What it is for"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                )}

                {methods.length > 1 && (
                  <div className="req-method">
                    <span className="req-method-label" id="pay-method-label">Pay with</span>
                    <div className="segmented wide" role="radiogroup" aria-labelledby="pay-method-label">
                      {methods.map((m) => (
                        <button
                          key={m}
                          type="button"
                          role="radio"
                          aria-checked={method === m}
                          className={method === m ? 'active' : undefined}
                          onClick={() => setPicked(m)}
                        >
                          {PAY_METHOD_LABEL[m]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="req-fields">
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
                </div>

                <button
                  type="submit"
                  className="block req-action"
                  disabled={busy || payee === undefined || chosen === ''}
                >
                  {busy ? 'Opening…' : 'Continue to pay'}
                </button>

                {error !== undefined && (
                  <p className="error">
                    <Icon name="alert" size={16} /> {error}
                  </p>
                )}

                {/*
                  NO FOOTER PARAGRAPH. It said the money reaches their Xetral
                  wallet and carried the cardholder-data statement; the owner
                  asked for it off this page. The statement stays where it is
                  a commitment — the privacy notice — and stays TRUE because
                  of how this page is built: the card is typed on the
                  processor's hosted page and never reaches this page, the
                  API or a database here.
                */}
              </form>
            </>
          )}

          <LegalLine className="animate-in d2" />
        </div>
      </div>
    </main>
  );
}

/**
 * WHAT A REFUSED CHARGE SAYS, code by code.
 *
 * Every code this page did not name fell through to "That did not work.
 * Check the amount and try again." — so a rail that refused, a currency with
 * no key behind it and a mistyped email address all told the payer the
 * AMOUNT was wrong, which for most of them it was not. The API's codes are
 * specific; this keeps them specific.
 */
function chargeRefusal(code: string | undefined, currency: string): string {
  switch (code) {
    case 'invalid_amount':
      return 'Enter an amount to pay.';
    case 'invalid_request':
      return 'Check your email address and the amount, then try again.';
    case 'currency_not_supported':
      return `${currency} cannot be paid to this link. Choose another currency.`;
    case 'payment_method_not_supported':
      return `${currency} cannot be paid that way. Choose another way to pay.`;
    case 'checkout_refused':
      return `Our payment partner declined this ${currency} payment. Try another way to pay, a smaller amount, or another currency.`;
    case 'checkout_not_configured':
      return `${currency} payments are not available right now. Choose another currency.`;
    case 'checkout_unavailable':
      return 'Payments are unavailable right now. Try again shortly.';
    case 'link_not_found':
      return 'This link is not active. Ask whoever sent it for a new one.';
    case 'too_many_requests':
      return 'Too many attempts. Wait a minute and try again.';
    default:
      return 'We could not start this payment. Try again in a moment.';
  }
}
